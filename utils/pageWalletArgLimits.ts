/**
 * Argument-size limits for the wallet handed to in-tab pages.
 *
 * The toolbox's limits, with the three unlocking-script caps raised to the
 * per-call aggregate (4 MB, 2 MB on the low tier). Everything else is unchanged.
 *
 * WHY. The toolbox set the unlocking-script caps at 100,000 bytes, about 60x the
 * largest payload observed when they were written (a 65,536-byte AtomicBEEF),
 * not from any covenant's witness. A covenant whose witness carries data (a
 * hashed body, a merkle path, a BEEF) supplies far more: a post publish with a
 * 339,094-byte input script was refused before any sheet.
 *
 * - A SUPPLIED unlocking script (a createAction input, or a signAction spend) is
 *   real bytes the aggregate already counts, so a per-input cap below the
 *   aggregate bounds no memory the aggregate does not. The aggregate stays the
 *   one memory bound.
 * - A DECLARED unlockingScriptLength carries no bytes; its cap guards the fee the
 *   wallet reserves. A declared length is honest when a later signAction supplies
 *   a script of that length, and that signAction is held to the aggregate. The
 *   fee it implies is on the spend sheet like any other. Per input and summed,
 *   it is held to the aggregate too, so a page cannot declare more than it could
 *   ever supply in one call.
 */
import type { DeviceTier } from '@bsv/expo-wallet-toolbox/core/deviceTier'
import { type WalletArgLimits, limitsForTier } from '@bsv/expo-wallet-toolbox/core/services/walletArgLimits'

export function pageWalletArgLimits(tier: DeviceTier): WalletArgLimits {
  const limits = limitsForTier(tier)
  return {
    ...limits,
    unlockingScript: limits.aggregate,
    unlockingScriptLength: limits.aggregate,
    unlockingScriptLengthTotal: limits.aggregate
  }
}
