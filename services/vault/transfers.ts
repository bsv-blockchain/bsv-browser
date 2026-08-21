/**
 * Vault transfers — internal movements between the `default` change basket
 * and the `admin vault` basket, over the R1-K1 half-multisig script.
 *
 * Deposit: an ordinary wallet payment whose output is R1-K1-locked — an R1
 * (P-256/YubiKey) branch salted per-output, and a K1 (secp256k1) branch keyed
 * to a public BIP32 child of the vault xpub. Funded and change-managed by the
 * toolbox from the default basket. No YubiKey required to deposit.
 *
 * Withdraw: spend EVERY vault output through the R1 branch (there is no input
 * cap — see spendVaultOutputs). The toolbox returns the withdrawn value (minus
 * fee, minus any re-vaulted remainder) as change into the default basket —
 * that change IS the internal transfer. Vault inputs carry a custom
 * unlockingScriptLength the toolbox cannot itself produce, so we build each
 * unlocking script ourselves via the R1K1 template and finalize with
 * signAction.
 *
 * Sweep: recovery path via the K1 branch, signed locally from the vault HD
 * node (derived from the main mnemonic + vault passphrase) — no YubiKey.
 * Always empties the ENTIRE vault and never re-vaults.
 *
 * The `admin vault` basket name is admin-reserved: WalletPermissionsManager
 * blocks any non-admin originator (web pages) from listing, inserting into, or
 * relinquishing it. All calls here use the admin originator.
 *
 * SECURITY: no key material passes through this module for the R1 path —
 * signing happens on the YubiKey via VaultR1Signer; we only ever hold hashes,
 * public keys, salts, and signatures. The K1 sweep path does handle a private
 * key (the vault HD node), but never logs it.
 */
import { HD, Hash, P2PKH, PublicKey, Transaction, TransactionSignature, UnlockingScript, Utils } from '@bsv/sdk'
import { R1K1Wallet } from '@bsv/templates'
import { vaultStore } from './vaultStore'
import { VaultError } from './types'
import { backupAttestation } from './backupAttestation'
import { VaultR1Signer } from './ceremony'
import { noteVaultProgress, requestVaultSigner } from './ceremonyHost'
import { randomBytes } from './random'
import { bip32KeyID, indexFromKeyID, depositPkhFromXpub, depositPrivKey, vaultXpub } from './vaultDerivation'
import {
  R1K1_LOCK_LEN,
  R1K1_R1_UNLOCK_LEN,
  R1K1_K1_UNLOCK_LEN,
  buildVaultLockingScript,
  decodeVaultInstructions,
  encodeVaultInstructions,
  VaultInstructions
} from './r1k1'

export const VAULT_BASKET = 'admin vault'

/**
 * The intermediate basket a deposit splits its funding into. See depositToVault:
 * tx1 carves out exactly (deposit + tx2 fee) here; tx2 spends it as its ONLY
 * input into the vault output, with no change. A stranded output in this basket
 * (tx1 landed, tx2 failed) is reused by the next deposit of the same amount.
 */
export const VAULT_STAGING_BASKET = 'vault staging'

/** BRC-42 protocol the staging output's P2PKH key is derived under. */
const STAGING_PROTOCOL: [number, string] = [2, 'vault deposit staging']

/** P2PKH unlock, worst case: push(73-byte DER+hashtype sig) + push(33-byte key). */
const STAGING_UNLOCK_LEN = 108

/**
 * Must equal the storage feeModel WalletContext configures
 * (`feeModel: { model: 'sat/kb', value: 100 }`). The split math relies on it:
 * tx1's staging output is sized to deposit + fee so that tx2's feeExcess is
 * exactly zero and generateChange adds no change output.
 */
export const VAULT_SATS_PER_KB = 100

/** Serialized tx size, byte-identical to wallet-toolbox's transactionSize. */
function txSizeBytes(inputScriptLens: number[], outputScriptLens: number[]): number {
  const varUint = (n: number) => (n <= 0xfc ? 1 : n <= 0xffff ? 3 : n <= 0xffffffff ? 5 : 9)
  return (
    4 +
    varUint(inputScriptLens.length) +
    inputScriptLens.reduce((a, e) => a + 40 + varUint(e) + e, 0) +
    varUint(outputScriptLens.length) +
    outputScriptLens.reduce((a, e) => a + 8 + varUint(e) + e, 0) +
    4
  )
}

/** The exact fee the vault-creating tx2 needs under the wallet's fee model. */
export function vaultDepositTx2Fee(satsPerKb: number = VAULT_SATS_PER_KB): number {
  return Math.ceil((txSizeBytes([STAGING_UNLOCK_LEN], [R1K1_LOCK_LEN]) / 1000) * satsPerKb)
}

interface StagingInstructions {
  v: 1
  type: 'staging'
  keyID: string
}

function encodeStagingInstructions(i: StagingInstructions): string {
  return JSON.stringify(i)
}

function decodeStagingInstructions(s: string | undefined): StagingInstructions | null {
  if (!s) return null
  try {
    const o = JSON.parse(s)
    return o && o.v === 1 && o.type === 'staging' && typeof o.keyID === 'string' ? o : null
  } catch {
    return null
  }
}

/**
 * Storage-backed lookup of the transactions reserving a set of outpoints.
 *
 * Injected rather than imported so this module stays testable without a database
 * — and optional, so a caller that has no storage handle keeps the original
 * paged-scan heal. See findSpendingReferences in StorageExpoSQLite.
 */
export type SpendingReferenceLookup = (
  outpoints: string[]
) => Promise<{ reference: string; status: string }[]>

