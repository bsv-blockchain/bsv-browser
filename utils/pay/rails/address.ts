/**
 * The address rail — payments to and from conventional wallets.
 *
 * This is the only bridge between this wallet and the rest of the ecosystem,
 * so every line here is a straight port from app/legacy-payments.tsx. The
 * derivation in particular is load-bearing in a way that is easy to miss: the
 * key ID is `base64(YYYY-MM-DD) + ' ' + base64('legacy')`, so the date string
 * IS part of the private key path. Any change to how that string is produced
 * makes previously-issued addresses — and the money sitting on them —
 * unreachable. getCurrentDate's local-time/UTC mix is therefore deliberate and
 * must not be "corrected".
 */
import {
  Beef,
  P2PKH,
  PrivateKey,
  PublicKey,
  Utils,
  type InternalizeActionArgs,
  type InternalizeOutput,
  type WalletProtocol
} from '@bsv/sdk'
import type { AppChain } from '@/context/config'
import { isValidBsvAddress } from '@/utils/pay/rails'

export const BRC29_PROTOCOL_ID: WalletProtocol = [2, '3241645161d8']

export const LEGACY_DERIVATION_SUFFIX = Utils.toBase64(Utils.toArray('legacy', 'utf8'))

/**
 * How far back the manual recovery stepper may reach. The background sweeper
 * has its own, much tighter bound (see utils/pay/watchlist.ts): this one exists
 * because an address a payer sat on for three weeks still holds real money.
 */
export const MAX_RECOVERY_DAYS = 30

/**
 * Verbatim from legacy-payments.tsx. `setDate` on a local Date then
 * `toISOString()` — the mix is what previously-issued addresses were derived
 * with, so it stays. `now` is injectable for tests only; production always
 * takes the default.
 */
export const getCurrentDate = (daysOffset: number, now: Date = new Date()): string => {
  const today = new Date(now.getTime())
  today.setDate(today.getDate() - daysOffset)
  return today.toISOString().split('T')[0]
}

export function derivationPrefixFor(date: string): string {
  return Utils.toBase64(Utils.toArray(date, 'utf8'))
}

/** One ASCII space. The wallet derives a different key for any other separator. */
export function legacyKeyId(derivationPrefix: string): string {
  return `${derivationPrefix} ${LEGACY_DERIVATION_SUFFIX}`
}

export interface WocConfig {
  apiBase: string
  segment: string
  network: 'mainnet' | 'testnet'
}

export function wocConfigFor(network: AppChain): WocConfig {
  return {
    main: { apiBase: 'https://api.whatsonchain.com', segment: 'main', network: 'mainnet' as const },
    test: { apiBase: 'https://api.whatsonchain.com', segment: 'test', network: 'testnet' as const },
    teratest: { apiBase: 'https://api.woc-ttn.bsvblockchain.tech', segment: 'test', network: 'testnet' as const }
  }[network]
}

export interface AddressDerivingWallet {
  getPublicKey(args: unknown, originator?: string): Promise<{ publicKey: string }>
}

export async function getPaymentAddress(
  wallet: AddressDerivingWallet,
  adminOriginator: string,
  derivationPrefix: string,
  network: 'mainnet' | 'testnet'
): Promise<string> {
  const { publicKey } = await wallet.getPublicKey(
    {
      protocolID: BRC29_PROTOCOL_ID,
      keyID: legacyKeyId(derivationPrefix),
      counterparty: 'anyone',
      forSelf: true
    },
    adminOriginator
  )
  return PublicKey.fromString(publicKey).toAddress(network)
}

export interface Utxo {
  txid: string
  vout: number
  satoshis: number
}

export interface ProcessedTx {
  txid: string
  satoshis: number
  status: string
  importedAt: Date | null
}

export interface AddressRailWallet extends AddressDerivingWallet {
  listActions(args: unknown, originator?: string): Promise<{ actions: any[] }>
  internalizeAction(args: unknown, originator?: string): Promise<{ accepted?: boolean } | undefined>
  createAction(args: unknown, originator?: string): Promise<unknown>
}

export async function getUtxosForAddress(woc: WocConfig, address: string): Promise<Utxo[]> {
  const response = await fetch(`${woc.apiBase}/v1/bsv/${woc.segment}/address/${address}/unspent/all`)
  const rp = await response.json()
  return rp.result
    .filter((r: any) => r.isSpentInMempoolTx === false)
    .map((r: any) => ({ txid: r.tx_hash, vout: r.tx_pos, satoshis: r.value }))
}

/**
 * Outputs this wallet has already internalized for `address`, keyed
 * `txid.outputIndex`. The address itself is the action label, which is why the
 * label list in sweepAddress below must keep carrying it.
 *
 * A read failure returns an empty set rather than throwing: the caller's next
 * step is internalizeAction, which is idempotent per output, so the cost of a
 * false "nothing imported" is a rejected duplicate — while a throw here would
 * strand real money behind a transient database error.
 */
export async function getInternalizedUtxos(
  wallet: AddressRailWallet,
  adminOriginator: string,
  address: string
): Promise<Set<string>> {
  try {
    const response = await wallet.listActions(
      { labels: [address], labelQueryMode: 'all', includeOutputs: true, limit: 1000 },
      adminOriginator
    )
    const set = new Set<string>()
    for (const action of response.actions) {
      if (action.outputs) {
        for (const output of action.outputs) {
          if (action.txid) set.add(`${action.txid}.${output.outputIndex}`)
        }
      }
    }
    return set
  } catch {
    return new Set()
  }
}

