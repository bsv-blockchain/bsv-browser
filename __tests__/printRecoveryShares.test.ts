/**
 * printRecoveryShares picks a share format from the key material it is given.
 * expo-print is mocked: this asserts the decision, not the print sheet.
 */
import { Mnemonic, PrivateKey } from '@bsv/sdk'

jest.mock('expo-print', () => ({
  printAsync: jest.fn(async () => ({ uri: 'file:///out.pdf' }))
}))

import { printRecoveryShares } from '../utils/printRecoveryShares'
import { recoverSecretFromShares, parseShare } from '../utils/backupShares'
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
    expect(printAsync).toHaveBeenCalledTimes(1)

    const html = (printAsync.mock.calls[0][0] as { html: string }).html
    const shares = sharesFromHtml(html)
    expect(shares).toHaveLength(3)

    const recovered = recoverSecretFromShares(shares.slice(0, 2))
    expect(recovered.kind).toBe('entropy')
    expect(
      recovered.kind === 'entropy' && Mnemonic.fromEntropy(recovered.entropy).toString()
    ).toBe(mnemonic.toString())
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

    const html = (printAsync.mock.calls[0][0] as { html: string }).html
    const recovered = recoverSecretFromShares(sharesFromHtml(html).slice(0, 2))
    expect(recovered.kind).toBe('legacy')
    expect(recovered.kind === 'legacy' && recovered.primaryKey).toEqual(
      Array.from(PrivateKey.fromWif(wif).toArray())
    )
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