/**
 * Injected dependencies for a vault transfer.
 *
 * Injected rather than imported so the module stays testable without native
 * modules or a database, and optional so a caller that has neither still works.
 */
export interface VaultTransferOptions {
  /** Storage-backed reservation heal. See SpendingReferenceLookup. */
  findSpendingReferences?: SpendingReferenceLookup
  /**
   * The app's single online signal.
   *
   * Vault transfers are refused while offline. The offline queue exists for
   * small casual default-basket payments: processOfflineActions holds every held
   * request's full rawTx and inputBEEF in one in-memory Beef, and a held row has
   * no attempt cap, no expiry and no local terminal state that releases its
   * reservation — so a vault transaction landing there would freeze real money
   * with no way out. Refusing up front is also what makes "no vault row ever
   * reaches the offline drain" a testable invariant.
   */
  isOnline?: () => Promise<boolean>
  /**
   * Storage-backed release of staging outputs stranded by a definitively
   * invalid tx2. Returns how many outputs were made spendable again.
   *
   * When tx2 fails at broadcast, the toolbox first restores its inputs
   * (releaseInputsAllocatedToFailedTransaction) but then re-strands them:
   * markStaleInputsAsSpent asks the indexers whether the staging outpoint is
   * a UTXO seconds after tx1 was broadcast, and indexer lag answers "no" —
   * so a coin that IS on chain gets spendable=0 with a 'failed' spentBy that
   * abortAction refuses to touch ('failed' is in its unAbortable list). The
   * release runs before a deposit splits anew, so the stranded coin is reused
   * instead of carving a third one. See releaseVaultStagingStrandedByInvalidTx
   * in StorageExpoSQLite for the exact (deliberately narrow) predicate.
   */
  releaseStrandedStaging?: () => Promise<number>
}

export interface VaultSpendResult {
  txid: string
  /**
   * Vault outputs left untouched because of the input cap.
   *
   * Non-zero means the withdrawal was partial: the caller should tell the user
   * that funds remain and that repeating the withdrawal will move them (each
   * pass also consolidates, so the next one needs fewer inputs).
   */
  remainingInputs: number
}

/**
 * Economic-dust floor for a vault output — a hard minimum, not a caution.
 *
 * An R1 spend pays the ~960 KB script twice — once to create the output, once
 * to push the preimage that spends it — at the wallet's fee rate. An output
 * below this is not worth what it costs to move, so deposits below it are
 * rejected outright and a sub-floor withdrawal remainder is folded into the
 * withdrawal rather than re-vaulted.
 */
export const VAULT_DEPOSIT_MIN = 200_000

/**
 * Vault inputs per withdrawal.
 *
 * This used to be "spend EVERY output — there is no input cap", which is the
 * single largest OOM risk in the app and is not fixed by storing scripts
 * compressed. Each input contributes ~1.83 MB of inputBEEF (a measured 146 MB
 * Hermes array at 20 inputs), and Extended Format re-embeds every input's SOURCE
 * locking script, so the leanest possible wire payload is ~188 MB at 20 inputs
 * however the bytes are stored at rest.
 *
 * 6 sits inside all three independent constraints: measured memory (~110-150 MB
 * at 6 versus ~350 MB at 20), Arcade's 10 MB MaxTxSizePolicy (~10 inputs) and
 * its 32 MiB single-transaction endpoint (~18 inputs). The hard ceiling is the
 * value no future tuning may exceed without redoing that arithmetic.
 *
 * Consolidation is automatic: a capped withdrawal re-vaults its remainder as one
 * output, so repeated withdrawals converge on a single vault UTXO.
 */
export const VAULT_MAX_INPUTS = 6
export const VAULT_HARD_MAX_INPUTS = 8

/** The subset of the wallet interface transfers depends on (injected so the
 * whole module is testable without the toolbox). */
export interface VaultWallet {
  createAction(args: unknown, originator: string): Promise<CreateActionResult>
  signAction(args: unknown, originator: string): Promise<{ txid?: string; tx?: number[] }>
  listOutputs(args: unknown, originator: string): Promise<ListOutputsResult>
  getPublicKey(args: unknown, originator: string): Promise<{ publicKey: string }>
  /** Signs the staging input of a deposit's tx2 (BRC-42 key, counterparty 'self'). */
  createSignature(args: unknown, originator: string): Promise<{ signature: number[] }>
  abortAction(args: unknown, originator: string): Promise<unknown>
  listActions?(args: unknown, originator: string): Promise<{ actions: VaultActionRow[] }>
}

/** The fields of a listActions row the reservation heal needs. `inputs` arrives
 * only when the call asked for `includeInputs`, and a transaction that never
 * reached signing has no `txid` — which is exactly the case the outpoint match
 * exists to cover. */
export interface VaultActionRow {
  txid?: string
  status: string
  reference?: string
  inputs?: { sourceOutpoint?: string }[]
}

interface CreateActionResult {
  txid?: string
  tx?: number[]
  signableTransaction?: { tx: number[]; reference: string }
}
interface ListOutputsResult {
  outputs: {
    outpoint: string
    satoshis: number
    customInstructions?: string
  }[]
  /** Present when `include: 'entire transactions'` was requested — the AtomicBEEF
   * (well, the multi-tx BEEF) covering every listed output's source transaction.
   * Forwarded verbatim as createAction's inputBEEF; see spendVaultOutputs. */
  BEEF?: number[]
}

// ── helpers ───────────────────────────────────────────────────────────────

/** Reserve the next deposit slot: a fresh BIP32 index for the K1 leg and a
 * fresh salt for the R1 leg. Used by both depositToVault and the withdraw
 * path's re-vaulted-remainder output. */
