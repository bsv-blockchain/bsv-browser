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
import { PublicKey, Utils, type WalletProtocol } from '@bsv/sdk'
import type { AppChain } from '@/context/config'

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
