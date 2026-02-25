/**
 * Mnemonic-based wallet utilities for noWAB (self-custodial) mode
 *
 * Uses @bsv/sdk Mnemonic and HD classes for BIP39 mnemonic and BIP32 HD key derivation
 */

import { Mnemonic, HD, PrivateKey } from '@bsv/sdk'

export interface MnemonicWalletConfig {
  mnemonic?: string // Optional: provide existing mnemonic
  passphrase?: string // Optional BIP39 passphrase
  language?: 'en' | 'es' | 'fr' | 'it' | 'ja' | 'ko' | 'zh_CN' | 'zh_TW' // Default: 'en'
}

export interface MnemonicWalletResult {
  mnemonic: string
  rootKey: PrivateKey
  primaryKey: number[] // Derived key at m/0'/0' for wallet
  identityKey: string // Public key hex
}

/**
 * Generate a new mnemonic-based wallet
 */
export function generateMnemonicWallet(config: MnemonicWalletConfig = {}): MnemonicWalletResult {
  const { passphrase = '' } = config

  // Generate new mnemonic or use provided one
  let mnemonicInstance: Mnemonic
  if (config.mnemonic) {
    // Validate and use existing mnemonic
    mnemonicInstance = Mnemonic.fromString(config.mnemonic)
  } else {
    // Generate new random mnemonic (128 bits = 12 words by default)
    mnemonicInstance = Mnemonic.fromRandom()
  }

  // Get mnemonic as string
  const mnemonicString = mnemonicInstance.toString()

  // Derive seed from mnemonic
  const seed = mnemonicInstance.toSeed(passphrase)

  // Create HD key from seed
  const hdKey = HD.fromSeed(seed)

  // Get root key
  const rootKey = hdKey.privKey

  // Derive primary key at path m/0'/0' (hardened derivation)
  // This is the key used as the wallet's primary key
  const derivedHdKey = hdKey.derive("m/0'/0'")
  const primaryKey = derivedHdKey.privKey.toArray()

  // Get identity key (public key) for the derived key
  const identityKey = derivedHdKey.privKey.toPublicKey().toString()

  return {
    mnemonic: mnemonicString,
    rootKey,
    primaryKey,
    identityKey
  }
}

/**
 * Recover wallet from existing mnemonic
 */
export function recoverMnemonicWallet(
  mnemonic: string,
  passphrase: string = ''
): MnemonicWalletResult {
  return generateMnemonicWallet({ mnemonic, passphrase })
}

/**
 * Validate a mnemonic phrase
 */
export function validateMnemonic(mnemonic: string): boolean {
  try {
    Mnemonic.fromString(mnemonic)
    return true
  } catch {
    return false
  }
}

/**
 * Generate a random mnemonic of specified strength
 * @param strength Entropy bits: 128 (12 words), 160 (15 words), 192 (18 words), 224 (21 words), 256 (24 words)
 */
export function generateRandomMnemonic(strength: 128 | 160 | 192 | 224 | 256 = 128): string {
  // For now, @bsv/sdk Mnemonic.fromRandom() generates 128 bits (12 words)
  // If you need different strengths, you may need to generate entropy manually
  const mnemonic = Mnemonic.fromRandom()
  return mnemonic.toString()
}

/**
 * Get word count for a mnemonic
 */
export function getMnemonicWordCount(mnemonic: string): number {
  return mnemonic.trim().split(/\s+/).length
}

/**
 * Get expected word count for entropy bits
 */
export function getExpectedWordCount(entropyBits: number): number {
  return Math.floor((entropyBits + entropyBits / 32) / 11)
}

/**
 * Parse mnemonic safely and return validation result
 */
export interface MnemonicValidationResult {
  valid: boolean
  wordCount?: number
  expectedWordCount?: number
  error?: string
}

export function parseMnemonic(mnemonic: string): MnemonicValidationResult {
  const trimmed = mnemonic.trim()
  const words = trimmed.split(/\s+/)
  const wordCount = words.length

  // Valid word counts: 12, 15, 18, 21, 24
  const validCounts = [12, 15, 18, 21, 24]

  if (!validCounts.includes(wordCount)) {
    return {
      valid: false,
      wordCount,
      error: `Invalid word count: ${wordCount}. Expected: ${validCounts.join(', ')}`
    }
  }

  try {
    Mnemonic.fromString(trimmed)
    return {
      valid: true,
      wordCount
    }
  } catch (error: any) {
    return {
      valid: false,
      wordCount,
      error: error.message || 'Invalid mnemonic phrase'
    }
  }
}

/**
 * Convert mnemonic to displayable format with numbered words
 */
export function formatMnemonicForDisplay(mnemonic: string): string[] {
  return mnemonic.trim().split(/\s+/)
}

/**
 * Helper to securely store mnemonic (should be encrypted in production)
 * Returns base64 encoded mnemonic
 */
export function encodeMnemonicForStorage(mnemonic: string): string {
  // In production, this should encrypt the mnemonic
  // For now, just base64 encode
  return btoa(mnemonic)
}

/**
 * Helper to retrieve stored mnemonic
 */
export function decodeMnemonicFromStorage(encoded: string): string {
  try {
    return atob(encoded)
  } catch {
    throw new Error('Failed to decode stored mnemonic')
  }
}
