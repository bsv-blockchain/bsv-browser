import {
  inferRail,
  classifyScan,
  classifyRecipientInput,
  isValidBsvAddress,
  isCompressedPublicKey,
  normalizeAddressInput,
  legacyRedirectTarget,
  addressNetwork,
  PRECONDITION_KEYS,
  CONSEQUENCE_KEYS
} from '@bsv/expo-wallet-toolbox/core/pay/rails'
import { encodeSession, mintSession } from '@bsv/expo-wallet-toolbox/core/localpay/session'

// secp256k1 generator point — a genuinely valid compressed pubkey.
//
// Lowercase because that is the form PublicKey.toString() emits and the form
// every classifier hands back: a `peerpay:` URI may carry either case, and the
// parser lowercases the key it stores.
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

  it('rejects a peerpay URI whose amount is malformed, rather than dropping the figure', () => {
    expect(classifyScan(`peerpay:${KEY}?sats=-1`)).toBeNull()
  })

  it('reads a bare compressed public key as a handle target', () => {
    expect(classifyScan(KEY)).toEqual({ kind: 'handle', identityKey: KEY })
  })

  it('reads an encoded localpay session as a nearby target', () => {
    const target = classifyScan(encodeSession(session()))
    expect(target?.kind).toBe('nearby')
  })

  it('reads a bare base58 address as an address target', () => {
    expect(classifyScan(ADDRESS)).toEqual({ kind: 'address', address: ADDRESS, network: 'main' })
  })

  it('strips a bitcoin: scheme and its query before classifying', () => {
    expect(classifyScan(`bitcoin:${ADDRESS}?amount=0.1`)).toEqual({
      kind: 'address',
      address: ADDRESS,
      network: 'main'
    })
  })

  it('returns null for junk rather than guessing a rail', () => {
    expect(classifyScan('hello world')).toBeNull()
  })

  it('tolerates surrounding whitespace', () => {
    expect(classifyScan(`  ${ADDRESS}  `)).toEqual({ kind: 'address', address: ADDRESS, network: 'main' })
  })

  // misc-p2-03: a scanned address's network version byte is carried through so
  // the caller can compare it against the wallet's selected network.
  it('carries the testnet version byte through as network', () => {
    const TESTNET = 'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn'
    expect(classifyScan(TESTNET)).toEqual({ kind: 'address', address: TESTNET, network: 'test' })
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

// misc-p2-03: the address rail accepted a pasted/scanned address regardless of
// its network version byte, with no way for a caller to warn the user their
// mainnet wallet is about to pay a testnet-shaped address (same key, but zero
// visibility for the recipient's own network expectation).
describe('addressNetwork', () => {
  it('reads the mainnet version byte', () => {
    expect(addressNetwork(ADDRESS)).toBe('main')
  })

  it('reads the testnet version byte — shared by testnet and teratest', () => {
    expect(addressNetwork('mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn')).toBe('test')
  })

  it('returns undefined for a string that is not a valid base58check address', () => {
    expect(addressNetwork('not an address')).toBeUndefined()
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

  it('forwards the first element of an array-valued param — expo-router repeats a query key into an array', () => {
    expect(legacyRedirectTarget('payments', { identityKey: [KEY], sats: ['500'] })).toEqual({
      pathname: '/pay',
      params: { cell: 'pay-handle', identityKey: KEY, sats: '500' }
    })
  })
})

describe('classifyRecipientInput', () => {
  // Uppercase form of KEY: valid on the curve, but not the lowercase BRC-125 wants.
  const KEY_UPPER = KEY.toUpperCase()
  // Same length and alphabet as ADDRESS with the last character changed: checksum fails.
  const BROKEN_ADDRESS = ADDRESS.slice(0, -1) + (ADDRESS.endsWith('2') ? '3' : '2')

  it('treats an empty or whitespace string as empty', () => {
    expect(classifyRecipientInput('')).toEqual({ kind: 'empty' })
    expect(classifyRecipientInput('   ')).toEqual({ kind: 'empty' })
  })

  it('reads a base58check address as an address target', () => {
    expect(classifyRecipientInput(ADDRESS)).toEqual({ kind: 'address', address: ADDRESS, network: 'main' })
    expect(classifyRecipientInput(`  ${ADDRESS}  `)).toEqual({ kind: 'address', address: ADDRESS, network: 'main' })
  })

  it('reads a testnet address as an address target — testnet is a selectable network', () => {
    const TESTNET = 'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn'
    expect(classifyRecipientInput(TESTNET)).toEqual({ kind: 'address', address: TESTNET, network: 'test' })
  })

  it('sends a P2SH-shaped address to search — the address rail pays with a P2PKH lock', () => {
    const P2SH = '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy'
    expect(classifyRecipientInput(P2SH)).toEqual({ kind: 'search', query: P2SH })
  })

  it('flags an address-shaped string whose checksum fails, and does not search for it', () => {
    expect(classifyRecipientInput(BROKEN_ADDRESS)).toEqual({ kind: 'invalid_address' })
  })

  it('strips a bitcoin: scheme and query before the address rule', () => {
    expect(classifyRecipientInput(`bitcoin:${ADDRESS}?amount=0.1`)).toEqual({
      kind: 'address',
      address: ADDRESS,
      network: 'main'
    })
    expect(classifyRecipientInput(`bitcoin:${BROKEN_ADDRESS}`)).toEqual({ kind: 'invalid_address' })
  })

  it('reads a compressed key as a handle, lowercased', () => {
    expect(classifyRecipientInput(KEY)).toEqual({ kind: 'handle', identityKey: KEY })
    expect(classifyRecipientInput(KEY_UPPER)).toEqual({ kind: 'handle', identityKey: KEY })
  })

  it('sends an uncompressed key to search rather than paying it', () => {
    // 04 + 128 hex: the right length for an uncompressed key, not a compressed one.
    const uncompressed = '04' + 'ab'.repeat(64)
    expect(classifyRecipientInput(uncompressed)).toEqual({ kind: 'search', query: uncompressed })
  })

  it('reads a peerpay link as a handle carrying sats and messageBoxUrl', () => {
    const uri = `peerpay:${KEY}?sats=250&url=${encodeURIComponent('https://mb.example')}`
    expect(classifyRecipientInput(uri)).toEqual({
      kind: 'handle',
      identityKey: KEY,
      sats: 250,
      messageBoxUrl: 'https://mb.example'
    })
  })

  it('reports a malformed peerpay link as invalid_link with the validator message', () => {
    const r = classifyRecipientInput('peerpay:nope')
    expect(r.kind).toBe('invalid_link')
    expect((r as { message: string }).message).toContain('identity key')
  })

  it('reports a peerpay link with a good key but a bad amount as invalid_link', () => {
    const r = classifyRecipientInput(`peerpay:${KEY}?sats=2.5`)
    expect(r.kind).toBe('invalid_link')
    expect((r as { message: string }).message).toContain('sats')
  })

  it('sends a phone-shaped number to search — it is too short to be an address', () => {
    expect(classifyRecipientInput('12125551234')).toEqual({ kind: 'search', query: '12125551234' })
  })

  it('sends an email or a handle to search', () => {
    expect(classifyRecipientInput('alice@example.com')).toEqual({ kind: 'search', query: 'alice@example.com' })
    expect(classifyRecipientInput('alice')).toEqual({ kind: 'search', query: 'alice' })
  })
})

describe('classifyScan — key strictness and url', () => {
  it('rejects an uncompressed bare key', () => {
    expect(classifyScan('04' + 'ab'.repeat(64))).toBeNull()
  })

  it('lowercases a scanned compressed key', () => {
    expect(classifyScan(KEY.toUpperCase())).toEqual({ kind: 'handle', identityKey: KEY })
  })

  it('carries messageBoxUrl from a peerpay link', () => {
    const target = classifyScan(`peerpay:${KEY}?sats=5&url=${encodeURIComponent('https://mb.example')}`)
    expect(target).toEqual({ kind: 'handle', identityKey: KEY, sats: 5, messageBoxUrl: 'https://mb.example' })
  })
})

describe('isCompressedPublicKey', () => {
  it('accepts 02/03 + 64 hex on the curve, either case', () => {
    expect(isCompressedPublicKey(KEY)).toBe(true)
    expect(isCompressedPublicKey(KEY.toUpperCase())).toBe(true)
  })
  it('rejects the wrong prefix, length or a point off the curve', () => {
    expect(isCompressedPublicKey('04' + 'ab'.repeat(64))).toBe(false)
    expect(isCompressedPublicKey(KEY.slice(0, 64))).toBe(false)
    expect(isCompressedPublicKey('02' + 'ff'.repeat(32))).toBe(false)
  })
})

// ── Token requests over the handle rail: asset=<outpoint> [&amount=<base units>] ──
const ASSET = 'ab'.repeat(32) + '.0'

describe('classifyScan — token requests', () => {
  it('reads asset and amount as a handle target, base units untouched', () => {
    expect(classifyScan(`peerpay:${KEY}?asset=${ASSET}&amount=2500`)).toEqual({
      kind: 'handle',
      identityKey: KEY,
      asset: ASSET,
      amount: 2500
    })
  })

  it('reads asset alone as an open token request', () => {
    expect(classifyScan(`peerpay:${KEY}?asset=${ASSET}`)).toEqual({ kind: 'handle', identityKey: KEY, asset: ASSET })
  })

  it('rejects a link that mixes sats with a token request', () => {
    expect(classifyScan(`peerpay:${KEY}?sats=5&asset=${ASSET}`)).toBeNull()
  })

  it('rejects an amount with no asset', () => {
    expect(classifyScan(`peerpay:${KEY}?amount=5`)).toBeNull()
  })
})

describe('classifyRecipientInput — token requests', () => {
  it('carries asset and amount on a pasted link', () => {
    expect(classifyRecipientInput(`peerpay:${KEY}?asset=${ASSET}&amount=99`)).toEqual({
      kind: 'handle',
      identityKey: KEY,
      asset: ASSET,
      amount: 99
    })
  })

  it('surfaces an amount without an asset as an invalid link, with the validator’s reason', () => {
    const r = classifyRecipientInput(`peerpay:${KEY}?amount=99`)
    expect(r.kind).toBe('invalid_link')
    if (r.kind === 'invalid_link') expect(r.message).toMatch(/amount/i)
  })
})