async function nextDepositTarget(): Promise<{
  instructions: VaultInstructions
  lockingScript: string
}> {
  const meta = await vaultStore.getMeta()
  if (!meta) throw new VaultError('not-enrolled', 'Vault is not set up')
  const index = await vaultStore.takeNextIndex()
  if (index == null) throw new VaultError('not-enrolled', 'Vault is not set up')

  // Fresh per output: one YubiKey key serves the whole vault, so a reused salt
  // would give every output the same R1 commitment and link them all.
  const salt = Utils.toHex(randomBytes(32))
  const k1PublicKeyHash = Utils.toArray(depositPkhFromXpub(meta.xpub, index), 'hex')
  const script = await buildVaultLockingScript({
    r1PublicKey: meta.r1PublicKey,
    salt,
    k1PublicKeyHash
  })
  return {
    instructions: {
      v: 2,
      type: 'R1K1',
      keyID: bip32KeyID(index),
      salt,
      r1PublicKey: meta.r1PublicKey,
      slot: meta.slot
    },
    lockingScript: script.toHex()
  }
}

/** True for the toolbox's WERR_REVIEW_ACTIONS — an undelayed action that needs
 * review, in our case a double-spend against a vault UTXO still reserved by a
 * stuck prior attempt whose reserving transaction DOES have a txid. */
function isReviewActionsError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false
  const anyE = e as { code?: unknown; message?: string; reviewActionResults?: unknown }
  return anyE.code === 5 || 'reviewActionResults' in anyE || /require review/i.test(anyE.message ?? '')
}

/** The txids the review error blames for the double-spend — the transactions
 * still reserving our vault UTXO. */
function competingTxids(e: unknown): string[] {
  const rr = (e as { reviewActionResults?: unknown }).reviewActionResults
  if (!Array.isArray(rr)) return []
  const out: string[] = []
  for (const r of rr) {
    const c = (r as { competingTxs?: unknown }).competingTxs
    if (Array.isArray(c)) out.push(...(c as string[]))
  }
  return out
}

/** One outpoint spelling. The toolbox writes `txid:vout` into error text and
 * `txid.vout` into outpoint fields; both mean the same coin. */
const sameOutpoint = (outpoint: string): string => outpoint.trim().toLowerCase().replace(':', '.')

/**
 * The outpoints named by the toolbox's OTHER reservation refusal:
 *
 *   The inputs[0] parameter must be spendable output. output <txid>:0 appears
 *   to have been spent (spendable=false). [WERR_INVALID_PARAMETER]
 *
 * This is the shape a failed withdrawal actually leaves behind. createAction
 * reports a double-spend review only when the output's `spentBy` transaction
 * has a txid; an attempt that died before signing never got one, so the same
 * check falls through to this plain WERR_INVALID_PARAMETER instead (see
 * storage/methods/createAction.js). It names the OUTPOINT and no txid, which
 * is why the review-actions heal below cannot see it.
 *
 * Matched on the message shape, deliberately narrowly: WERR_INVALID_PARAMETER
 * covers most argument mistakes, and mistaking one for a stuck reservation
 * would abort transactions over an unrelated bug.
 */
function unspendableInputOutpoints(e: unknown): string[] {
  if (!e || typeof e !== 'object') return []
  const msg = (e as { message?: string }).message ?? ''
  if (!/must be spendable output/i.test(msg)) return []
  return [...msg.matchAll(/\b([0-9a-fA-F]{64})[.:](\d+)\b/g)].map(m => sameOutpoint(`${m[1]}.${m[2]}`))
}

/** A locally-held reservation is never in a terminal on-chain state; these are
 * the states abortAction accepts, plus 'failed' which also holds inputs. */
const ABORTABLE = new Set(['unsigned', 'nosend', 'nonfinal', 'failed'])

/**
 * Page ALL actions and abort every one `matches` picks out, which resets its
 * inputs' `spentBy` and frees the coin. Best-effort — returns how many were
 * aborted.
 *
 * Pages everything rather than filtering by label: the transaction reserving a
 * vault UTXO may carry no vault label of its own.
 */
async function abortActions(
  w: VaultWallet,
  adminOriginator: string,
  matches: (a: VaultActionRow) => boolean,
  opts: { includeInputs?: boolean; stopAfter: number }
): Promise<number> {
  if (!w.listActions) return 0
  let scanned = 0
  const seen: string[] = []
  // By reference, so the same orphan is never aborted twice — a second
  // abortAction on it would be rejected, and counting it again would report a
  // heal that did not happen.
  const aborted = new Set<string>()
  try {
    let offset = 0
    for (let page = 0; page < 25 && aborted.size < opts.stopAfter; page++) {
      const res = await w.listActions(
        { labels: [], limit: 200, offset, ...(opts.includeInputs ? { includeInputs: true } : {}) },
        adminOriginator
      )
      const actions = res.actions ?? []
      if (actions.length === 0) break
      scanned += actions.length
      for (const a of actions) {
        if (!matches(a)) continue
        seen.push(`${a.status}${a.reference ? '' : '/no-ref'}`)
        if (a.reference && ABORTABLE.has(a.status) && !aborted.has(a.reference)) {
          aborted.add(a.reference)
          await w.abortAction({ reference: a.reference }, adminOriginator).catch(err =>
            console.log('[vault] abortAction rejected:', (err as Error)?.message)
          )
        }
      }
      offset += actions.length
    }
    console.log(
      '[vault] abort scan · scanned=%d · matches=[%s] · aborted=%d',
      scanned,
      seen.join(', ') || 'NONE',
      aborted.size
    )
  } catch (e) {
    console.log('[vault] abort scan error:', (e as Error)?.message)
  }
  return aborted.size
}

