/**
 * One-tap "print my recovery shares", shared by Settings, onboarding and vault
 * enrollment.
 *
 * WHAT THESE SHARES COVER
 *
 * For a wallet with a mnemonic, the shares split the mnemonic ENTROPY
 * (BRC-157). Any two rebuild the phrase, and therefore the seed, m/0'/0', the
 * everyday balance AND the vault. The printed sheet is seed-equivalent paper —
 * treat it with the same care as the phrase itself.
 *
 * For a wallet restored from legacy paper there is no mnemonic to frame, so
 * the shares split the raw recovered key, exactly as before. Those restore
 * spending authority only and can never open a vault. That cohort cannot
 * upgrade in place; their remedy is to sweep to a fresh wallet.
 *
 * 24-word phrases are refused: their entropy is 32 bytes, which fills the
 * split secret completely and leaves no room for the tag that tells the two
 * formats apart on recovery.
 */
import { Mnemonic, PrivateKey } from '@bsv/sdk'
import * as Print from 'expo-print'
import {
  ENTROPY_BYTES,
  generateEntropyShares,
  generateLegacyKeyShares,
  generatePrintHTML
} from './backupShares'
import { recoverMnemonicWallet } from './mnemonicWallet'

export interface PrintSharesSources {
  /** The wallet mnemonic, when the wallet has one. */
  mnemonic: string | null
  /** WIF of a share-restored wallet, which has no mnemonic. */
  recoveredKeyWif?: string | null
}

export type PrintSharesResult =
  | { ok: true; format: 'entropy' | 'legacy' }
  | { ok: false; reason: 'no-material' | 'unsupported-word-count' }

/**
 * Present the print sheet for a 2-of-3 recovery share set.
 *
 * Never throws for the "cannot print" cases — callers surface the reason as a
 * message. A dismissed print sheet still rejects from expo-print and is the
 * caller's business.
 */
export async function printRecoveryShares(
  sources: PrintSharesSources
): Promise<PrintSharesResult> {
  let shares: string[]
  let identityKey: string
  let format: 'entropy' | 'legacy'

  if (sources.mnemonic) {
    const entropy = Mnemonic.fromString(sources.mnemonic).toEntropy()
    if (entropy.length !== ENTROPY_BYTES) return { ok: false, reason: 'unsupported-word-count' }

    shares = generateEntropyShares(entropy)
    identityKey = recoverMnemonicWallet(sources.mnemonic).identityKey
    format = 'entropy'
  } else if (sources.recoveredKeyWif) {
    const priv = PrivateKey.fromWif(sources.recoveredKeyWif)
    shares = generateLegacyKeyShares(Array.from(priv.toArray()))
    identityKey = priv.toPublicKey().toString()
    format = 'legacy'
  } else {
    return { ok: false, reason: 'no-material' }
  }

  await Print.printAsync({ html: await generatePrintHTML(shares, identityKey, format) })
  return { ok: true, format }
}
