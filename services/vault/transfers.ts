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
import { HD, Transaction, Utils } from '@bsv/sdk'
import { R1K1Wallet } from '@bsv/templates'
import { vaultStore } from './vaultStore'
import { VaultError } from './types'
import { backupAttestation } from './backupAttestation'
import { VaultR1Signer } from './ceremony'
import { noteVaultProgress, requestVaultSigner } from './ceremonyHost'
import { randomBytes } from './random'
import { bip32KeyID, indexFromKeyID, depositPkhFromXpub, depositPrivKey, vaultXpub } from './vaultDerivation'
import {
  R1K1_R1_UNLOCK_LEN,
  R1K1_K1_UNLOCK_LEN,
  buildVaultLockingScript,
  decodeVaultInstructions,
  encodeVaultInstructions,
  VaultInstructions
} from './r1k1'

export const VAULT_BASKET = 'admin vault'

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

/** The subset of the wallet interface transfers depends on (injected so the
 * whole module is testable without the toolbox). */
export interface VaultWallet {
  createAction(args: unknown, originator: string): Promise<CreateActionResult>
  signAction(args: unknown, originator: string): Promise<{ txid?: string; tx?: number[] }>
  listOutputs(args: unknown, originator: string): Promise<ListOutputsResult>
  getPublicKey(args: unknown, originator: string): Promise<{ publicKey: string }>
  abortAction(args: unknown, originator: string): Promise<unknown>
  listActions?(args: unknown, originator: string): Promise<{ actions: { txid?: string; status: string; reference?: string }[] }>
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
 * stuck prior attempt. */
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

/** Abort the specific orphaned transactions still reserving the vault UTXO
 * (identified by txid from the review error). The reserving tx may carry no
 * vault label, so we page ALL actions and match by txid — then abort only those
 * exact txids, which resets their inputs' `spentBy` and frees the coin.
 * Best-effort — returns how many were aborted. */
async function abortReservingTxids(w: VaultWallet, adminOriginator: string, txids: string[]): Promise<number> {
  if (!w.listActions || txids.length === 0) return 0
  const want = new Set(txids)
  // A locally-held reservation is never in a terminal on-chain state; these are
  // the states abortAction accepts, plus 'failed' which also holds inputs.
  const ABORTABLE = new Set(['unsigned', 'nosend', 'nonfinal', 'failed'])
  let aborted = 0
  let scanned = 0
  const matches: string[] = []
  try {
    let offset = 0
    for (let page = 0; page < 25 && aborted < want.size; page++) {
      const res = await w.listActions({ labels: [], limit: 200, offset }, adminOriginator)
      const actions = res.actions ?? []
      if (actions.length === 0) break
      scanned += actions.length
      for (const a of actions) {
        if (a.txid && want.has(a.txid)) {
          matches.push(`${a.status}${a.reference ? '' : '/no-ref'}`)
          if (a.reference && ABORTABLE.has(a.status)) {
            await w.abortAction({ reference: a.reference }, adminOriginator).catch(err =>
              console.log('[vault] abortAction rejected:', (err as Error)?.message)
            )
            aborted++
          }
        }
      }
      offset += actions.length
    }
    console.log('[vault] abort scan · scanned=%d · matches=[%s] · aborted=%d', scanned, matches.join(', ') || 'NONE', aborted)
  } catch (e) {
    console.log('[vault] abort scan error:', (e as Error)?.message)
  }
  return aborted
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
  satoshis: number
): Promise<{ txid: string }> {
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

  const target = await nextDepositTarget()
  const res = await w.createAction(
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
  const txid = res.txid ?? (res.tx ? Transaction.fromAtomicBEEF(res.tx).id('hex') : undefined)
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
  opts: { revaultRemainder: boolean }
): Promise<{ txid: string }> {
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
  const want = amount === 'all' ? total : amount
  if (want > total) throw new VaultError('amount-exceeds-balance', 'Withdrawal exceeds vault balance')

  // Spend EVERY output — there is no input cap. Each input's ~960 KB R1
  // unlocking script (it embeds its own full preimage — see r1k1.ts) is built
  // and signed one at a time (the sequential loop below), which bounds
  // TRANSIENT working memory to roughly one input's worth at a time rather
  // than N in flight together. The final `spends` payload handed to
  // signAction is still O(inputs) in size — that is inherent to the R1
  // script, not something sequencing can avoid — so consolidating the vault
  // toward a single UTXO after each withdrawal is what actually keeps later
  // ones cheap.
  const selected = spendable
  const acc = total

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
    // A prior failed attempt can leave the vault UTXO reserved by an orphaned
    // transaction, surfacing here as a double-spend review. The error names the
    // reserving txids; abort exactly those to free the coin, then retry once.
    if (!isReviewActionsError(e)) throw e
    const competing = competingTxids(e)
    const freed = await abortReservingTxids(w, adminOriginator, competing)
    if (freed === 0) throw e
    created = await w.createAction(caArgs, adminOriginator)
  }

  if (!created.signableTransaction) {
    const txid = created.txid ?? (created.tx ? Transaction.fromAtomicBEEF(created.tx).id('hex') : undefined)
    if (!txid) throw new VaultError('no-transaction', 'Withdrawal produced no transaction')
    return { txid }
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
  return { txid }
}

/** Withdraw via the YubiKey (R1 branch). Arms one signing session for the whole
 * transaction and always releases it in a finally — on iOS that is what
 * dismisses the system NFC sheet, and it must fire whether the withdrawal
 * succeeds, fails to build, or fails to sign. */
export async function withdrawFromVault(
  w: VaultWallet,
  adminOriginator: string,
  amount: number | 'all',
  reason: string
): Promise<{ txid: string }> {
  const signer = await requestVaultSigner(reason)
  try {
    return await spendVaultOutputs(w, adminOriginator, amount, reason, { path: 'r1', signer }, {
      revaultRemainder: true
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
  reason: string
): Promise<{ txid: string } | null> {
  try {
    return await spendVaultOutputs(w, adminOriginator, 'all', reason, { path: 'k1', hd }, {
      revaultRemainder: false
    })
  } catch (e) {
    if (e instanceof VaultError && e.code === 'vault-empty') return null
    throw e
  }
}
