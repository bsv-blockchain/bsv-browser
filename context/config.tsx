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
export const DEFAULT_MESSAGEBOX_URL = 'https://gmb.bsvblockchain.tech'
/**
 * Encrypted wallet-backup log.
 *
 * The endpoint itself now lives in @bsv/expo-wallet-toolbox's runtime configuration, not in a
 * constant here: app/_layout.tsx reads EXPO_PUBLIC_BACKUP_URL and passes it to
 * configureToolbox at module scope. Babel only inlines EXPO_PUBLIC_* for files outside
 * node_modules, so the host must be the one to read it.
 *
 * It must be an origin with no trailing slash and no path: the BRC-103/104 handshake is
 * posted to the origin root, so a path prefix makes every request fail authentication.
 * Absent (null) disables backup entirely — no monitor task is registered and nothing is sent.
 *
 * The EAS development, dev-physical and production profiles set it to the shared server at
 * https://backup.bsvblockchain.tech (see eas.json). preview-apk carries no env block at all,
 * so those builds have backup disabled along with every other EXPO_PUBLIC_* default.
 *
 *   EXPO_PUBLIC_BACKUP_URL=https://backup.example.com npm run ios
 */
export const DEFAULT_CHAIN: AppChain = 'main'
export const ADMIN_ORIGINATOR = 'admin.com'
