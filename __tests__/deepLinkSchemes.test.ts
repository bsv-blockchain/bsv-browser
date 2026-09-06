import { PAIRING_SCHEMES, pairingSchemeOf } from '@/utils/deepLinkSchemes'

/**
 * A pairing QR minted by BSV Wallet uses bsv-wallet://, and one minted here uses
 * bsv-browser://. Whichever app the scanner has installed should open, so both
 * schemes are registered (app.json, and ios/BSVBrowser/Info.plist directly since
 * prebuild never runs for EAS) and both must parse.
 */
describe('pairing deep-link schemes', () => {
  it('accepts a pairing link in either scheme', () => {
    expect(pairingSchemeOf('bsv-browser://pair?topic=abc')).toBe('bsv-browser://')
    expect(pairingSchemeOf('bsv-wallet://pair?topic=abc')).toBe('bsv-wallet://')
  })

  it('matches case-insensitively, as a scanner may hand back any casing', () => {
    expect(pairingSchemeOf('BSV-Wallet://Pair?topic=abc')).toBe('bsv-wallet://')
  })

  it('ignores links that are not pairing links', () => {
    // The browser and peerpay paths are handled by other branches; claiming them
    // here would route a page load or a payment into the pairing screen.
    expect(pairingSchemeOf('https://example.com')).toBeUndefined()
    expect(pairingSchemeOf('peerpay:abc')).toBeUndefined()
    expect(pairingSchemeOf('bsv-wallet://something-else')).toBeUndefined()
    expect(pairingSchemeOf('')).toBeUndefined()
  })

  it('does not match a scheme that merely starts the same way', () => {
    expect(pairingSchemeOf('bsv-wallet-evil://pair?topic=abc')).toBeUndefined()
  })

  it('keeps bsv-browser first, so it stays the canonical scheme', () => {
    expect(PAIRING_SCHEMES[0]).toBe('bsv-browser://')
  })
})
