/**
 * Vault transfers — internal movements between the `default` change basket and
 * the `admin vault` basket.
 *
 * Deposit: an ordinary wallet payment whose output is P2PKH-locked to a
 * privileged-derived vault key and tagged into the `admin vault` basket. Funded
 * and change-managed by the toolbox from the default basket. No YubiKey.
 *
 * Withdraw: spend selected vault UTXOs; the toolbox returns their value (minus
 * fee, minus any re-vaulted remainder) as change into the default basket — that
 * change IS the internal transfer. Vault inputs are locked to privileged keys
 * the toolbox's own signer cannot derive, so we sign them ourselves via the
 * wallet's privileged createSignature (which runs the YubiKey ceremony through
 * the PrivilegedKeyManager) and finalize with signAction.
 *
 * The `admin vault` basket name is admin-reserved: WalletPermissionsManager
 * blocks any non-admin originator (web pages) from listing, inserting into, or
 * relinquishing it. All calls here use the admin originator.
 *
 * SECURITY: no key material passes through this module — signing happens inside
 * the wallet/PKM; we only ever hold hashes, public keys, and signatures.
 */
import {
  P2PKH,
  PublicKey,
  PrivateKey,
  KeyDeriver,
  Transaction,
  TransactionSignature,
  UnlockingScript,
  Hash,
  Utils,
  ECDSA,
  BigNumber,
  HD,
  WalletProtocol
} from '@bsv/sdk'
import { vaultStore } from './vaultStore'
import { VaultError } from './types'
import { bip32KeyID, indexFromKeyID, depositPkhFromXpub, depositPrivKey } from './vaultDerivation'

export const VAULT_BASKET = 'admin vault'
export const VAULT_PROTOCOL: WalletProtocol = [2, 'vault']
const DEPOSIT_QUEUE_TARGET = 64
const DUST_LIMIT = 546
const P2PKH_UNLOCK_LEN = 108
const SIGHASH_SCOPE = TransactionSignature.SIGHASH_ALL | TransactionSignature.SIGHASH_FORKID

/** The subset of the wallet interface transfers depends on (injected so the
 * whole module is testable without the toolbox). */
export interface VaultWallet {
  createAction(args: unknown, originator: string): Promise<CreateActionResult>
  signAction(args: unknown, originator: string): Promise<{ txid?: string; tx?: number[] }>
  listOutputs(args: unknown, originator: string): Promise<ListOutputsResult>
  getPublicKey(args: unknown, originator: string): Promise<{ publicKey: string }>
  createSignature(args: unknown, originator: string): Promise<{ signature: number[] }>
  abortAction(args: unknown, originator: string): Promise<unknown>
  listActions?(args: unknown, originator: string): Promise<{ actions: { txid?: string; status: string; reference?: string }[] }>
}

interface CreateActionResult {
  txid?: string
  tx?: number[]
  signableTransaction?: { tx: number[]; reference: string }
}
interface ListOutputsResult {
  totalOutputs?: number
  outputs: {
    outpoint: string
    satoshis: number
    lockingScript?: string
    customInstructions?: string
  }[]
  BEEF?: number[]
}

// ── helpers ───────────────────────────────────────────────────────────────

/**
 * Reserve the next deposit address.
 *
 * v2 derives it from the stored xpub on demand — no YubiKey, no ceiling.
 * v1 pops the legacy precomputed queue, which fails closed once drained and
 * needs a privileged ceremony to refill.
 */
async function nextDepositKey(): Promise<{ keyID: string; pkh: string }> {
  const meta = await vaultStore.getMeta()
  if (!meta) throw new VaultError('not-enrolled', 'Vault is not set up')

  if (meta.v === 2) {
    const index = await vaultStore.takeNextIndex()
    if (index == null) throw new VaultError('not-enrolled', 'Vault is not set up')
    return { keyID: bip32KeyID(index), pkh: depositPkhFromXpub(meta.xpub, index) }
  }

  const key = await vaultStore.popDepositKey()
  if (!key) throw new VaultError('pin-required', 'Vault needs your key to mint a fresh deposit address')
  return key
}