/** Abort the orphaned transactions the review error blames, by txid. */
async function abortReservingTxids(w: VaultWallet, adminOriginator: string, txids: string[]): Promise<number> {
  if (txids.length === 0) return 0
  const want = new Set(txids)
  return await abortActions(w, adminOriginator, a => a.txid != null && want.has(a.txid), { stopAfter: want.size })
}

/** Abort the orphaned transactions holding these outpoints, matched on each
 * action's own input list — the only handle available when the reservation has
 * no txid to blame. */
async function abortReservingOutpoints(
  w: VaultWallet,
  adminOriginator: string,
  outpoints: string[],
  findSpendingReferences?: SpendingReferenceLookup
): Promise<number> {
  if (outpoints.length === 0) return 0

  // One indexed query when storage is reachable. The scan below answers the
  // same question by paging up to 5,000 actions with includeInputs, and
  // listActionsSql answers each page by loading every action's full rawTx and
  // running Transaction.fromBinary on it to read a sequence number — so a vault
  // retry parsed thousands of transactions to find one outpoint.
  if (findSpendingReferences) {
    try {
      const rows = await findSpendingReferences(outpoints)
      const aborted = new Set<string>()
      for (const r of rows) {
        if (!ABORTABLE.has(r.status) || aborted.has(r.reference)) continue
        aborted.add(r.reference)
        await w.abortAction({ reference: r.reference }, adminOriginator).catch(err =>
          console.log('[vault] abortAction rejected:', (err as Error)?.message)
        )
      }
      console.log('[vault] abort by outpoint · matched=%d · aborted=%d', rows.length, aborted.size)
      return aborted.size
    } catch (e) {
      // A storage failure must not cost the retry: fall through to the scan.
      console.log('[vault] spending-reference lookup failed, falling back to scan:', (e as Error)?.message)
    }
  }

  const want = new Set(outpoints.map(sameOutpoint))
  return await abortActions(
    w,
    adminOriginator,
    a => (a.inputs ?? []).some(i => i.sourceOutpoint != null && want.has(sameOutpoint(i.sourceOutpoint))),
    // No count to stop at: one orphan can hold several of our outpoints, and
    // several orphans can each hold one. The 25-page cap is the bound.
    { includeInputs: true, stopAfter: Number.POSITIVE_INFINITY }
  )
}

/**
 * Free a vault UTXO that a previous failed attempt left reserved, so the caller
 * can retry once. Returns how many orphaned transactions were aborted — zero
 * means "not a reservation failure, or nothing could be freed", and the caller
 * must rethrow the original error rather than retry.
 *
 * `ours` bounds the damage: only a reservation on an outpoint THIS withdrawal
 * is trying to spend justifies aborting somebody else's transaction.
 */
async function freeReservedInputs(
  w: VaultWallet,
  adminOriginator: string,
  e: unknown,
  ours: string[],
  findSpendingReferences?: SpendingReferenceLookup
): Promise<number> {
  if (isReviewActionsError(e)) {
    return await abortReservingTxids(w, adminOriginator, competingTxids(e))
  }
  const mine = new Set(ours.map(sameOutpoint))
  const wedged = unspendableInputOutpoints(e).filter(o => mine.has(o))
  return await abortReservingOutpoints(w, adminOriginator, wedged, findSpendingReferences)
}

/**
 * Refuse a vault transfer while offline.
 *
 * Checked before anything else: before the deposit's backup attestation, and
 * before the withdrawal arms the YubiKey — an offline user must not be asked to
 * present a key for a transfer that cannot proceed.
 */
async function requireOnline(opts?: VaultTransferOptions): Promise<void> {
  if (!opts?.isOnline) return
  if (!(await opts.isOnline())) {
    throw new VaultError('requires-online', 'Vault transfers need a connection')
  }
}

// ── balance ─────────────────────────────────────────────────────────────

export async function getVaultBalance(w: VaultWallet, adminOriginator: string): Promise<number> {
  const res = await w.listOutputs({ basket: VAULT_BASKET, limit: 1000 }, adminOriginator)
  return res.outputs.reduce((sum, o) => sum + (o.satoshis ?? 0), 0)
}

// ── deposit ─────────────────────────────────────────────────────────────

