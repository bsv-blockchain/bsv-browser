/**
 * Simple wallet builder for noWAB (self-custodial) mode
 *
 * This module provides a wallet builder function for SimpleWalletManager
 * that creates a fully functional wallet from a primary key
 */

import {
  Wallet,
  WalletSigner,
  WalletStorageManager,
  PrivilegedKeyManager,
  Services
} from '@bsv/wallet-toolbox-mobile'
import { KeyDeriver, PrivateKey, WalletInterface } from '@bsv/sdk'

export interface SimpleWalletBuilderConfig {
  chain: 'main' | 'test'
  useLocalStorage?: boolean // If true, don't add remote storage
}

/**
 * Build a wallet instance from primary key and privileged key manager
 * This is the walletBuilder function required by SimpleWalletManager
 */
export async function buildSimpleWallet(
  primaryKey: number[],
  privilegedKeyManager: PrivilegedKeyManager,
  config: SimpleWalletBuilderConfig
): Promise<WalletInterface> {
  const { chain, useLocalStorage = true } = config

  // Create key deriver from primary key
  const keyDeriver = new KeyDeriver(new PrivateKey(primaryKey))

  // Create storage manager
  const storageManager = new WalletStorageManager(keyDeriver.identityKey)

  // Create wallet signer
  const signer = new WalletSigner(chain, keyDeriver, storageManager)

  // Create services
  const services = new Services(chain)

  // Create wallet
  const wallet = new Wallet(signer, services, undefined, privilegedKeyManager)

  // For local storage mode, we don't add remote storage
  // The WalletStorageManager provides local storage by default
  if (!useLocalStorage) {
    // Future: Add remote storage client here if needed
    throw new Error('Remote storage not yet supported in simple wallet mode')
  }

  return wallet
}

/**
 * Create a wallet builder function for SimpleWalletManager
 */
export function createSimpleWalletBuilder(config: SimpleWalletBuilderConfig) {
  return async (primaryKey: number[], privilegedKeyManager: PrivilegedKeyManager): Promise<WalletInterface> => {
    return buildSimpleWallet(primaryKey, privilegedKeyManager, config)
  }
}
