/**
 * The background address sweep.
 *
 * "Get paid → a conventional wallet" is: show the address, and money appears.
 * That means the sweep cannot live in a screen — the screen is exactly what the
 * user no longer has to visit — so this module is the callable pass and
 * WalletContext owns its lifecycle, beside the localpay retry loop that already
 * runs there.
 *
 * Every bound is deliberate and tested: see shouldSweepNow for when a pass may
 * run at all, and utils/pay/watchlist.ts for which addresses it may touch.
 */
import { sweepAddress, type AddressRailWallet, type WocConfig } from '@/utils/pay/rails/address'
import { getWatchlist, touchWatched, type KVStorage } from '@/utils/pay/watchlist'

/** One poll every 30s — an order of magnitude cheaper than the 3s screen poll it replaces. */
export const SWEEP_INTERVAL_MS = 30_000

export interface SweepOutcome {
  address: string
  importedSatoshis: number
  failureCount: number
}

/**
 * Whether a pass may run right now.
 *
 * Pure so the four conditions are stated in one place and tested: no polling
 * before the wallet exists, none in the background, none offline, and never two
 * at once (each pass writes to the wallet).
 */
export function shouldSweepNow(state: {
  walletBuilt: boolean
  appActive: boolean
  online: boolean
  inFlight: boolean
}): boolean {
  return state.walletBuilt && state.appActive && state.online && !state.inFlight
}

export async function runSweep(args: {
  wallet: AddressRailWallet
  storage: KVStorage
  adminOriginator: string
  woc: WocConfig
}): Promise<SweepOutcome[]> {
  const { wallet, storage, adminOriginator, woc } = args
  const outcomes: SweepOutcome[] = []

  for (const watched of await getWatchlist(storage)) {
    try {
      const { importedSatoshis, failureCount } = await sweepAddress({
        wallet,
        adminOriginator,
        woc,
        address: watched.address,
        derivationPrefix: watched.derivationPrefix
      })
      outcomes.push({ address: watched.address, importedSatoshis, failureCount })
      // Money arrived here once, so it may again: keep this address alive
      // rather than retiring it the moment it pays out.
      if (importedSatoshis > 0) await touchWatched(storage, watched.address)
    } catch {
      // A dead WoC host or a locked wallet must not stop the rest of the pass.
      // The entry stays watched and the next pass retries it.
    }
  }

  return outcomes
}

export function sweptTotal(outcomes: SweepOutcome[]): number {
  return outcomes.reduce((sum, o) => sum + o.importedSatoshis, 0)
}
