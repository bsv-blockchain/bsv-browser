/**
 * printRecoveryShares picks a share format from the key material it is given.
 * expo-print is mocked: this asserts the decision, not the print sheet.
 */
import { Mnemonic, PrivateKey } from '@bsv/sdk'

jest.mock('expo-print', () => ({
  printAsync: jest.fn(async () => ({ uri: 'file:///out.pdf' }))
}))

// Pulled in as a side effect of printRecoveryShares.ts's barrel import (for
// recoverMnemonicWallet): the barrel's LocalStorageProvider chain reaches
// these native modules at module top level.
jest.mock('expo-local-authentication', () => ({
  getEnrolledLevelAsync: jest.fn(async () => 0),
  hasHardwareAsync: jest.fn(async () => false),
  isEnrolledAsync: jest.fn(async () => false),
  authenticateAsync: jest.fn(async () => ({ success: false })),
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
  AuthenticationType: { FINGERPRINT: 1, FACIAL_RECOGNITION: 2, IRIS: 3 }
}))
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
  WHEN_UNLOCKED: 'wu',
  AFTER_FIRST_UNLOCK: 'afu',
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afudo',
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'wudo'
}))

import { printRecoveryShares } from '@bsv/expo-wallet-toolbox/ui/printRecoveryShares'
import { recoverSecretFromShares, parseShare } from '@bsv/expo-wallet-toolbox/ui/backupShares'
import * as Print from 'expo-print'

const printAsync = Print.printAsync as jest.Mock

beforeEach(() => printAsync.mockClear())

/** Pull the share strings back out of the generated HTML. */
function sharesFromHtml(html: string): string[] {
  const found = [...html.matchAll(/class="data-value share-text">([^<]+)</g)].map(m => m[1])
  return found.filter(s => parseShare(s) !== null)
}

describe('printRecoveryShares', () => {
  test('prints entropy-format shares for a 12-word wallet', async () => {
    const mnemonic = Mnemonic.fromRandom(128)
    const result = await printRecoveryShares({ mnemonic: mnemonic.toString() })

    expect(result).toEqual({ ok: true, format: 'entropy' })
    // One job, one dialog, every share as its own page (XR-110 reverted).
    expect(printAsync).toHaveBeenCalledTimes(1)

    const shares = sharesFromHtml((printAsync.mock.calls[0][0] as { html: string }).html)
    expect(shares).toHaveLength(3)

    const recovered = recoverSecretFromShares(shares.slice(0, 2))
    expect(recovered.kind).toBe('entropy')
    expect(recovered.kind === 'entropy' && Mnemonic.fromEntropy(recovered.entropy).toString()).toBe(mnemonic.toString())
  })

  test('puts each share on its own page of a single print job', async () => {
    const mnemonic = Mnemonic.fromRandom(128)
    await printRecoveryShares({ mnemonic: mnemonic.toString() })

    expect(printAsync).toHaveBeenCalledTimes(1)
    const html = (printAsync.mock.calls[0][0] as { html: string }).html
    expect(html.match(/<div class="page[ "]/g)).toHaveLength(3)
    expect(html.match(/Share \d of 3/g)).toEqual(['Share 1 of 3', 'Share 2 of 3', 'Share 3 of 3'])
  })

  test('refuses a 24-word wallet, because 32 bytes of entropy leaves no room for the tag', async () => {
    const result = await printRecoveryShares({ mnemonic: Mnemonic.fromRandom(256).toString() })

    expect(result).toEqual({ ok: false, reason: 'unsupported-word-count' })
    expect(printAsync).not.toHaveBeenCalled()
  })

  test('prints legacy shares for a wallet that has only a recovered key', async () => {
    const wif = PrivateKey.fromRandom().toWif()
    const result = await printRecoveryShares({ mnemonic: null, recoveredKeyWif: wif })

    expect(result).toEqual({ ok: true, format: 'legacy' })

    const shares = printAsync.mock.calls.map(call => sharesFromHtml((call[0] as { html: string }).html)).flat()
    const recovered = recoverSecretFromShares(shares.slice(0, 2))
    expect(recovered.kind).toBe('legacy')
    expect(recovered.kind === 'legacy' && recovered.primaryKey).toEqual(Array.from(PrivateKey.fromWif(wif).toArray()))
  })

  test('reports no material rather than throwing', async () => {
    expect(await printRecoveryShares({ mnemonic: null })).toEqual({
      ok: false,
      reason: 'no-material'
    })
    expect(printAsync).not.toHaveBeenCalled()
  })

  test('prefers the mnemonic when both are present', async () => {
    const result = await printRecoveryShares({
      mnemonic: Mnemonic.fromRandom(128).toString(),
      recoveredKeyWif: PrivateKey.fromRandom().toWif()
    })
    expect(result).toEqual({ ok: true, format: 'entropy' })
  })
})
