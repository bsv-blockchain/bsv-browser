/**
 * Vault transfers — internal movements between the `default` change basket
 * and the `admin vault` basket, over plain K1 (secp256k1) P2PKH outputs.
 *
 * Deposit: ONE YubiKey tap. The card unwraps the vault key; the next deposit
 * index derives that node's child public-key hash, which IS the P2PKH lock.
 * Nothing here can produce a vault address without the tap — no xpub is
 * stored anywhere, so the unwrapped node is the only source of the material.
 * Funding and change stay with the toolbox, out of the default basket.
 *
 * Withdraw: ONE tap for the whole transaction. The same unwrapped node derives
 * the child private key each selected input names, and signs it in software.
 * The toolbox returns the withdrawn value (minus fee, minus any re-vaulted
 * remainder) as change into the default basket — that change IS the internal
 * transfer. Vault inputs carry a custom unlockingScriptLength the toolbox
 * cannot itself produce, so we build each unlocking script ourselves and
 * finalize with signAction.
 *
 * Sweep: recovery for a lost YubiKey, signed from the SAME HD node reached
 * the other way — main mnemonic + vault passphrase (see vaultDerivation.ts).
 * No card, no ceremony. Always empties the vault (subject to the input cap)
 * and never re-vaults.
 *
 * One rail built for the ~960 KB R1-K1 script survives it on its own merits:
 * the deferred-broadcast finish on withdrawal (see the PAST THE POINT OF NO
 * ABORT comment). The other — the two-transaction deposit that staged exact
 * funding so no change output was ever a sibling of the giant script — is
 * retired: a K1 deposit is ONE ordinary createAction (see depositToVault).
 * What remains of the staging machinery exists only to recover money the old
 * flow stranded on real wallets (see reclaimStagingOutputs).
 *
 * The `admin vault` basket name is admin-reserved: WalletPermissionsManager
 * blocks any non-admin originator (web pages) from listing, inserting into, or
 * relinquishing it. All calls here use the admin originator.
 *
 * SECURITY: the vault HD node passes through this module for the length of ONE
 * operation and is never stored. It arrives either as a VaultKeyHandle — read
 * at its point of use, released in a finally — or, on the sweep, as a node the
 * caller owns; neither is ever put in module state, a cache, or a closure that
 * outlives the call. Nothing key-shaped is logged: not the node, not a child
 * key, not a seed.
 */
import { Beef, HD, Hash, LockingScript, P2PKH, PublicKey, Transaction, TransactionSignature, UnlockingScript, Utils } from '@bsv/sdk'
import { vaultStore } from './vaultStore'
import { VaultError } from './types'
import { backupAttestation } from './backupAttestation'
import { VaultKeyHandle } from './ceremony'
import { noteVaultProgress, requestVaultKey } from './ceremonyHost'
import { bip32KeyID, indexFromKeyID, depositPrivKey, depositPubKeyHash } from './vaultDerivation'
import {
  K1_UNLOCK_LEN,
  buildVaultLockingScript,
  decodeVaultInstructions,
  encodeVaultInstructions,
  VaultInstructions
} from './k1'

export const VAULT_BASKET = 'admin vault'

/**
 * LEGACY — the intermediate basket the retired two-transaction deposit split
 * its funding into (tx1 carved out deposit + tx2 fee here; tx2 spent it into
 * the vault). No new outputs are ever created in it. It survives only so that
 * reclaimStagingOutputs can find and recover coins the old flow stranded on
 * real wallets (tx1 landed, tx2 failed).
 */
export const VAULT_STAGING_BASKET = 'vault staging'

/** LEGACY — BRC-42 protocol the staging output's P2PKH key was derived under.
 * Reclaim-only: the key lives in the ordinary wallet key deriver (counterparty
 * 'self'), so spending a staging coin needs no ceremony and no YubiKey. */
const STAGING_PROTOCOL: [number, string] = [2, 'vault deposit staging']

/** P2PKH unlock, worst case: push(73-byte DER+hashtype sig) + push(33-byte key). */
const STAGING_UNLOCK_LEN = 108

