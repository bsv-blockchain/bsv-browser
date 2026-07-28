import {
  inferRail,
  classifyScan,
  isValidBsvAddress,
  normalizeAddressInput,
  legacyRedirectTarget,
  PRECONDITION_KEYS,
  CONSEQUENCE_KEYS
} from '@/utils/pay/rails'
import { encodeSession, mintSession } from '@/utils/localpay/session'

// secp256k1 generator point — a genuinely valid compressed pubkey.
//
// Lowercase is load-bearing, not cosmetic: utils/parsePeerPayURI's
// COMPRESSED_PUBLIC_KEY_REGEX is /^0[23][0-9a-f]{64}$/ with no `i` flag, so a
// `peerpay:` URI carrying uppercase hex is rejected as malformed. This constant
// therefore has to be in the form a real peerpay link uses.
const KEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
// A real mainnet P2PKH address (base58check).
const ADDRESS = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'

const session = () =>
  mintSession({
    identityKey: KEY,
    derivationPrefix: 'ZGV2LXByZWZpeA==',
    derivationSuffix: 'ZGV2LXN1ZmZpeA==',
    supportsAwdl: false
  })

describe('inferRail', () => {
  it('maps a scanned nearby session to the nearby rail', () => {
    expect(inferRail({ kind: 'nearby', session: session() })).toBe('nearby')
  })

  it('maps a resolved identity to the handle rail', () => {
    expect(inferRail({ kind: 'handle', identityKey: KEY })).toBe('handle')
  })

  it('maps a validated address to the address rail', () => {
    expect(inferRail({ kind: 'address', address: ADDRESS })).toBe('address')
  })
})

describe('classifyScan', () => {
  it('reads a peerpay URI as a handle target, carrying the amount', () => {
    const target = classifyScan(`peerpay:${KEY}?sats=5000`)
    expect(target).toEqual({ kind: 'handle', identityKey: KEY, sats: 5000 })
  })

  it('rejects a peerpay URI whose identity key is malformed', () => {
    expect(classifyScan('peerpay:not-a-key')).toBeNull()
  })

  it('reads a bare compressed public key as a handle target', () => {
    expect(classifyScan(KEY)).toEqual({ kind: 'handle', identityKey: KEY })
  })

  it('reads an encoded localpay session as a nearby target', () => {
    const target = classifyScan(encodeSession(session()))
    expect(target?.kind).toBe('nearby')
  })

  it('reads a bare base58 address as an address target', () => {
    expect(classifyScan(ADDRESS)).toEqual({ kind: 'address', address: ADDRESS })
  })

  it('strips a bitcoin: scheme and its query before classifying', () => {
    expect(classifyScan(`bitcoin:${ADDRESS}?amount=0.1`)).toEqual({ kind: 'address', address: ADDRESS })
  })

  it('returns null for junk rather than guessing a rail', () => {
    expect(classifyScan('hello world')).toBeNull()
  })

  it('tolerates surrounding whitespace', () => {
    expect(classifyScan(`  ${ADDRESS}  `)).toEqual({ kind: 'address', address: ADDRESS })
  })
})

describe('address validation', () => {
  it('accepts a base58check address', () => {
    expect(isValidBsvAddress(ADDRESS)).toBe(true)
  })

  it('rejects an empty string', () => {
    expect(isValidBsvAddress('')).toBe(false)
  })

  it('rejects a checksum-broken address', () => {
    expect(isValidBsvAddress(`${ADDRESS.slice(0, -1)}X`)).toBe(false)
  })

  it('normalizes a bitcoin: URI to a bare address', () => {
    expect(normalizeAddressInput(`bitcoin:${ADDRESS}?label=x`)).toBe(ADDRESS)
  })
})

describe('copy keys', () => {
  it('names a precondition and a consequence for every rail', () => {
    for (const rail of ['nearby', 'handle', 'address'] as const) {
      expect(PRECONDITION_KEYS[rail]).toMatch(/^pay_pre_/)
      expect(CONSEQUENCE_KEYS[rail]).toMatch(/^pay_conseq_/)
    }
  })
})

describe('legacyRedirectTarget', () => {
  it('sends /payments to the pay-handle cell', () => {
    expect(legacyRedirectTarget('payments', {})).toEqual({ pathname: '/pay', params: { cell: 'pay-handle' } })
  })

  it('forwards a peerpay URI so the deep link still lands on the recipient', () => {
    const uri = `peerpay:${KEY}?sats=1000`
    expect(legacyRedirectTarget('payments', { peerpay: uri })).toEqual({
      pathname: '/pay',
      params: { cell: 'pay-handle', peerpay: uri }
    })
  })

  it('forwards identityKey and sats params', () => {
    expect(legacyRedirectTarget('payments', { identityKey: KEY, sats: '42' })).toEqual({
      pathname: '/pay',
      params: { cell: 'pay-handle', identityKey: KEY, sats: '42' }
    })
  })

  it('sends /legacy-payments to the get-address cell', () => {
    expect(legacyRedirectTarget('legacy-payments', {})).toEqual({
      pathname: '/pay',
      params: { cell: 'get-address' }
    })
  })

  it('sends /local-payments to the get-nearby cell', () => {
    expect(legacyRedirectTarget('local-payments', {})).toEqual({
      pathname: '/pay',
      params: { cell: 'get-nearby' }
    })
  })

  it('drops undefined params rather than forwarding them', () => {
    expect(legacyRedirectTarget('payments', { sats: undefined }).params).toEqual({ cell: 'pay-handle' })
  })
})