export async function depositToVault(
  w: VaultWallet,
  adminOriginator: string,
  satoshis: number,
  opts?: VaultTransferOptions
): Promise<{ txid: string }> {
  await requireOnline(opts)
  if (satoshis < VAULT_DEPOSIT_MIN) {
    throw new VaultError('below-dust', `Vault deposits must be at least ${VAULT_DEPOSIT_MIN} satoshis`)
  }

  // Depositing into a wallet with no recovery path would hide funds behind a
  // hardware key the user cannot get past. Advisory — the wizard is the real
  // gate — but it also covers the deep link straight to the transfer screen.
  //
  // DELIBERATELY NOT in nextDepositTarget, even though that is the single
  // funnel for every vault-basket output: partial withdrawals re-vault their
  // remainder through it, so a check there would block withdrawals.
  //
  // Checked BEFORE nextDepositTarget so a refusal does not burn a deposit index.
  const { publicKey: identityKey } = await w.getPublicKey({ identityKey: true }, adminOriginator)
  if (!(await backupAttestation.get(identityKey))) {
    throw new VaultError('backup-required', 'Back up this wallet before depositing')
  }

  // ── tx1: split ──────────────────────────────────────────────────────────
  //
  // Carve deposit + tx2's exact fee into a staging output, with the wallet's
  // normal change machinery keeping the rest in the default basket. tx2 then
  // spends ONLY that output into the vault script, so the ~960 KB vault output
  // never appears as a sibling output in any later payment's source
  // transaction — without the split, the first ordinary payment after a
  // deposit has to carry the whole vault script inside its inputBEEF.
  const fee = vaultDepositTx2Fee()
  const stagingTotal = satoshis + fee

  // A stranded staging output (tx1 landed, tx2 failed) is money already carved
  // out for exactly one deposit size. Reuse it rather than splitting again, so
  // retrying the same deposit self-heals.
  const listStaging = async () =>
    (await w.listOutputs(
      { basket: VAULT_STAGING_BASKET, include: 'entire transactions', includeCustomInstructions: true, limit: 100 },
      adminOriginator
    )) as ListOutputsResult
  let staged = await listStaging()
  let stagingOut = staged.outputs
    .map(o => ({ ...o, si: decodeStagingInstructions(o.customInstructions) }))
    .find((o): o is typeof o & { si: StagingInstructions } => o.si != null && o.satoshis === stagingTotal)

  // A stranded staging output can be invisible here: a failed tx2 leaves it
  // spendable=0 (see VaultTransferOptions.releaseStrandedStaging), and
  // listOutputs only returns spendable coins. Release, then look again.
  if (!stagingOut && opts?.releaseStrandedStaging) {
    const released = await opts.releaseStrandedStaging().catch(e => {
      console.log('[vault] stranded-staging release failed:', (e as Error)?.message)
      return 0
    })
    if (released > 0) {
      staged = await listStaging()
      stagingOut = staged.outputs
        .map(o => ({ ...o, si: decodeStagingInstructions(o.customInstructions) }))
        .find((o): o is typeof o & { si: StagingInstructions } => o.si != null && o.satoshis === stagingTotal)
    }
  }

  if (!stagingOut) {
    const keyID = `staging ${Utils.toHex(randomBytes(8))}`
    const { publicKey: stagingPub } = await w.getPublicKey(
      { protocolID: STAGING_PROTOCOL, keyID, counterparty: 'self' },
      adminOriginator
    )
    const stagingScript = new P2PKH().lock(PublicKey.fromString(stagingPub).toAddress()).toHex()
    await w.createAction(
      {
        description: 'Prepare vault deposit',
        outputs: [
          {
            satoshis: stagingTotal,
            lockingScript: stagingScript,
            outputDescription: 'Vault deposit funding',
            basket: VAULT_STAGING_BASKET,
            customInstructions: encodeStagingInstructions({ v: 1, type: 'staging', keyID }),
            tags: ['vault']
          }
        ],
        labels: ['vault', 'vault-deposit-split'],
        options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
      },
      adminOriginator
    )
    // Re-list rather than trusting the createAction result shape: this yields
    // the outpoint AND the BEEF tx2 needs as inputBEEF in one call.
    staged = await listStaging()
    stagingOut = staged.outputs
      .map(o => ({ ...o, si: decodeStagingInstructions(o.customInstructions) }))
      .find((o): o is typeof o & { si: StagingInstructions } => o.si != null && o.satoshis === stagingTotal)
    if (!stagingOut) throw new VaultError('no-transaction', 'Deposit split produced no staging output')
  }

  // ── tx2: vault ──────────────────────────────────────────────────────────
  //
  // Explicit single input, single vault output, no change. Two mechanisms keep
  // it that shape, and BOTH are required:
  //  - funding covers the outputs plus exactly the feeModel's target fee
  //    (vaultDepositTx2Fee uses the same size formula), so feeExcess is 0 and
  //    generateChange has no excess to return as change;
  //  - the 'vault-deposit' label suppresses the toolbox's UTXO-pool growth
  //    (targetNetCount — see the patch in patches/@bsv+wallet-toolbox-mobile),
  //    which would otherwise pull in extra funding inputs and split change
  //    into this transaction EVEN at feeExcess 0. That is what produced the
  //    2026-08-21 production failure — and any change output here would drag
  //    the ~960 KB vault script into the inputBEEF of every later payment
  //    spending it, defeating the whole two-transaction design.
  //
  // The signing below still tolerates extra toolbox-added inputs (it locates
  // the staging input by outpoint and commits to the full input set), so a
  // toolbox that ignores the label degrades to an ugly-but-valid deposit, not
  // a broadcast rejection.
  const target = await nextDepositTarget()
  const created = await w.createAction(
    {
      description: 'Move to vault',
      inputs: [
        {
          outpoint: stagingOut.outpoint,
          unlockingScriptLength: STAGING_UNLOCK_LEN,
          inputDescription: 'Vault deposit funding'
        }
      ],
      outputs: [
        {
          satoshis,
          lockingScript: target.lockingScript,
          outputDescription: 'Vault deposit',
          basket: VAULT_BASKET,
          customInstructions: encodeVaultInstructions(target.instructions),
          tags: ['vault']
        }
      ],
      labels: ['vault', 'vault-deposit'],
      inputBEEF: staged.BEEF?.length ? staged.BEEF : undefined,
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false, trustSelf: 'known' }
    },
    adminOriginator
  )

  if (!created.signableTransaction) {
    const txid = created.txid ?? (created.tx ? Transaction.fromAtomicBEEF(created.tx).id('hex') : undefined)
    if (!txid) throw new VaultError('no-transaction', 'Deposit produced no transaction')
    return { txid }
  }

  const { tx: atomic, reference } = created.signableTransaction
  let unlockingScript: string
  let stagingInputIndex: number
  try {
    const tx = Transaction.fromAtomicBEEF(atomic)
    // The toolbox is free to add funding inputs and change outputs of its own
    // (generateChange grows the UTXO pool toward numberOfDesiredUTXOs), so the
    // staging input is located by outpoint, never assumed to be input 0 — and
    // the signature below must commit to EVERY input via otherInputs, or the
    // nodes reject the spend with "false stack entry at end of script
    // execution" (the 2026-08-21 production deposit failure).
    const [stagingTxid, stagingVoutStr] = stagingOut.outpoint.split('.')
    const stagingVout = Number(stagingVoutStr)
    stagingInputIndex = tx.inputs.findIndex(
      i =>
        (i.sourceTXID ?? i.sourceTransaction?.id('hex'))?.toLowerCase() === stagingTxid.toLowerCase() &&
        i.sourceOutputIndex === stagingVout
    )
    if (stagingInputIndex < 0) {
      throw new VaultError('no-transaction', 'Staging input missing from the signable transaction')
    }
    const { publicKey: stagingPub } = await w.getPublicKey(
      { protocolID: STAGING_PROTOCOL, keyID: stagingOut.si.keyID, counterparty: 'self' },
      adminOriginator
    )
    const subscript = new P2PKH().lock(PublicKey.fromString(stagingPub).toAddress())
    const input = tx.inputs[stagingInputIndex]
    const scope = TransactionSignature.SIGHASH_ALL | TransactionSignature.SIGHASH_FORKID
    const preimage = TransactionSignature.format({
      sourceTXID: stagingTxid,
      sourceOutputIndex: input.sourceOutputIndex,
      sourceSatoshis: stagingOut.satoshis,
      transactionVersion: tx.version,
      otherInputs: tx.inputs.filter((_, i) => i !== stagingInputIndex),
      outputs: tx.outputs,
      inputIndex: stagingInputIndex,
      inputSequence: input.sequence ?? 0xffffffff,
      subscript,
      lockTime: tx.lockTime,
      scope
    })
    const { signature } = await w.createSignature(
      {
        protocolID: STAGING_PROTOCOL,
        keyID: stagingOut.si.keyID,
        counterparty: 'self',
        hashToDirectlySign: Array.from(Hash.hash256(preimage))
      },
      adminOriginator
    )
    unlockingScript = new UnlockingScript([
      { op: signature.length + 1, data: [...signature, scope] },
      { op: 33, data: Utils.toArray(stagingPub, 'hex') }
    ]).toHex()
  } catch (e) {
    // Nothing was signed: release the reservation so the staging output stays
    // spendable, and the next deposit of the same amount reuses it.
    await w.abortAction({ reference }, adminOriginator).catch(() => {})
    throw e
  }

  const signed = await w.signAction(
    { reference, spends: { [stagingInputIndex]: { unlockingScript } }, options: { acceptDelayedBroadcast: false } },
    adminOriginator
  )
  const txid = signed.txid ?? (signed.tx ? Transaction.fromAtomicBEEF(signed.tx).id('hex') : undefined)
  if (!txid) throw new VaultError('no-transaction', 'Deposit produced no transaction')
  return { txid }
}

