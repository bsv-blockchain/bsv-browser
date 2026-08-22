import { Utils } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'
import { sealVaultKey, unsealVaultKey, softwareEcdh, SEAL_INFO } from '../../services/vault/sealing'
import { VaultError } from '../../services/vault/types'

function cardKeypair() {
  const priv = new Uint8Array(32).fill(7); priv[31] = 1
  const pub = p256.getPublicKey(priv, false)
  return { privHex: Utils.toHex(Array.from(priv)), pubHex: Utils.toHex(Array.from(pub)) }
}

describe('vault sealing', () => {
  it('round-trips a 64-byte seed through seal → card-side ECDH → unseal', () => {
    const card = cardKeypair()
    const seed = Array.from({ length: 64 }, (_, i) => i)
    const blob = sealVaultKey(seed, card.pubHex, { slot: 0x82, serial: '31337' })
    expect(blob.v).toBe(1)
    expect(blob.slot).toBe(0x82)
    expect(blob.yubiSerial).toBe('31337')
    // what the YubiKey would compute: ECDH(cardPriv, ephemeralPub)
    const shared = softwareEcdh(card.privHex, blob.ePub)
    expect(unsealVaultKey(blob, shared)).toEqual(seed)
  })

  it('throws seal-corrupt on a wrong shared secret', () => {
    const card = cardKeypair()
    const blob = sealVaultKey([1, 2, 3], card.pubHex, { slot: 0x82, serial: 's' })
    const wrong = softwareEcdh(card.privHex, Utils.toHex(Array.from(p256.getPublicKey(new Uint8Array(32).fill(9), false))))
    expect(() => unsealVaultKey(blob, wrong)).toThrow(VaultError)
    try { unsealVaultKey(blob, wrong) } catch (e) { expect((e as VaultError).code).toBe('seal-corrupt') }
  })

  it('throws seal-corrupt on tampered ciphertext', () => {
    const card = cardKeypair()
    const blob = sealVaultKey([1, 2, 3], card.pubHex, { slot: 0x82, serial: 's' })
    const tampered = { ...blob, c: blob.c.slice(0, -2) + (blob.c.endsWith('00') ? '01' : '00') }
    const shared = softwareEcdh(card.privHex, blob.ePub)
    expect(() => unsealVaultKey(tampered, shared)).toThrow(VaultError)
  })

  it(`fresh ephemeral key + salt per seal (info=${SEAL_INFO})`, () => {
    const card = cardKeypair()
    const a = sealVaultKey([9], card.pubHex, { slot: 0x82, serial: 's' })
    const b = sealVaultKey([9], card.pubHex, { slot: 0x82, serial: 's' })
    expect(a.ePub).not.toEqual(b.ePub)
    expect(a.salt).not.toEqual(b.salt)
    expect(a.c).not.toEqual(b.c)
  })
})
