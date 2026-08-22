/**
 * Argument-size cap for wallets handed to EXTERNAL callers.
 *
 * Composed at each external surface exactly like guardVaultAccess: the in-tab
 * CWI bridge, the desktop-pairing WalletClient, and the saved-connection
 * WalletClients. Wrap outside the vault guard so a refusal costs nothing —
 * neither a permission prompt nor a storage touch.
 *
 * WHERE THIS MUST NOT GO. Not in guardVaultAccess, not in SimpleWalletManager,
 * not in WalletPermissionsManager, and not in the toolbox. The vault's K1
 * traffic is ordinary-sized today — a 25-byte P2PKH locking script and a
 * ~107-byte unlocking script per input — and would pass any limit here
 * unmodified. The exemption is kept anyway so the vault stays insulated from
 * any future tightening of these limits on the shared path.
 *
 * The vault is exempt STRUCTURALLY rather than by an originator comparison: it
 * calls managers.permissionsManager directly and never receives a capped wallet.
 * That cannot be spoofed by a caller presenting the admin originator, which
 * matters because the desktop-pairing surface constructs its WalletClient over
 * guardVaultAccess(manager, ADMIN_ORIGINATOR) — the admin string appears there
 * for the guard's own comparison, so keying an exemption on it would be reasoning
 * about the wrong thing.
 */
import type { WalletInterface } from '@bsv/sdk'
import { type WalletArgLimits, checkWalletArgs, limitsForTier } from './walletArgLimits'

/**
 * A refused call.
 *
 * `code = 6` matches WERR_INVALID_PARAMETER, which is what page-side @bsv/sdk
 * consumers already read off `err.code`; the dispatcher's catch flattens a bare
 * Error to code 1, so a size refusal would otherwise be indistinguishable from
 * an unknown internal failure.
 */
export class WalletArgTooLarge extends Error {
  readonly code = 6
  constructor(
    readonly field: string,
    message: string
  ) {
    super(message)
    this.name = 'WalletArgTooLarge'
  }
}

/**
 * Device tier, read lazily.
 *
 * expo-device is a native module, so importing it at module load would make this
 * pure wrapper unusable anywhere the native side is absent — including tests. A
 * caller that supplies its own limits never touches it at all, and a failure to
 * read the tier falls back to 'mid' rather than leaving the surface uncapped.
 */
function tierLimits(): WalletArgLimits {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getDeviceTier } = require('@/utils/deviceTier') as typeof import('@/utils/deviceTier')
    return limitsForTier(getDeviceTier())
  } catch {
    return limitsForTier('mid')
  }
}

/** The calls that can carry transaction bytes. */
const SIZED = new Set<keyof WalletInterface>(['createAction', 'signAction', 'internalizeAction'])

/**
 * Wrap `wallet` so oversize arguments are refused before it is called.
 *
 * Limits default to the device tier's, which halves the aggregate on a device
 * with under 3.5 GB of RAM.
 */
export function capWalletArgs<T extends WalletInterface>(wallet: T, limits?: WalletArgLimits): T {
  const active = limits ?? tierLimits()
  return new Proxy(wallet, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== 'function' || !SIZED.has(prop as keyof WalletInterface)) {
        return typeof value === 'function' ? value.bind(target) : value
      }
      return (args: unknown, originator?: string) => {
        const refusal = checkWalletArgs(String(prop), args, active)
        if (refusal) {
          console.log(
            '[walletArgs] refused %s from %s · %s %d > %d',
            String(prop),
            originator ?? 'unknown',
            refusal.field,
            refusal.actual,
            refusal.limit
          )
          return Promise.reject(new WalletArgTooLarge(refusal.field, refusal.message))
        }
        return (value as (a: unknown, o?: string) => unknown)(args, originator)
      }
    }
  })
}