interface StagingInstructions {
  v: 1
  type: 'staging'
  keyID: string
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
 * Dust-fold threshold for withdrawal remainders — not a deposit floor.
 *
 * The old 200,000 figure was R1 fee economics: a ~960 KB script paid for
 * twice, once to create the output and once to push the preimage that spent
 * it, made anything smaller not worth moving. A K1 vault output costs 25 bytes
 * to create and ~107 to spend, so at the wallet's fee rate moving one is a
 * couple of satoshis and the script no longer argues for any floor at all.
 * Deposits are no longer capped by this constant.
 *
 * What remains is dust hygiene on the withdrawal side: a sub-floor remainder
 * left over after a partial withdrawal is folded into the withdrawal (via the
 * toolbox's own change) rather than re-vaulted, since an output this small
 * isn't worth the index it would burn.
 */
export const VAULT_DEPOSIT_MIN = 10_000

/**
 * Vault inputs per withdrawal.
 *
 * Nothing about the SCRIPTS bounds this any more. The old cap of 6 was
 * defending against ~1.83 MB of inputBEEF per input (a measured 146 MB Hermes
 * array at 20 inputs) and Arcade's 10 MB transaction policy — both artifacts of
 * the R1-K1 script. A K1 input contributes an ordinary source transaction and a
 * ~107-byte unlocking script; 32 of them is a few kilobytes on the wire.
 *
 * What still bounds it is createAction ergonomics. Every input is one more coin
 * to reserve atomically and release if anything fails, one more sighash
 * preimage formatted over a transaction that itself grows with each input (the
 * signing loop below is O(n²) in preimage bytes), and one more chance for a
 * stuck reservation to wedge the whole withdrawal. 32 drains any realistic
 * vault in one pass while staying well inside all of that; the hard ceiling is
 * the value no future tuning may exceed without redoing that reasoning. (It is
 * also the vault-side control services/walletArgLimits.ts refers to — the vault
 * bypasses the wallet-argument caps structurally, so this IS its bound.)
 *
 * Consolidation is automatic: a capped withdrawal re-vaults its remainder as one
 * output, so repeated withdrawals converge on a single vault UTXO.
 */
export const VAULT_MAX_INPUTS = 32
export const VAULT_HARD_MAX_INPUTS = 48

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

/**
 * Reserve the next deposit slot: take the next BIP32 index and lock to that
 * child of the vault node. Used by both depositToVault and the withdraw path's
 * re-vaulted-remainder output.
 *
 * `hd` is caller-owned and operation-scoped — read from the armed handle at
 * the call site, never held here. There is no stored xpub to fall back on:
 * without a node in hand this function cannot produce an address at all, which
 * is exactly the property that makes every deposit a deliberate tap.
 */
async function nextDepositTarget(hd: HD): Promise<{
  instructions: VaultInstructions
  lockingScript: string
}> {
  const index = await vaultStore.takeNextIndex()
  if (index == null) throw new VaultError('not-enrolled', 'Vault is not set up')
  const script = buildVaultLockingScript({ k1PublicKeyHash: depositPubKeyHash(hd, index) })
  return {
    instructions: { v: 3, type: 'K1', keyID: bip32KeyID(index) },
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

/**
 * Move `satoshis` from the default basket into the vault.
 *
 * Costs exactly one tap, and every refusal is checked BEFORE it: a user must
 * never be asked to present a key for a transfer that was never going to
 * proceed, and — because the tap gates the derivation, and nothing is spent
 * until the single createAction below it — cancelling it moves no money.
 *
 * `reason` is what the ceremony sheet shows while the key is armed.
 */
export async function depositToVault(
  w: VaultWallet,
  adminOriginator: string,
  satoshis: number,
  reason: string,
  opts?: VaultTransferOptions
): Promise<{ txid: string }> {
  await requireOnline(opts)

  // Depositing into a wallet with no recovery path would hide funds behind a
  // hardware key the user cannot get past. Advisory — the wizard is the real
  // gate — but it also covers the deep link straight to the transfer screen.
  //
  // DELIBERATELY NOT in nextDepositTarget, even though that is the single
  // funnel for every vault-basket output: partial withdrawals re-vault their
  // remainder through it, so a check there would block withdrawals.
  //
  // Checked BEFORE the tap (and so before nextDepositTarget) so a refusal
  // neither raises a ceremony nor burns a deposit index.
  const { publicKey: identityKey } = await w.getPublicKey({ identityKey: true }, adminOriginator)
  if (!(await backupAttestation.get(identityKey))) {
    throw new VaultError('backup-required', 'Back up this wallet before depositing')
  }

  // ── the tap ─────────────────────────────────────────────────────────────
  //
  // A deposit address is a child of the vault node and there is no stored
  // xpub, so this is the only way to produce one. release() in the finally is
  // what drops the key and (on iOS) dismisses the NFC sheet — it must fire
  // whether the deposit succeeds or fails to build.
  const handle = await requestVaultKey(reason)
  try {
    return await lockDeposit(w, adminOriginator, satoshis, handle)
  } finally {
    handle.release()
  }
}

/**
 * The deposit itself, run inside an armed ceremony: ONE ordinary createAction
 * carrying the vault output, funded by the toolbox's own coin selection and
 * change machinery.
 *
 * This used to be two chained transactions (tx1 staged exact funding into
 * VAULT_STAGING_BASKET, tx2 spent only that into the vault) so that the
 * ~960 KB R1-K1 script never shared a transaction with a default-basket
 * change output — change born next to it dragged the whole script into the
 * inputBEEF of every later payment that spent that change. A K1 vault output
 * is a 25-byte P2PKH lock, so that cost is gone and the deposit is one
 * transaction like any other spend. The 'vault-deposit' label still matters:
 * the patched toolbox (see patches/) suppresses UTXO-pool growth for it, so
 * the deposit stays minimal — at most one change output — instead of
 * splitting change toward numberOfDesiredUTXOs.
 *
 * `handle` is operation-scoped: `hd` is read once, at its only point of use,
 * and neither the handle nor the node is stored anywhere that outlives this
 * call (see VaultKeyHandle). A released or relocked handle refuses there.
 *
 * KNOWN TRADE: the deposit index is taken BEFORE createAction, so a funding
 * failure (insufficient change for deposit + fee) burns an index the old
 * two-tx flow would not have (its derivation ran only after tx1 landed).
 * Accepted deliberately: index holes are harmless — withdraw and sweep read
 * each output's STORED keyID, nothing ever walks the index space — and the
 * alternative (deriving after createAction) would spend real money before
 * knowing an address exists for it.
 */
async function lockDeposit(
  w: VaultWallet,
  adminOriginator: string,
  satoshis: number,
  handle: VaultKeyHandle
): Promise<{ txid: string }> {
  // Announce work before starting it: the ceremony sheet is on screen for the
  // whole deposit, and this also refreshes the retention window so a slow
  // createAction cannot have the key relocked out from under it.
  noteVaultProgress({ phase: 'preparing' })
  const target = await nextDepositTarget(handle.hd)

  // One call builds, signs AND broadcasts: with no caller-supplied inputs
  // there is no signableTransaction step — every funding input is toolbox
  // change the toolbox signs itself. Undelayed, so a failed broadcast surfaces
  // here rather than leaving the deposit looking sent while it sits in the
  // monitor's queue.
  noteVaultProgress({ phase: 'broadcasting' })
  const created = await w.createAction(
    {
      description: 'Move to vault',
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
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
    },
    adminOriginator
  )
  const txid = created.txid ?? (created.tx ? Transaction.fromAtomicBEEF(created.tx).id('hex') : undefined)
  if (!txid) throw new VaultError('no-transaction', 'Deposit produced no transaction')
  return { txid }
}

// ── legacy staging reclaim ────────────────────────────────────────────────

export interface ReclaimResult {
  /** Absent when there was nothing to reclaim. */
  txid?: string
  /** How many staging outputs the reclaim spent. */
  reclaimed: number
  /** Their total value (the fee comes out of it; the rest returns as change). */
  satoshis: number
}

/**
 * Recover money the retired two-transaction deposit stranded.
 *
 * The old flow could leave a funded staging output behind (tx1 landed, tx2
 * failed — the 2026-08-22 device crash mid-deposit is exactly this shape),
 * and that money is INVISIBLE: the main balance counts only the 'default'
 * basket and the vault balance only 'admin vault', so a stranded coin shows
 * up in neither. Now that deposits no longer consume staging outputs, this
 * sweep is the only way that money comes back.
 *
 * Spends EVERY decodable staging output regardless of amount — unlike the old
 * deposit-time reuse, which matched by exact satoshis — with no outputs of its
 * own, so the toolbox returns the whole value (minus fee) as default-basket
 * change. The staging key is an ordinary BRC-42 wallet key (counterparty
 * 'self'), so no ceremony, no tap, no vault HD node is involved.
 *
 * Safe to call speculatively: returns {reclaimed: 0} without touching the
 * wallet when the basket is empty.
 */
export async function reclaimStagingOutputs(
  w: VaultWallet,
  adminOriginator: string,
  opts?: {
    /**
     * Storage-backed release of staging outputs stranded by a definitively
     * invalid spender. Returns how many outputs were made spendable again.
     *
     * Runs FIRST because a stranded coin usually sits spendable=0: when the
     * old tx2 failed, the toolbox restored its inputs but then re-stranded
     * them — markStaleInputsAsSpent asked the indexers whether the staging
     * outpoint was a UTXO seconds after tx1 broadcast, and indexer lag
     * answered "no" — and listOutputs only returns spendable coins. See
     * releaseVaultStagingStrandedByInvalidTx in StorageExpoSQLite for the
     * deliberately narrow predicate.
     */
    releaseStrandedStaging?: () => Promise<number>
    /** Storage-backed reservation heal for the retry below. See SpendingReferenceLookup. */
    findSpendingReferences?: SpendingReferenceLookup
  }
): Promise<ReclaimResult> {
  if (opts?.releaseStrandedStaging) {
    await opts.releaseStrandedStaging().catch(e => {
      console.log('[vault] stranded-staging release failed:', (e as Error)?.message)
      return 0
    })
  }

  const staged = (await w.listOutputs(
    { basket: VAULT_STAGING_BASKET, include: 'entire transactions', includeCustomInstructions: true, limit: 100 },
    adminOriginator
  )) as ListOutputsResult
  const coins = staged.outputs
    .map(o => ({ ...o, si: decodeStagingInstructions(o.customInstructions) }))
    .filter((o): o is typeof o & { si: StagingInstructions } => o.si != null)
  if (coins.length === 0) return { reclaimed: 0, satoshis: 0 }

  const totalSats = coins.reduce((s, c) => s + c.satoshis, 0)
  const caArgs = {
    description: 'Recover vault deposit funding',
    inputs: coins.map(c => ({
      outpoint: c.outpoint,
      unlockingScriptLength: STAGING_UNLOCK_LEN,
      inputDescription: 'Stranded vault deposit funding'
    })),
    outputs: [],
    // 'vault-deposit' is load-bearing twice: the patched toolbox suppresses
    // UTXO-pool growth for it (no extra funding inputs pulled in), and the
    // stranded-release predicates (both arms — spendable=0 re-strands AND
    // stale spentBy on spendable=1 coins, see findSql.ts) match on it — so if
    // THIS transaction fails at broadcast and re-strands the coins, the same
    // heal releases them for the next attempt. 'vault-reclaim' is for
    // history and forensics only.
    labels: ['vault', 'vault-deposit', 'vault-reclaim'],
    // Mandatory, not an optimization: these inputs carry unlockingScriptLength
    // and no unlockingScript, so isSignAction is true and the signer resolves
    // each input's sourceTransaction ONLY from args.inputBEEF. trustSelf just
    // skips storage re-walking proof ancestry for our own coins.
    inputBEEF: staged.BEEF?.length ? staged.BEEF : undefined,
    options: { randomizeOutputs: false, acceptDelayedBroadcast: false, trustSelf: 'known' }
  }
  let created: CreateActionResult
  try {
    created = await w.createAction(caArgs, adminOriginator)
  } catch (e) {
    // A prior failed attempt (or a concurrent reclaim from a quick screen
    // remount) can leave a coin reserved by an orphaned transaction, and until
    // that is aborted every later reclaim is refused outright — the same
    // wedge the withdraw path heals. Abort it and retry ONCE; anything else
    // frees nothing and rethrows untouched.
    const freed = await freeReservedInputs(
      w,
      adminOriginator,
      e,
      coins.map(c => c.outpoint),
      opts?.findSpendingReferences
    )
    if (freed === 0) throw e
    created = await w.createAction(caArgs, adminOriginator)
  }

  if (!created.signableTransaction) {
    const txid = created.txid ?? (created.tx ? Transaction.fromAtomicBEEF(created.tx).id('hex') : undefined)
    if (!txid) throw new VaultError('no-transaction', 'Reclaim produced no transaction')
    return { txid, reclaimed: coins.length, satoshis: totalSats }
  }

  const { tx: atomic, reference } = created.signableTransaction
  const spends: Record<number, { unlockingScript: string }> = {}
  try {
    const tx = Transaction.fromAtomicBEEF(atomic)
    for (const c of coins) {
      // Preimage formatting is O(tx size) per input; yield between inputs so a
      // large reclaim cannot hang the JS thread (same reasoning as the
      // withdraw signing loop below).
      await new Promise<void>(resolve => setTimeout(resolve, 0))

      // The toolbox is free to add funding inputs of its own, so each staging
      // input is located by outpoint, never assumed by position — and the
      // signature commits to EVERY input via otherInputs, or the nodes reject
      // the spend with "false stack entry at end of script execution" (the
      // 2026-08-21 production deposit failure).
      const [cTxid, cVoutStr] = c.outpoint.split('.')
      const cVout = Number(cVoutStr)
      const inputIndex = tx.inputs.findIndex(
        i =>
          (i.sourceTXID ?? i.sourceTransaction?.id('hex'))?.toLowerCase() === cTxid.toLowerCase() &&
          i.sourceOutputIndex === cVout
      )
      if (inputIndex < 0) {
        throw new VaultError('no-transaction', 'Staging input missing from the signable transaction')
      }
      const { publicKey: stagingPub } = await w.getPublicKey(
        { protocolID: STAGING_PROTOCOL, keyID: c.si.keyID, counterparty: 'self' },
        adminOriginator
      )
      const subscript = new P2PKH().lock(PublicKey.fromString(stagingPub).toAddress())
      const input = tx.inputs[inputIndex]
      const scope = TransactionSignature.SIGHASH_ALL | TransactionSignature.SIGHASH_FORKID
      const preimage = TransactionSignature.format({
        sourceTXID: cTxid,
        sourceOutputIndex: input.sourceOutputIndex,
        sourceSatoshis: c.satoshis,
        transactionVersion: tx.version,
        otherInputs: tx.inputs.filter((_, i) => i !== inputIndex),
        outputs: tx.outputs,
        inputIndex,
        inputSequence: input.sequence ?? 0xffffffff,
        subscript,
        lockTime: tx.lockTime,
        scope
      })
      const { signature } = await w.createSignature(
        {
          protocolID: STAGING_PROTOCOL,
          keyID: c.si.keyID,
          counterparty: 'self',
          hashToDirectlySign: Array.from(Hash.hash256(preimage))
        },
        adminOriginator
      )
      spends[inputIndex] = {
        unlockingScript: new UnlockingScript([
          { op: signature.length + 1, data: [...signature, scope] },
          { op: 33, data: Utils.toArray(stagingPub, 'hex') }
        ]).toHex()
      }
    }
  } catch (e) {
    // Nothing was signed: release the reservation so the coins stay listed
    // for the next reclaim attempt.
    await w.abortAction({ reference }, adminOriginator).catch(() => {})
    throw e
  }

  const signed = await w.signAction(
    { reference, spends, options: { acceptDelayedBroadcast: false } },
    adminOriginator
  )
  const txid = signed.txid ?? (signed.tx ? Transaction.fromAtomicBEEF(signed.tx).id('hex') : undefined)
  if (!txid) throw new VaultError('no-transaction', 'Reclaim produced no transaction')
  return { txid, reclaimed: coins.length, satoshis: totalSats }
}


// ── withdraw / sweep (shared spend core) ─────────────────────────────────

/**
 * How a spend reaches the vault key: a thunk, read at every point of use.
 *
 * There is only one key and only one script family left, so there is nothing to
 * discriminate on — a withdrawal (tap-unwrapped) and a recovery sweep
 * (mnemonic + passphrase) hand over the same node. What differs is REVOCABILITY,
 * and that is why this is a thunk rather than the node itself.
 *
 * A withdrawal passes `() => handle.hd`, so every read goes back through
 * VaultKeyHandle's getter — the one thing that can refuse. Dereferencing once
 * up front would hand this module a raw node that outlives the ceremony's
 * opinion of it: cancel(), a key detaching, and the retention ceiling
 * (armedAt + 3×) would all become advisory mid-withdrawal, exactly the
 * "a reference the caller already took is beyond its reach" case
 * VaultKeyHandle's docblock warns about. With the thunk, a relock lands on the
 * next derive and unwinds through the abort path below.
 *
 * The sweep wraps its caller-owned node as `() => hd`: no ceremony exists to
 * revoke it, so the thunk is transparent there.
 */
type VaultKeySource = () => HD

/** One selected vault input, resolved against the key that will spend it. */
interface PreparedSpend<T> {
  o: T
  /** BIP32 child index this output's keyID names. */
  index: number
  /** The output's REAL locking script, read from the listed BEEF. */
  lockingScript: LockingScript
}

/**
 * Resolve every selected input's derivation index and prevout script, and
 * prove the key in hand actually opens it.
 *
 * THE WRONG-KEY CHECK, and it runs before the caller reserves, burns, or signs
 * anything: not one createAction has been issued when this throws, so a
 * mismatch costs no reservation to unwind and no deposit index. That matters
 * twice over.
 *
 *  - On a withdrawal it is the "wrong YubiKey" signal: a card enrolled against
 *    a different seed unwraps a different node, whose children hash to
 *    different addresses than the ones these outputs are locked to.
 *  - On the recovery sweep it is the PASSPHRASE-TYPO guard. A mistyped vault
 *    passphrase yields a valid-looking HD node that simply is not this vault's,
 *    so EVERY output mismatches. Without this the sweep would happily build a
 *    transaction signed with the wrong keys — or, worse, a future
 *    "skip what we can't sign" refinement would report an empty vault and let
 *    the user believe their funds were gone. It has to be loud.
 *
 * The comparison is against the script the output is ACTUALLY locked with (out
 * of the BEEF the same listOutputs call returned), never a script rebuilt from
 * the output's own customInstructions — a rebuild is self-consistent by
 * construction and can never disagree with itself.
 *
 * `getHd()` is called per input rather than once: a relock partway through
 * refuses on the next input instead of quietly finishing the pass with a key
 * the ceremony has already declared dead. Nothing has been reserved yet, so
 * that refusal costs nothing at all.
 */
function prepareSpends<T extends { outpoint: string; satoshis: number; ci: VaultInstructions }>(
  selected: T[],
  getHd: VaultKeySource,
  beefBytes?: number[]
): PreparedSpend<T>[] {
  const sources = beefBytes?.length ? Beef.fromBinary(beefBytes) : undefined
  return selected.map(o => {
    const index = indexFromKeyID(o.ci.keyID)
    if (index == null) throw new VaultError('bad-derivation-index', `Not a BIP32 vault output: ${o.ci.keyID}`)

    const [txid, voutStr] = o.outpoint.split('.')
    // Beef indexes by exact txid string; storage writes lowercase, but so does
    // every other txid comparison in this file — match them rather than trust it.
    const lockingScript = sources?.findTxid(txid.toLowerCase())?.tx?.outputs[Number(voutStr)]?.lockingScript
    if (!lockingScript) {
      // Fail closed rather than sign blind: without the prevout script there is
      // nothing to check the derived child against — and createAction would
      // refuse this input moments later anyway (see the listOutputs comment).
      throw new VaultError('no-transaction', `No source transaction for vault output ${o.outpoint}`)
    }

    const mine = buildVaultLockingScript({ k1PublicKeyHash: depositPubKeyHash(getHd(), index) })
    if (mine.toHex() !== lockingScript.toHex()) {
      throw new VaultError(
        'wrong-key',
        'This vault output was locked to a different key — wrong YubiKey, or wrong vault passphrase'
      )
    }
    return { o, index, lockingScript }
  })
}

async function spendVaultOutputs(
  w: VaultWallet,
  adminOriginator: string,
  amount: number | 'all',
  reason: string,
  getHd: VaultKeySource,
  opts: { revaultRemainder: boolean } & VaultTransferOptions
): Promise<VaultSpendResult> {
  // Announce work BEFORE starting it, then hand the JS thread back once so
  // React can actually paint the sheet. listOutputs and createAction both cross
  // the bridge and touch the database; without this yield the phase change is
  // queued behind that work and the user stares at a frozen screen anyway.
  noteVaultProgress({ phase: 'preparing' })
  await new Promise<void>(resolve => setTimeout(resolve, 0))

  // `include: 'entire transactions'` IS required, and for two reasons.
  //
  // The first is structural: every input here carries unlockingScriptLength but
  // no unlockingScript, so @bsv/sdk's validateCreateActionArgs sets
  // isSignAction=true for this createAction call. buildSignableTransaction
  // then resolves each input's sourceTransaction ONLY from args.inputBEEF
  // (buildSignableTransaction.js:14,101) — trustSelf and storage's own
  // "known input" shortcut (storage/methods/createAction.js's
  // localKnownInputTxids) are a STORAGE-side allowance to skip merkle-proof
  // verification, not a substitute for the client supplying inputBEEF at all.
  // Omit it and createAction.js's makeSignableTransactionBeef throws
  // WERR_INTERNAL('Every signableTransaction input must have a
  // sourceTransaction') on the very first input, before signing ever starts.
  // (reclaimStagingOutputs is in the same boat, not exempt from it: its
  // staging inputs also carry an unlockingScriptLength with no
  // unlockingScript, so isSignAction is true there too. It needs no separate
  // note here because it already threads `staged.BEEF` through as inputBEEF
  // for exactly this reason.)
  //
  // The second is the wrong-key check below: the BEEF is where each vault
  // output's REAL locking script comes from, which is what the derived child
  // is compared against. `include` is one-of ('locking scripts' OR 'entire
  // transactions' — see the SDK's validateListOutputsArgs), so this call
  // cannot ask for both, and the BEEF is the one that is mandatory anyway.
  //
  // Under K1 the whole payload is ordinary-sized — a vault source transaction
  // is a few hundred bytes, not the ~1.83 MB per input the R1-K1 script cost.
  // includeCustomInstructions IS also required: listOutputs omits that field
  // unless asked, and without it every output filters out as unreadable.
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

  // Bounded input count — see VAULT_MAX_INPUTS for what the bound is defending
  // against now that the scripts are 25/~107 bytes rather than ~960 KB.
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

  // Resolve every selected input against the key in hand BEFORE anything is
  // reserved, burned, or signed — see prepareSpends.
  const prepared = prepareSpends(selected, getHd, list.BEEF)

  const outputs: unknown[] = []
  const remainder = acc - want
  // A sub-floor remainder is folded into the withdrawal rather than re-vaulted:
  // an output below VAULT_DEPOSIT_MIN is not worth what it costs to move. It
  // still reaches the user — as part of the toolbox's own default-basket
  // change alongside the withdrawn amount — it is just not re-vaulted.
  //
  // The SAME node the inputs were checked against locks it: one tap covers a
  // withdrawal and its own change output, and a wrong-key failure above has
  // already aborted without burning an index here. Read through the thunk (and
  // BEFORE takeNextIndex, inside nextDepositTarget) so a relock at this instant
  // refuses without burning an index either.
  if (opts.revaultRemainder && remainder >= VAULT_DEPOSIT_MIN) {
    const target = await nextDepositTarget(getHd())
    outputs.push({
      satoshis: remainder,
      lockingScript: target.lockingScript,
      outputDescription: 'Vault change',
      basket: VAULT_BASKET,
      customInstructions: encodeVaultInstructions(target.instructions),
      tags: ['vault']
    })
  }

  const caArgs = {
    description: reason,
    inputs: selected.map(o => ({
      outpoint: o.outpoint,
      unlockingScriptLength: K1_UNLOCK_LEN,
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
    const spends: Record<number, { unlockingScript: string }> = {}

    // SEQUENTIAL BY DESIGN, still — do not "simplify" this into an
    // unlockingScriptTemplate + tx.sign(). @bsv/sdk's Transaction.sign() fans
    // every template's sign() out through Promise.all
    // (dist/cjs/src/transaction/Transaction.js) and takes ownership of the
    // whole input set; this loop keeps each input's script ours to build, in a
    // known order, with the derived key never leaving the iteration that used
    // it. The yield is what keeps the JS thread from disappearing for the
    // length of the loop: one ECDSA signature is fast, but the preimage is
    // re-formatted over the entire transaction for every input, so the cost
    // grows with the square of the input count.
    //
    // getHd() per input, never hoisted: the loop yields between inputs, so a
    // cancel(), a detached key, or the retention ceiling can land BETWEEN two
    // signatures. Reading through the thunk turns that into a refusal on the
    // next input, which unwinds into the catch below and aborts the reservation
    // — a half-signed `spends` map never reaches signAction.
    for (let i = 0; i < prepared.length; i++) {
      await new Promise<void>(resolve => setTimeout(resolve, 0))

      const { o, index, lockingScript } = prepared[i]
      const unlocker = new P2PKH().unlock(
        depositPrivKey(getHd(), index),
        'all',
        false,
        o.satoshis,
        lockingScript
      )
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

/**
 * Withdraw from the vault. ONE tap covers the whole transaction — every input
 * AND the re-vaulted remainder derive from the same unwrapped node — and the
 * key is always released in a finally: on iOS that is what dismisses the
 * system NFC sheet, and it must fire whether the withdrawal succeeds, fails to
 * build, or fails to sign.
 */
export async function withdrawFromVault(
  w: VaultWallet,
  adminOriginator: string,
  amount: number | 'all',
  reason: string,
  opts?: VaultTransferOptions
): Promise<VaultSpendResult> {
  // Before the ceremony: no key prompt for a transfer that cannot proceed.
  await requireOnline(opts)
  const handle = await requestVaultKey(reason)
  try {
    // A THUNK, not `handle.hd` — see VaultKeySource. The spend reads it afresh
    // at every derive and every signature, so each read goes back through the
    // handle's getter and a relock (cancel, key detached, retention ceiling)
    // refuses on the next one. A normal withdrawal finishes inside the armed
    // window, but the ceiling makes that expected rather than guaranteed, so
    // "finishes in time" is not something this code may assume: a relock
    // mid-spend surfaces as key-removed-mid-op and unwinds through
    // spendVaultOutputs' abort path, leaving no reservation behind. Nothing is
    // stored here either way — the thunk closes over the handle, which dies
    // with this call.
    return await spendVaultOutputs(w, adminOriginator, amount, reason, () => handle.hd, {
      revaultRemainder: true,
      ...opts
    })
  } finally {
    handle.release()
  }
}

/**
 * Recovery for a lost YubiKey: sweep the ENTIRE vault to the default basket,
 * signing with the HD node derived from the main mnemonic + vault passphrase.
 *
 * The same key the tap would have unwrapped, reached the other way — so this
 * needs no card, no ceremony, and no device-local vault state at all. A
 * mistyped passphrase is caught by prepareSpends, loudly. Returns null when
 * the vault is already empty.
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
    // The node is the caller's own and no ceremony can revoke it, so the thunk
    // is transparent here — it exists for the withdrawal's handle (see
    // VaultKeySource).
    return await spendVaultOutputs(w, adminOriginator, 'all', reason, () => hd, {
      revaultRemainder: false,
      ...opts
    })
  } catch (e) {
    if (e instanceof VaultError && e.code === 'vault-empty') return null
    throw e
  }
}