function keyIDFromInstructions(ci?: string): string | null {
  if (!ci) return null
  try {
    const parsed = JSON.parse(ci) as { keyID?: string }
    return parsed.keyID ?? null
  } catch {
    return null
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

/**
 * Build the P2PKH unlocking script for one vault input.
 *
 * `sign(hashToDirectlySign)` must return the DER signature of the given 32-byte
 * digest under the vault key for `keyID` — i.e. the wallet's privileged
 * createSignature. We reproduce exactly what P2PKH.unlock does internally
 * (`ECDSA over sha256(sha256(preimage))`), then append the sighash scope byte
 * and push the compressed pubkey.
 */
export async function buildVaultUnlockingScript(params: {
  tx: Transaction
  inputIndex: number
  sourceTXID: string
  sourceOutputIndex: number
  sourceSatoshis: number
  sourceLockingScript: import('@bsv/sdk').LockingScript
  publicKeyHex: string
  sign: (hashToDirectlySign: number[]) => Promise<number[]>
}): Promise<UnlockingScript> {
  const preimage = TransactionSignature.format({
    sourceTXID: params.sourceTXID,
    sourceOutputIndex: params.sourceOutputIndex,
    sourceSatoshis: params.sourceSatoshis,
    transactionVersion: params.tx.version,
    otherInputs: params.tx.inputs.filter((_, i) => i !== params.inputIndex),
    outputs: params.tx.outputs,
    inputIndex: params.inputIndex,
    subscript: params.sourceLockingScript,
    inputSequence: params.tx.inputs[params.inputIndex].sequence ?? 0xffffffff,
    lockTime: params.tx.lockTime,
    scope: SIGHASH_SCOPE
  })
  const digest = Hash.sha256(Hash.sha256(preimage))
  const der = await params.sign(digest)
  const sigForScript = [...der, SIGHASH_SCOPE]
  const pubkeyForScript = PublicKey.fromString(params.publicKeyHex).encode(true) as number[]
  return new UnlockingScript([
    { op: sigForScript.length, data: sigForScript },
    { op: pubkeyForScript.length, data: pubkeyForScript }
  ])
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
  if (satoshis < DUST_LIMIT) throw new VaultError('below-dust', 'Deposit below dust limit')
  const key = await nextDepositKey()
  const lockingScript = new P2PKH().lock(Utils.toArray(key.pkh, 'hex')).toHex()
  const res = await w.createAction(
    {
      description: 'Move to vault',
      outputs: [
        {
          satoshis,
          lockingScript,
          outputDescription: 'Vault deposit',
          basket: VAULT_BASKET,
          customInstructions: JSON.stringify({ v: 1, keyID: key.keyID }),
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

/** Per-vault-key signer + public-key resolver. `withdrawFromVault` supplies the
 * privileged (ceremony-backed) implementations; `sweepVaultWithKey` supplies
 * ones that derive locally from a recovery-phrase key (no YubiKey). */
interface VaultSigner {
  getPublicKey(keyID: string): Promise<string>
  sign(keyID: string, digest: number[]): Promise<number[]>
}

async function spendVaultOutputs(
  w: VaultWallet,
  adminOriginator: string,
  amount: number | 'all',
  reason: string,
  signer: VaultSigner,
  opts: { revaultRemainder: boolean }
): Promise<{ txid: string }> {
  const list = await w.listOutputs(
    // includeCustomInstructions is REQUIRED: each vault output carries its
    // derivation keyID in customInstructions, and listOutputs omits that field
    // unless asked (BooleanDefaultFalse). Without it every output filters out as
    // keyless and the vault looks empty even when funded.
    { basket: VAULT_BASKET, include: 'entire transactions', includeCustomInstructions: true, limit: 1000 },
    adminOriginator
  )
  const spendable = list.outputs
    .map(o => ({ ...o, keyID: keyIDFromInstructions(o.customInstructions) }))
    .filter(o => o.keyID != null)
    .sort((a, b) => a.outpoint.localeCompare(b.outpoint)) // deterministic, oldest-first-ish
  if (spendable.length === 0) throw new VaultError('vault-empty', 'Vault is empty')

  const total = spendable.reduce((s, o) => s + o.satoshis, 0)
  const want = amount === 'all' ? total : amount
  if (want > total) throw new VaultError('amount-exceeds-balance', 'Withdrawal exceeds vault balance')

  // Select oldest-first until the target is covered.
  const selected: typeof spendable = []
  let acc = 0
  for (const o of spendable) {
    if (amount !== 'all' && acc >= want) break
    selected.push(o)
    acc += o.satoshis
  }

  // Partial withdrawal: re-vault the remainder to a fresh deposit key so the
  // leftover stays protected instead of returning to the default basket.
  // (Sweep/recovery empties everything to default and never re-vaults.)
  const outputs: unknown[] = []
  const remainder = amount === 'all' ? 0 : acc - want
  if (opts.revaultRemainder && remainder >= DUST_LIMIT) {
    const revaultKey = await nextDepositKey()
    outputs.push({
      satoshis: remainder,
      lockingScript: new P2PKH().lock(Utils.toArray(revaultKey.pkh, 'hex')).toHex(),
      outputDescription: 'Vault change',
      basket: VAULT_BASKET,
      customInstructions: JSON.stringify({ v: 1, keyID: revaultKey.keyID }),
      tags: ['vault']
    })
  }

  // Use storage's own BEEF for the source transactions. listOutputs('entire
  // transactions') returns a COMPLETE, verifiable BEEF: a confirmed deposit
  // carries its merkle proof, an unconfirmed one carries its ancestry back to
  // proven roots (its source txs are already tracked in our storage). We do not
  // strip or hand-craft it — that was only a workaround for the chain-tracker bug
  // (it rejected a valid proof), now fixed. This spends confirmed AND unconfirmed
  // deposits and needs no `returnTXIDOnly`/delayed hacks.
  const inputBEEF = list.BEEF?.length ? list.BEEF : undefined

  const caArgs = {
    description: reason,
    inputBEEF,
    inputs: selected.map(o => ({
      outpoint: o.outpoint,
      unlockingScriptLength: P2PKH_UNLOCK_LEN,
      inputDescription: 'Vault withdrawal'
    })),
    outputs,
    labels: ['vault', 'vault-withdraw'],
    // trustSelf:'known' lets storage vouch for its own known input txids.
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
    console.log('[vault] double-spend review — competing=%s aborted=%d, retrying', competing.join(',') || '(none reported)', freed)
    if (freed === 0) throw e
    created = await w.createAction(caArgs, adminOriginator)
  }
  console.log('[vault] withdraw createAction ok · signable=%s · inputs=%d', !!created.signableTransaction, selected.length)

  if (!created.signableTransaction) {
    const txid = created.txid ?? (created.tx ? Transaction.fromAtomicBEEF(created.tx).id('hex') : undefined)
    if (!txid) throw new VaultError('no-transaction', 'Withdrawal produced no transaction')
    return { txid }
  }

  const { tx: atomic, reference } = created.signableTransaction
  try {
    const tx = Transaction.fromAtomicBEEF(atomic)
    const spends: Record<number, { unlockingScript: string }> = {}
    for (let i = 0; i < selected.length; i++) {
      const o = selected[i]
      console.log('[vault] withdraw signing input %d · keyID=%s', i, o.keyID)
      const publicKey = await signer.getPublicKey(o.keyID as string)
      console.log('[vault] input %d · pubkey ok', i)
      const [txidHex, voutStr] = o.outpoint.split('.')
      const unlock = await buildVaultUnlockingScript({
        tx,
        inputIndex: i,
        sourceTXID: txidHex,
        sourceOutputIndex: Number(voutStr),
        sourceSatoshis: o.satoshis,
        sourceLockingScript: new P2PKH().lock(PublicKey.fromString(publicKey).toHash() as number[]),
        publicKeyHex: publicKey,
        sign: digest => signer.sign(o.keyID as string, digest)
      })
      console.log('[vault] input %d · unlock built', i)
      spends[i] = { unlockingScript: unlock.toHex() }
    }

    console.log('[vault] calling signAction · spends=%d · ref=%s', Object.keys(spends).length, reference)
    const signed = await w.signAction(
      { reference, spends, options: { acceptDelayedBroadcast: false } },
      adminOriginator
    )
    const txid = signed.txid ?? (signed.tx ? Transaction.fromAtomicBEEF(signed.tx).id('hex') : undefined)
    console.log('[vault] signAction done · txid=%s', txid)
    if (!txid) throw new VaultError('no-transaction', 'Withdrawal was not broadcast')
    return { txid }
  } catch (e) {
    console.error('[vault] spend FAILED:', e instanceof Error ? e.message : e, e)
    await w.abortAction({ reference }, adminOriginator).catch(() => {})
    throw e
  }
}

/** Withdraw from the vault via the YubiKey ceremony (privileged signing). */
export function withdrawFromVault(
  w: VaultWallet,
  adminOriginator: string,
  amount: number | 'all',
  reason: string
): Promise<{ txid: string }> {
  const signer: VaultSigner = {
    getPublicKey: async keyID => {
      const { publicKey } = await w.getPublicKey(
        { protocolID: VAULT_PROTOCOL, keyID, counterparty: 'self', forSelf: true, privileged: true, privilegedReason: reason },
        adminOriginator
      )
      return publicKey
    },
    sign: async (keyID, digest) => {
      const { signature } = await w.createSignature(
        { hashToDirectlySign: digest, protocolID: VAULT_PROTOCOL, keyID, counterparty: 'self', privileged: true, privilegedReason: reason },
        adminOriginator
      )
      return signature
    }
  }
  return spendVaultOutputs(w, adminOriginator, amount, reason, signer, { revaultRemainder: true })
}

/**
 * Signer for v2 outputs, which are plain BIP32 children of the vault node
 * rather than BRC-42 derivations. Used by both the ceremony withdrawal (HD
 * unsealed from the YubiKey) and the passphrase recovery sweep.
 */
export function hdVaultSigner(hd: HD): VaultSigner {
  const childFor = (keyID: string): PrivateKey => {
    const index = indexFromKeyID(keyID)
    if (index == null) {
      // A v1 'vault/<n>' output cannot be signed by an HD node. Failing loudly
      // beats signing with the wrong key and broadcasting an invalid spend.
      throw new VaultError('bad-derivation-index', `Not a BIP32 vault output: ${keyID}`)
    }
    return depositPrivKey(hd, index)
  }
  return {
    getPublicKey: async keyID => childFor(keyID).toPublicKey().toString(),
    sign: async (keyID, digest) =>
      ECDSA.sign(new BigNumber(digest), childFor(keyID), true).toDER() as number[]
  }
}

/**
 * Recovery path for v2: sweep the ENTIRE vault to the default basket, signing
 * with the HD node derived from the main mnemonic + vault passphrase. No
 * YubiKey required — this is the second of the two recovery paths.
 *
 * Returns null when the vault is already empty.
 */
export async function sweepVaultWithHD(
  w: VaultWallet,
  adminOriginator: string,
  hd: HD,
  reason: string
): Promise<{ txid: string } | null> {
  try {
    return await spendVaultOutputs(w, adminOriginator, 'all', reason, hdVaultSigner(hd), {
      revaultRemainder: false
    })
  } catch (e) {
    if (e instanceof VaultError && e.code === 'vault-empty') return null
    throw e
  }
}

/** Recovery path: sweep the ENTIRE vault to the default basket signing with the
 * backup-phrase key `V` directly — no YubiKey required (the whole reason the
 * phrase exists). Returns null when the vault is already empty. */
export async function sweepVaultWithKey(
  w: VaultWallet,
  adminOriginator: string,
  v: PrivateKey,
  reason: string
): Promise<{ txid: string } | null> {
  const kd = new KeyDeriver(v)
  const signer: VaultSigner = {
    getPublicKey: async keyID => kd.derivePublicKey(VAULT_PROTOCOL, keyID, 'self', true).toString(),
    sign: async (keyID, digest) => {
      const priv = kd.derivePrivateKey(VAULT_PROTOCOL, keyID, 'self')
      return ECDSA.sign(new BigNumber(digest), priv, true).toDER() as number[]
    }
  }
  try {
    return await spendVaultOutputs(w, adminOriginator, 'all', reason, signer, { revaultRemainder: false })
  } catch (e) {
    if (e instanceof VaultError && e.code === 'vault-empty') return null
    throw e
  }
}

// ── deposit-key replenishment (ceremony.onArmed hook) ────────────────────

export async function replenishDepositKeys(w: VaultWallet, adminOriginator: string): Promise<void> {
  const meta = await vaultStore.getMeta()
  if (!meta) return
  // v2 derives deposit addresses from the xpub on demand, so there is no queue
  // to refill and this ceremony hook is a no-op.
  if (meta.v !== 1) return
  const need = DEPOSIT_QUEUE_TARGET - meta.depositKeys.length
  if (need <= 0) return
  const fresh: { keyID: string; pkh: string }[] = []
  for (let i = 0; i < need; i++) {
    const keyID = `vault/${meta.nextKeyIndex + i}`
    const { publicKey } = await w.getPublicKey(
      { protocolID: VAULT_PROTOCOL, keyID, counterparty: 'self', forSelf: true, privileged: true, privilegedReason: 'Prepare vault deposit addresses' },
      adminOriginator
    )
    fresh.push({ keyID, pkh: PublicKey.fromString(publicKey).toHash('hex') as string })
  }
  await vaultStore.pushDepositKeys(fresh, meta.nextKeyIndex + need)
}