// ── withdraw / sweep (shared spend core) ─────────────────────────────────

/** Which branch of the R1-K1 script this spend uses. */
type SpendPath = { path: 'r1'; signer: VaultR1Signer } | { path: 'k1'; hd: HD }

async function spendVaultOutputs(
  w: VaultWallet,
  adminOriginator: string,
  amount: number | 'all',
  reason: string,
  spend: SpendPath,
  opts: { revaultRemainder: boolean } & VaultTransferOptions
): Promise<VaultSpendResult> {
  // Announce work BEFORE starting it, then hand the JS thread back once so
  // React can actually paint the sheet. Everything below — a ~1.83 MB
  // listOutputs, then createAction over a ~960 KB-per-input transaction —
  // blocks the thread for seconds; without this yield the phase change is
  // queued behind that work and the user stares at a frozen screen anyway.
  noteVaultProgress({ phase: 'preparing' })
  await new Promise<void>(resolve => setTimeout(resolve, 0))

  // `include: 'entire transactions'` IS required, despite costing ~1.83 MB per
  // vault input: every input here carries unlockingScriptLength but no
  // unlockingScript, so @bsv/sdk's validateCreateActionArgs sets
  // isSignAction=true for this createAction call. buildSignableTransaction
  // then resolves each input's sourceTransaction ONLY from args.inputBEEF
  // (buildSignableTransaction.js:14,101) — trustSelf and storage's own
  // "known input" shortcut (storage/methods/createAction.js's
  // localKnownInputTxids) are a STORAGE-side allowance to skip merkle-proof
  // verification, not a substitute for the client supplying inputBEEF at all.
  // Omit it and createAction.js's makeSignableTransactionBeef throws
  // WERR_INTERNAL('Every signableTransaction input must have a
  // sourceTransaction') on the very first input, before signing ever starts.
  // (This does not apply to depositToVault: it supplies no explicit inputs,
  // so isSignAction is false there and no BEEF is ever needed.) The memory
  // cost is real but not a NEW one: broadcasting already pays ~1.83 MB per
  // input in extended format regardless, so this list call just front-loads
  // a cost the wallet incurs either way. includeCustomInstructions IS also
  // required — listOutputs omits that field unless asked, and without it
  // every output filters out as unreadable.
  const list = await w.listOutputs(
    { basket: VAULT_BASKET, include: 'entire transactions', includeCustomInstructions: true, limit: 1000 },
    adminOriginator
  )
  const spendable = list.outputs
    .map(o => ({ ...o, ci: decodeVaultInstructions(o.customInstructions) }))
    .filter((o): o is typeof o & { ci: VaultInstructions } => o.ci != null)
    .sort((a, b) => b.satoshis - a.satoshis) // largest first
  if (spendable.length === 0) throw new VaultError('vault-empty', 'Vault is empty')

  const total = spendable.reduce((s, o) => s + o.satoshis, 0)
  if (amount !== 'all' && amount > total) {
    throw new VaultError('amount-exceeds-balance', 'Withdrawal exceeds vault balance')
  }

  // Bounded input count. Each input's ~960 KB R1 unlocking script is built and
  // signed one at a time (the sequential loop below), which bounds TRANSIENT
  // working memory to roughly one input at a time — but the `spends` payload
  // handed to signAction, and the Extended Format that goes on the wire, are
  // both O(inputs) and unavoidable. See VAULT_MAX_INPUTS.
  //
  // Largest first (already sorted), so the fewest inputs cover the most value.
  const cap = Math.min(VAULT_MAX_INPUTS, VAULT_HARD_MAX_INPUTS)
  const selected = spendable.slice(0, cap)
  const acc = selected.reduce((s, o) => s + o.satoshis, 0)
  const remainingInputs = spendable.length - selected.length

  // 'all' means "as much as one safe transaction can carry"; the untouched
  // outputs stay in the vault and the re-vaulted remainder consolidates what was
  // spent, so repeating the withdrawal drains it.
  const want = amount === 'all' ? acc : amount
  if (want > acc) {
    // The vault holds enough (checked above) but not within the input cap. Say
    // so, rather than blaming the balance: the remedy is a smaller withdrawal,
    // which also consolidates and makes the next one cheaper.
    throw new VaultError(
      'too-many-inputs',
      `Withdrawing ${want} satoshis would need more than ${cap} vault inputs; withdraw a smaller amount first`
    )
  }

  const outputs: unknown[] = []
  const remainder = acc - want
  // A sub-floor remainder is folded into the withdrawal rather than re-vaulted:
  // an output below VAULT_DEPOSIT_MIN is not worth what it costs to move. It
  // still reaches the user — as part of the toolbox's own default-basket
  // change alongside the withdrawn amount — it is just not re-vaulted.
  if (opts.revaultRemainder && remainder >= VAULT_DEPOSIT_MIN) {
    const target = await nextDepositTarget()
    outputs.push({
      satoshis: remainder,
      lockingScript: target.lockingScript,
      outputDescription: 'Vault change',
      basket: VAULT_BASKET,
      customInstructions: encodeVaultInstructions(target.instructions),
      tags: ['vault']
    })
  }

  const unlockLen = spend.path === 'r1' ? R1K1_R1_UNLOCK_LEN : R1K1_K1_UNLOCK_LEN
  const caArgs = {
    description: reason,
    inputs: selected.map(o => ({
      outpoint: o.outpoint,
      unlockingScriptLength: unlockLen,
      inputDescription: 'Vault withdrawal'
    })),
    outputs,
    labels: ['vault', 'vault-withdraw'],
    // inputBEEF, from the 'entire transactions' listOutputs call above — see
    // the comment there for why this is required, not optional. trustSelf:
    // 'known' is kept alongside it: it is what lets storage skip re-walking
    // each source transaction's own merkle-proof ancestry for a basket this
    // wallet already trusts (its own prior deposits), rather than what makes
    // inputBEEF itself unnecessary.
    inputBEEF: list.BEEF?.length ? list.BEEF : undefined,
    options: { randomizeOutputs: false, acceptDelayedBroadcast: false, trustSelf: 'known' }
  }

  let created: CreateActionResult
  try {
    created = await w.createAction(caArgs, adminOriginator)
  } catch (e) {
    // A prior failed attempt can leave a vault UTXO reserved by an orphaned
    // transaction, and until it is aborted every later withdrawal is refused
    // outright. Two error shapes, depending on whether the orphan ever got a
    // txid — see freeReservedInputs. Abort it and retry ONCE; anything else
    // frees nothing and rethrows untouched.
    const freed = await freeReservedInputs(
      w,
      adminOriginator,
      e,
      selected.map(o => o.outpoint),
      opts.findSpendingReferences
    )
    if (freed === 0) throw e
    created = await w.createAction(caArgs, adminOriginator)
  }

  if (!created.signableTransaction) {
    const txid = created.txid ?? (created.tx ? Transaction.fromAtomicBEEF(created.tx).id('hex') : undefined)
    if (!txid) throw new VaultError('no-transaction', 'Withdrawal produced no transaction')
    return { txid, remainingInputs }
  }

  const { tx: atomic, reference } = created.signableTransaction
  let builtSpends: Record<number, { unlockingScript: string }>
  try {
    const tx = Transaction.fromAtomicBEEF(atomic)
    const template = new R1K1Wallet()
    const spends: Record<number, { unlockingScript: string }> = {}

    // Read once, not per input — takeNextIndex above may have rewritten meta,
    // but xpub is immutable for the life of an enrollment. On the K1
    // recovery path we already hold the HD node in hand, and vaultXpub(hd)
    // is the IDENTICAL value vault meta's xpub would give — deriving it
    // locally means the path that is supposed to work when everything except
    // the mnemonic and passphrase is gone does not also depend on
    // vaultStore/device-local state still being intact.
    const xpub = spend.path === 'k1' ? vaultXpub(spend.hd) : (await vaultStore.getMeta())?.xpub
    if (!xpub) throw new VaultError('not-enrolled', 'Vault is not set up')

    // SEQUENTIAL BY DESIGN — do not "simplify" this into an
    // unlockingScriptTemplate + tx.sign(), and do not parallelise with
    // Promise.all/map. @bsv/sdk's Transaction.sign() fans every
    // unlockingScriptTemplate.sign() call out through Promise.all
    // (dist/cjs/src/transaction/Transaction.js), which would invoke
    // VaultR1Signer.sign() concurrently for every input. VaultR1Signer signs
    // one digest at a time and rejects an overlapping call fast (see the
    // `signing` guard in ceremony.ts) rather than corrupting its shared
    // retry/session state — so a parallel fan-out fails every input after the
    // first with 'template-invalid'. This for-loop calling unlocker.sign()
    // directly and assigning spends[i] keeps every sign() call strictly
    // one-at-a-time.
    for (let i = 0; i < selected.length; i++) {
      // Yield before each input as well as reporting it: building this input's
      // unlocking script is the blocking part, so the count only reaches the
      // screen if React gets a frame first.
      noteVaultProgress({ phase: 'signing', index: i + 1, total: selected.length })
      await new Promise<void>(resolve => setTimeout(resolve, 0))

      const o = selected[i]
      const index = indexFromKeyID(o.ci.keyID)
      if (index == null) throw new VaultError('bad-derivation-index', `Not a BIP32 vault output: ${o.ci.keyID}`)

      // Rebuild the prevout script rather than fetching the source transaction.
      const lockingScript = await buildVaultLockingScript({
        r1PublicKey: o.ci.r1PublicKey,
        salt: o.ci.salt,
        k1PublicKeyHash: Utils.toArray(depositPkhFromXpub(xpub, index), 'hex')
      })

      // The real "wrong YubiKey" check, done BEFORE any signing: the
      // commitment `unlockR1` verifies is built from this exact output's own
      // r1PublicKey/salt (immediately above), so it can never actually catch
      // a mismatch — it is self-consistent by construction, not a check
      // against what is physically inserted. The armed signer's own public
      // key (read from the card, via ceremony.ts's makeSigner) is the only
      // thing that can genuinely differ from the key an output was locked
      // to — e.g. after a re-enrollment, when older outputs still carry the
      // OLD r1PublicKey. Comparing the two here is what spec §11 describes
      // as "caught before any APDU" — an output that fails this never reaches
      // signEcdsa at all.
      if (spend.path === 'r1' && Utils.toHex(spend.signer.publicKey).toLowerCase() !== o.ci.r1PublicKey.toLowerCase()) {
        throw new VaultError('wrong-key', 'This output was locked to a different YubiKey')
      }

      const unlocker =
        spend.path === 'r1'
          ? template.unlockR1({
              publicKey: o.ci.r1PublicKey,
              salt: o.ci.salt,
              sourceSatoshis: o.satoshis,
              lockingScript,
              // The template hands us HASH256(preimage), already double-hashed.
              // The card signs it raw — no further hashing on either side.
              signDigest: digest => spend.signer.sign(digest)
            })
          : template.unlockK1({
              privateKey: depositPrivKey(spend.hd, index),
              sourceSatoshis: o.satoshis,
              lockingScript
            })

      spends[i] = { unlockingScript: (await unlocker.sign(tx, i)).toHex() }
    }

    builtSpends = spends
  } catch (e) {
    // Nothing was signed, so the reservation is worthless — release it, or the
    // vault UTXO stays spendable=false and the next withdrawal is refused
    // outright.
    await w.abortAction({ reference }, adminOriginator).catch(() => {})
    throw e
  }

  // PAST THE POINT OF NO ABORT.
  //
  // acceptDelayedBroadcast: true hands the signed transaction to storage and
  // lets the monitor's SendWaiting task carry it to the network. A slow or
  // timing-out broadcaster therefore cannot cost the user a signed
  // transaction, and this call no longer waits on the network before the UI
  // can move on.
  //
  // Deliberately OUTSIDE the try above: once a transaction is signed, aborting
  // it is the dangerous move, not the safe one — the network may already have
  // accepted it, and abandoning it locally would leave the wallet blind to
  // funds that really moved. A failure here is reported as "we will try
  // again", never as a cancellation.
  noteVaultProgress({ phase: 'broadcasting' })
  const signed = await w.signAction(
    { reference, spends: builtSpends, options: { acceptDelayedBroadcast: true } },
    adminOriginator
  )
  const txid = signed.txid ?? (signed.tx ? Transaction.fromAtomicBEEF(signed.tx).id('hex') : undefined)
  if (!txid) throw new VaultError('no-transaction', 'Withdrawal produced no transaction')
  return { txid, remainingInputs }
}

