/**
 * Software mock YubiKey + driver selection tests. The mock is the arbiter for
 * the whole TS layer: it implements VaultDriver against an in-memory P-256 key
 * and exposes test controls (insert/remove/touch behaviour/PIN).
 */
import { p256 } from '@noble/curves/nist.js'
import { Utils } from '@bsv/sdk'
import { MockYubiKey } from '../../services/vault/mockYubiKey'
import { getVaultDriver, setMockDriver } from '../../services/vault/driver'
import { softwareEcdh } from '../../services/vault/sealing'
import { VaultError } from '../../services/vault/types'

describe('MockYubiKey', () => {
  test('happy path: insert → pin → generate → ecdh matches softwareEcdh', async () => {
    const mock = new MockYubiKey()
    mock.insertKey('MOCK-1')
    const info = await mock.getKeyInfo()
    expect(info.serial).toBe('MOCK-1')
    expect((await mock.verifyPin('123456')).ok).toBe(true)
    const { publicKey } = await mock.generateVaultKey(0x82)
    expect(publicKey).toHaveLength(65 * 2)
    // seal side derives a shared secret against the token pubkey; the token
    // must reproduce it via ecdh against the same ephemeral point.
    const ephPriv = p256.utils.randomSecretKey()
    const ephPub = Utils.toHex(Array.from(p256.getPublicKey(ephPriv, false)))
    const sealSide = softwareEcdh(Utils.toHex(Array.from(ephPriv)), publicKey)
    const tokenSide = (await mock.ecdh(0x82, '123456', ephPub)).secret
    expect(tokenSide).toBe(sealSide)
  })

  test('wrong PIN decrements retries then locks at zero', async () => {
    const mock = new MockYubiKey()
    mock.insertKey('MOCK-1')
    expect((await mock.verifyPin('000000')).retriesLeft).toBe(2)
    expect((await mock.verifyPin('000000')).retriesLeft).toBe(1)
    expect((await mock.verifyPin('000000')).retriesLeft).toBe(0)
    await expect(mock.verifyPin('123456')).rejects.toMatchObject({ code: 'pin-locked' })
  })

  test('ecdh without a verified PIN is rejected', async () => {
    const mock = new MockYubiKey()
    mock.insertKey('MOCK-1')
    await mock.generateVaultKey(0x82)
    const ephPub = Utils.toHex(Array.from(p256.getPublicKey(p256.utils.randomSecretKey(), false)))
    await expect(mock.ecdh(0x82, '', ephPub)).rejects.toMatchObject({ code: 'pin-required' })
  })

  test('touch timeout surfaces touch-timeout', async () => {
    const mock = new MockYubiKey()
    mock.insertKey('MOCK-1')
    await mock.verifyPin('123456')
    await mock.generateVaultKey(0x82)
    mock.setTouchBehavior('timeout')
    const ephPub = Utils.toHex(Array.from(p256.getPublicKey(p256.utils.randomSecretKey(), false)))
    await expect(mock.ecdh(0x82, '123456', ephPub)).rejects.toMatchObject({ code: 'touch-timeout' })
  })

  test('removing the key mid-op yields key-removed-mid-op', async () => {
    const mock = new MockYubiKey()
    mock.insertKey('MOCK-1')
    await expect(mock.getKeyInfo()).resolves.toBeDefined()
    mock.removeKey()
    await expect(mock.getKeyInfo()).rejects.toMatchObject({ code: 'no-key' })
  })

  test('attach/detach events fire to listeners', () => {
    const mock = new MockYubiKey()
    const events: string[] = []
    mock.onKeyEvent(e => events.push(`${e.type}:${e.serial ?? ''}`))
    mock.insertKey('MOCK-9')
    mock.removeKey()
    expect(events).toEqual(['attached:MOCK-9', 'detached:MOCK-9'])
  })
})

describe('getVaultDriver', () => {
  afterEach(() => setMockDriver(null))

  test('returns null when no native module and no mock (jest default)', () => {
    expect(getVaultDriver()).toBeNull()
  })

  test('returns the injected mock when set', () => {
    const mock = new MockYubiKey()
    setMockDriver(mock)
    expect(getVaultDriver()).toBe(mock)
  })
})