export function availableUtxos(all: Utxo[], internalized: Set<string>): Utxo[] {
  return all.filter(u => !internalized.has(`${u.txid}.${u.vout}`))
}

export async function fetchBalance(
  wallet: AddressRailWallet,
  adminOriginator: string,
  woc: WocConfig,
  address: string
): Promise<number> {
  const all = await getUtxosForAddress(woc, address)
  const internalized = await getInternalizedUtxos(wallet, adminOriginator, address)
  return availableUtxos(all, internalized).reduce((acc, u) => acc + u.satoshis, 0)
}

export async function getProcessedTransactions(
  wallet: AddressRailWallet,
  adminOriginator: string,
  address: string
): Promise<ProcessedTx[]> {
  try {
    const response = await wallet.listActions(
      { labels: [address], labelQueryMode: 'all', includeLabels: true, includeOutputs: true, limit: 1000 },
      adminOriginator
    )
    return response.actions
      .map((action: any) => {
        const totalSats = action.outputs
          ? action.outputs.reduce((sum: number, o: any) => sum + o.satoshis, 0)
          : action.satoshis
        const tsLabel = action.labels?.find((l: string) => l.startsWith('ts:'))
        const importedAt = tsLabel ? new Date(Number(tsLabel.slice(3)) * 1000) : null
        return { txid: action.txid, satoshis: totalSats, status: action.status, importedAt }
      })
      .sort((a: ProcessedTx, b: ProcessedTx) => {
        if (a.importedAt && b.importedAt) return b.importedAt.getTime() - a.importedAt.getTime()
        if (a.importedAt) return -1
        if (b.importedAt) return 1
        return 0
      })
  } catch {
    return []
  }
}

/**
 * The sweep. Ported from legacy-payments.tsx's handleImportFunds with one
 * change and one only: the trigger. Nothing about what it writes moves.
 *
 * The sentinel sender key (PrivateKey(1)'s public key) and the label list are
 * both load-bearing: the labels are how getInternalizedUtxos recognises what
 * has already been imported, and the address label in particular is what makes
 * a second sweep a no-op instead of a double credit.
 */
export async function sweepAddress(args: {
  wallet: AddressRailWallet
  adminOriginator: string
  woc: WocConfig
  address: string
  derivationPrefix: string
  nowSeconds?: number
}): Promise<{ importedSatoshis: number; failureCount: number }> {
  const { wallet, adminOriginator, woc, address, derivationPrefix } = args
  const nowSeconds = args.nowSeconds ?? Math.floor(Date.now() / 1000)

  const all = await getUtxosForAddress(woc, address)
  const internalized = await getInternalizedUtxos(wallet, adminOriginator, address)
  const utxos = availableUtxos(all, internalized)
  if (utxos.length === 0) return { importedSatoshis: 0, failureCount: 0 }

  const beef = new Beef()
  for (const utxo of utxos) {
    if (!beef.findTxid(utxo.txid)) {
      const resp = await fetch(`${woc.apiBase}/v1/bsv/${woc.segment}/tx/${utxo.txid}/beef`)
      const beefHex = await resp.text()
      beef.mergeBeef(Utils.toArray(beefHex, 'hex'))
    }
  }

  const senderIdentityKey = new PrivateKey(1).toPublicKey().toString()
  const txs = beef.txs
    .map(beefTx => {
      const tx = beef.findAtomicTransaction(beefTx.txid)
      const relevant = utxos.filter(o => o.txid === beefTx.txid)
      if (relevant.length === 0) return null
      const outputs: InternalizeOutput[] = relevant.map(o => ({
        outputIndex: o.vout,
        protocol: 'wallet payment' as const,
        paymentRemittance: {
          senderIdentityKey,
          derivationPrefix,
          derivationSuffix: LEGACY_DERIVATION_SUFFIX
        }
      }))
      const internalizeArgs: InternalizeActionArgs = {
        tx: tx!.toAtomicBEEF(),
        description: 'Legacy Bridge Payment',
        outputs,
        labels: ['legacy', 'inbound', 'bsvbrowser', address, `ts:${nowSeconds}`]
      }
      return { args: internalizeArgs, satoshis: relevant.reduce((sum, o) => sum + o.satoshis, 0) }
    })
    .filter(Boolean) as { args: InternalizeActionArgs; satoshis: number }[]

  let importedSatoshis = 0
  let failureCount = 0
  for (const { args: internalizeArgs, satoshis } of txs) {
    try {
      const response = await wallet.internalizeAction(internalizeArgs, adminOriginator)
      if (response?.accepted) importedSatoshis += satoshis
      else failureCount++
    } catch {
      failureCount++
    }
  }
  return { importedSatoshis, failureCount }
}

/**
 * Pay a conventional wallet. The only route out of this wallet to the rest of
 * the ecosystem, so both guards throw before the wallet is touched: an invalid
 * address here is money burned to an unspendable script.
 */
export async function sendToAddress(args: {
  wallet: AddressRailWallet
  adminOriginator: string
  address: string
  satoshis: number
}): Promise<void> {
  const { wallet, adminOriginator, address, satoshis } = args
  const sats = Math.round(Number(satoshis))
  if (!Number.isFinite(sats) || sats <= 0) throw new Error('Invalid amount')
  if (!isValidBsvAddress(address)) throw new Error('Invalid BSV address')
  const lockingScript = new P2PKH().lock(address).toHex()
  await wallet.createAction(
    {
      description: 'Send BSV to address',
      outputs: [{ lockingScript, satoshis: sats, outputDescription: 'BSV for recipient address' }],
      labels: ['legacy', 'outbound']
    },
    adminOriginator
  )
}
