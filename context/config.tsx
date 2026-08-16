export type AppChain = 'main' | 'test' | 'teratest'

/**
 * The wallet-toolbox `Chain` type used by @bsv/wallet-toolbox-mobile.
 * Mirrors `Chain = 'main' | 'test' | 'ttn' | 'mock'` from the toolbox sdk.
 */
export type WalletChain = 'main' | 'test' | 'ttn'

/**
 * Map our app-level chain id to the wallet-toolbox `Chain` value.
 * The app persists/displays `'teratest'`, but the toolbox (and its default
 * wallet-client service paths — e.g. WhatsOnChain `api.woc-ttn.bsvblockchain.tech`)
 * identify TeraTestNet as `'ttn'`. Keep `'teratest'` for AsyncStorage keys,
 * env var names (`EXPO_PUBLIC_TERATEST_*`) and UI; convert only at toolbox boundaries.
 */
export function toWalletChain(chain: AppChain): WalletChain {
  return chain === 'teratest' ? 'ttn' : chain
}

export const DEFAULT_WAB_URL = 'noWAB'
export const DEFAULT_STORAGE_URL = 'local'
export const DEFAULT_MESSAGEBOX_URL = 'https://messagebox.babbage.systems'
/**
 * Encrypted wallet-backup log.
 *
 * Deliberately separate from DEFAULT_STORAGE_URL, which stays 'local': this service is not
 * a wallet storage provider. It stores opaque ciphertext it cannot read, addressed by a
 * pseudonym derived from the wallet seed.
 *
 * Empty disables backup entirely — no monitor task is registered and nothing is sent. That
 * is the default until an endpoint is chosen.
 *
 * Set EXPO_PUBLIC_BACKUP_URL to point a build at a server. EXPO_PUBLIC_* values are inlined
 * by Metro at bundle time, so changing it needs a Metro restart but not a native rebuild.
 * It must be an origin with no trailing slash and no path: the BRC-103/104 handshake is
 * posted to the origin root, so a path prefix makes every request fail authentication.
 *
 *   EXPO_PUBLIC_BACKUP_URL=https://backup.example.com npm run ios
 */
export const DEFAULT_BACKUP_URL = (process.env.EXPO_PUBLIC_BACKUP_URL ?? '').replace(/\/+$/, '')
export const DEFAULT_CHAIN: AppChain = 'main'
export const ADMIN_ORIGINATOR = 'admin.com'
