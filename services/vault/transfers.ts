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
  Transaction,
  TransactionSignature,
  UnlockingScript,
  Hash,
  Utils,
  WalletProtocol
} from '@bsv/sdk'
import { vaultStore } from './vaultStore'
import { VaultError } from './types'

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

function keyIDFromInstructions(ci?: string): string | null {
  if (!ci) return null
  try {
    const parsed = JSON.parse(ci) as { keyID?: string }
    return parsed.keyID ?? null
  } catch {
    return null
  }
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
  if (satoshis < DUST_LIMIT) throw new VaultError('seal-corrupt', 'Deposit below dust limit')
  const key = await vaultStore.popDepositKey()
  if (!key) throw new VaultError('pin-required', 'Vault needs your key to mint a fresh deposit address')

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
  if (!txid) throw new VaultError('seal-corrupt', 'Deposit produced no transaction')
  return { txid }
}

// ── withdraw ────────────────────────────────────────────────────────────

export async function withdrawFromVault(
  w: VaultWallet,
  adminOriginator: string,
  amount: number | 'all',
  reason: string
): Promise<{ txid: string }> {
  const list = await w.listOutputs(
    { basket: VAULT_BASKET, include: 'entire transactions', limit: 1000 },
    adminOriginator
  )
  const spendable = list.outputs
    .map(o => ({ ...o, keyID: keyIDFromInstructions(o.customInstructions) }))
    .filter(o => o.keyID != null)
    .sort((a, b) => a.outpoint.localeCompare(b.outpoint)) // deterministic, oldest-first-ish
  if (spendable.length === 0) throw new VaultError('seal-corrupt', 'Vault is empty')

  const total = spendable.reduce((s, o) => s + o.satoshis, 0)
  const want = amount === 'all' ? total : amount
  if (want > total) throw new VaultError('seal-corrupt', 'Withdrawal exceeds vault balance')

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
  const outputs: unknown[] = []
  const remainder = amount === 'all' ? 0 : acc - want
  if (remainder >= DUST_LIMIT) {
    const revaultKey = await vaultStore.popDepositKey()
    if (!revaultKey) throw new VaultError('pin-required', 'Vault needs your key to mint a change address')
    outputs.push({
      satoshis: remainder,
      lockingScript: new P2PKH().lock(Utils.toArray(revaultKey.pkh, 'hex')).toHex(),
      outputDescription: 'Vault change',
      basket: VAULT_BASKET,
      customInstructions: JSON.stringify({ v: 1, keyID: revaultKey.keyID }),
      tags: ['vault']
    })
  }

  const created = await w.createAction(
    {
      description: reason,
      inputBEEF: list.BEEF,
      inputs: selected.map(o => ({
        outpoint: o.outpoint,
        unlockingScriptLength: P2PKH_UNLOCK_LEN,
        inputDescription: 'Vault withdrawal'
      })),
      outputs,
      labels: ['vault', 'vault-withdraw'],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
    },
    adminOriginator
  )

  if (!created.signableTransaction) {
    // Nothing to sign (shouldn't happen with deferred inputs) — treat as done.
    const txid = created.txid ?? (created.tx ? Transaction.fromAtomicBEEF(created.tx).id('hex') : undefined)
    if (!txid) throw new VaultError('seal-corrupt', 'Withdrawal produced no transaction')
    return { txid }
  }

  const { tx: atomic, reference } = created.signableTransaction
  try {
    const tx = Transaction.fromAtomicBEEF(atomic)
    const spends: Record<number, { unlockingScript: string }> = {}
    for (let i = 0; i < selected.length; i++) {
      const o = selected[i]
      const { publicKey } = await w.getPublicKey(
        { protocolID: VAULT_PROTOCOL, keyID: o.keyID, counterparty: 'self', forSelf: true, privileged: true, privilegedReason: reason },
        adminOriginator
      )
      const [txidHex, voutStr] = o.outpoint.split('.')
      const unlock = await buildVaultUnlockingScript({
        tx,
        inputIndex: i,
        sourceTXID: txidHex,
        sourceOutputIndex: Number(voutStr),
        sourceSatoshis: o.satoshis,
        sourceLockingScript: new P2PKH().lock(PublicKey.fromString(publicKey).toHash() as number[]),
        publicKeyHex: publicKey,
        sign: async digest => {
          const { signature } = await w.createSignature(
            {
              hashToDirectlySign: digest,
              protocolID: VAULT_PROTOCOL,
              keyID: o.keyID,
              counterparty: 'self',
              privileged: true,
              privilegedReason: reason
            },
            adminOriginator
          )
          return signature
        }
      })
      spends[i] = { unlockingScript: unlock.toHex() }
    }

    const signed = await w.signAction(
      { reference, spends, options: { acceptDelayedBroadcast: false } },
      adminOriginator
    )
    const txid = signed.txid ?? (signed.tx ? Transaction.fromAtomicBEEF(signed.tx).id('hex') : undefined)
    if (!txid) throw new VaultError('seal-corrupt', 'Withdrawal was not broadcast')
    return { txid }
  } catch (e) {
    await w.abortAction({ reference }, adminOriginator).catch(() => {})
    throw e
  }
}

// ── deposit-key replenishment (ceremony.onArmed hook) ────────────────────

export async function replenishDepositKeys(w: VaultWallet, adminOriginator: string): Promise<void> {
  const meta = await vaultStore.getMeta()
  if (!meta) return
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