/** Withdraw via the YubiKey (R1 branch). Arms one signing session for the whole
 * transaction and always releases it in a finally — on iOS that is what
 * dismisses the system NFC sheet, and it must fire whether the withdrawal
 * succeeds, fails to build, or fails to sign. */
export async function withdrawFromVault(
  w: VaultWallet,
  adminOriginator: string,
  amount: number | 'all',
  reason: string,
  opts?: VaultTransferOptions
): Promise<VaultSpendResult> {
  // Before the ceremony: no key prompt for a transfer that cannot proceed.
  await requireOnline(opts)
  const signer = await requestVaultSigner(reason)
  try {
    return await spendVaultOutputs(w, adminOriginator, amount, reason, { path: 'r1', signer }, {
      revaultRemainder: true,
      ...opts
    })
  } finally {
    signer.release()
  }
}

/**
 * Recovery via the K1 branch: sweep the ENTIRE vault to the default basket,
 * signing with the HD node derived from the main mnemonic + vault passphrase.
 * No YubiKey. Returns null when the vault is already empty.
 */
export async function sweepVaultWithHD(
  w: VaultWallet,
  adminOriginator: string,
  hd: HD,
  reason: string,
  opts?: VaultTransferOptions
): Promise<VaultSpendResult | null> {
  await requireOnline(opts)
  try {
    return await spendVaultOutputs(w, adminOriginator, 'all', reason, { path: 'k1', hd }, {
      revaultRemainder: false,
      ...opts
    })
  } catch (e) {
    if (e instanceof VaultError && e.code === 'vault-empty') return null
    throw e
  }
}
