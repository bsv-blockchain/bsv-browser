/**
 * CR-7 (native-crypto, issue #35) — @noble/secp256k1 tier-3 ECDSA backend.
 *
 * The patched @bsv/sdk routes ECDSA.sign and PrivateKey.toPublicKey through a
 * three-tier probe seam: Nitro native (fastest) → @noble/secp256k1 (always-on,
 * web/jest/Expo Go) → the SDK's own pure-JS EC (last resort). In jest no native
 * module is installed, so noble is active. This suite is the byte-parity GATE
 * for that backend: noble's RFC 6979 low-S DER and its public keys must be
 * byte-identical to the SDK pure-JS path, or a signed transaction would diverge.
 *
 * Forcing technique (no Nitro in jest): setting `globalThis.__bsvSecpNative` to a
 * method-less object makes `secpBackend()` return it (native wins the probe),
 * its `ecdsaSign`/`pubkeyCreate*` are undefined → the call throws → the seam
 * falls through to the SDK pure-JS path. Deleting the global lets noble win.
 */
import { BigNumber, ECDSA, PrivateKey } from '@bsv/sdk'

const g = globalThis as Record<string, any>

function randMsg (): BigNumber {
  const a: number[] = []
  for (let i = 0; i < 32; i++) a.push(Math.floor(Math.random() * 256))
  return new BigNumber(a)
}

describe('CR-7 noble backend', () => {
  afterEach(() => { delete g.__bsvSecpNative })

  it('is active in jest (a noble-routed signature verifies)', () => {
    delete g.__bsvSecpNative
    const k = PrivateKey.fromRandom()
    const m = randMsg()
    const sig = ECDSA.sign(m, k, true)
    expect(ECDSA.verify(m, sig, k.toPublicKey())).toBe(true)
  })

  it('ECDSA.sign low-S DER is byte-identical to pure-JS (400 random cases)', () => {
    const N = 400
    for (let i = 0; i < N; i++) {
      const k = PrivateKey.fromRandom()
      const m = randMsg()
      delete g.__bsvSecpNative                 // noble backend
      const dNoble = ECDSA.sign(m, k, true).toDER('hex')
      g.__bsvSecpNative = {}                    // force SDK pure-JS
      const dPure = ECDSA.sign(m, k, true).toDER('hex')
      delete g.__bsvSecpNative
      expect(dNoble).toBe(dPure)
    }
  })

  it('PrivateKey.toPublicKey is byte-identical to pure-JS (300 random cases)', () => {
    const N = 300
    for (let i = 0; i < N; i++) {
      const k = PrivateKey.fromRandom()
      delete g.__bsvSecpNative
      const pNoble = k.toPublicKey().encode(true, 'hex')
      g.__bsvSecpNative = {}
      const pPure = k.toPublicKey().encode(true, 'hex')
      delete g.__bsvSecpNative
      expect(pNoble).toBe(pPure)
    }
  })

  it('customK still uses SDK pure-JS (noble cannot honor a supplied k)', () => {
    // With a customK, the seam must NOT route to noble/native — the SDK pure-JS
    // path owns customK. Byte-check: signing with an explicit k is unchanged
    // whether or not the backend is present.
    const k = PrivateKey.fromRandom()
    const m = randMsg()
    const customK = new BigNumber(PrivateKey.fromRandom().toArray('be', 32))
    delete g.__bsvSecpNative
    const withBackend = ECDSA.sign(m, k, true, customK).toDER('hex')
    g.__bsvSecpNative = {}
    const pureJs = ECDSA.sign(m, k, true, customK).toDER('hex')
    delete g.__bsvSecpNative
    expect(withBackend).toBe(pureJs)
  })
})
