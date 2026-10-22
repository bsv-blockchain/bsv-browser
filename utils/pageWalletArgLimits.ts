/**
 * Argument-size limits for the wallet handed to in-tab pages.
 */
import type { DeviceTier } from '@bsv/expo-wallet-toolbox/core/deviceTier'
import { type WalletArgLimits, limitsForTier } from '@bsv/expo-wallet-toolbox/core/services/walletArgLimits'

export function pageWalletArgLimits(tier: DeviceTier): WalletArgLimits {
  return limitsForTier(tier)
}
