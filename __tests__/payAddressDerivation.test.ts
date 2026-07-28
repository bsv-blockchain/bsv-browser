import { PublicKey, Utils } from '@bsv/sdk'
import {
  BRC29_PROTOCOL_ID,
  LEGACY_DERIVATION_SUFFIX,
  derivationPrefixFor,
  getCurrentDate,
  getPaymentAddress,
  legacyKeyId,
  wocConfigFor
} from '@/utils/pay/rails/address'

const dayMs = 86_400_000

describe('getCurrentDate', () => {
  it('formats as YYYY-MM-DD', () => {
    expect(getCurrentDate(0)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('steps back exactly one calendar day per offset, across 40 days', () => {
    // Invariant, not a golden value: holds in every timezone. Spacing is
    // asserted in UTC-parsed milliseconds, which is what makes it TZ-proof.
    const dates = Array.from({ length: 41 }, (_, i) => getCurrentDate(i))
    for (let i = 1; i < dates.length; i++) {
      const later = Date.parse(`${dates[i - 1]}T00:00:00Z`)
      const earlier = Date.parse(`${dates[i]}T00:00:00Z`)
      expect(later - earlier).toBe(dayMs)
    }
  })

  it('matches independent date arithmetic at a fixed instant', () => {
    // 12:00Z keeps every timezone on the same calendar day, so the two
    // arithmetics (setDate vs millisecond subtraction) agree. A DST boundary
    // at local midnight is the one case where they could differ — hence noon.
    const now = new Date('2026-07-28T12:00:00.000Z')
    const expected = (offset: number) => new Date(now.getTime() - offset * dayMs).toISOString().split('T')[0]
    for (const offset of [0, 1, 7, 30]) {
      expect(getCurrentDate(offset, now)).toBe(expected(offset))
    }
  })

  it('crosses a month boundary', () => {
    expect(getCurrentDate(1, new Date('2026-03-01T12:00:00.000Z'))).toBe('2026-02-28')
  })

  it('crosses a year boundary', () => {
    expect(getCurrentDate(1, new Date('2026-01-01T12:00:00.000Z'))).toBe('2025-12-31')
  })
})

describe('derivation key material', () => {
  it('pins the BRC-29 protocol ID', () => {
    expect(BRC29_PROTOCOL_ID).toEqual([2, '3241645161d8'])
  })

  it('derives the prefix as base64 of the date string', () => {
    expect(derivationPrefixFor('2026-07-28')).toBe(Utils.toBase64(Utils.toArray('2026-07-28', 'utf8')))
  })

  it("pins the suffix as base64 of 'legacy'", () => {
    expect(LEGACY_DERIVATION_SUFFIX).toBe(Utils.toBase64(Utils.toArray('legacy', 'utf8')))
  })

  it('joins prefix and suffix with a single space to form the key ID', () => {
    expect(legacyKeyId('AAA=')).toBe(`AAA= ${LEGACY_DERIVATION_SUFFIX}`)
  })

  it('reproduces the exact key ID a 2026-07-28 address was issued under', () => {
    // Regression pin: this is the string the old screen sent to getPublicKey.
    expect(legacyKeyId(derivationPrefixFor('2026-07-28'))).toBe('MjAyNi0wNy0yOA== bGVnYWN5')
  })
})

describe('wocConfigFor', () => {
  it('maps mainnet', () => {
    expect(wocConfigFor('main')).toEqual({
      apiBase: 'https://api.whatsonchain.com',
      segment: 'main',
      network: 'mainnet'
    })
  })

  it('maps testnet', () => {
    expect(wocConfigFor('test')).toEqual({
      apiBase: 'https://api.whatsonchain.com',
      segment: 'test',
      network: 'testnet'
    })
  })

  it('maps teratest to its own WoC host', () => {
    expect(wocConfigFor('teratest')).toEqual({
      apiBase: 'https://api.woc-ttn.bsvblockchain.tech',
      segment: 'test',
      network: 'testnet'
    })
  })
})

describe('getPaymentAddress', () => {
  it('asks the wallet for a BRC-29 key for anyone, forSelf, and converts it to an address', async () => {
    const publicKey = '0279BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798'
    const wallet = { getPublicKey: jest.fn().mockResolvedValue({ publicKey }) }
    const prefix = derivationPrefixFor('2026-07-28')

    const address = await getPaymentAddress(wallet, 'admin.com', prefix, 'mainnet')

    expect(wallet.getPublicKey).toHaveBeenCalledWith(
      {
        protocolID: BRC29_PROTOCOL_ID,
        keyID: legacyKeyId(prefix),
        counterparty: 'anyone',
        forSelf: true
      },
      'admin.com'
    )
    expect(address).toBe(PublicKey.fromString(publicKey).toAddress('mainnet'))
  })

  it('rejects when the wallet cannot derive', async () => {
    const wallet = { getPublicKey: jest.fn().mockRejectedValue(new Error('locked')) }
    await expect(getPaymentAddress(wallet, 'admin.com', 'AAA=', 'mainnet')).rejects.toThrow('locked')
  })
})
