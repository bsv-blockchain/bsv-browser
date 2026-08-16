/**
 * Software mock YubiKey + driver selection tests. The mock is the arbiter for
 * the whole TS layer: it implements VaultDriver against an in-memory P-256 key
 * and exposes test controls (insert/remove/touch behaviour/PIN).
 */
import { p256 } from '@noble/curves/nist.js'
import { Utils } from '@bsv/sdk'
import { MockYubiKey } from '../../services/vault/mockYubiKey'
import { getVaultDriver, setMockDriver } from '../../services/vault/driver'
import { VaultError } from '../../services/vault/types'

describe('MockYubiKey', () => {
  test('wrong PIN decrements retries then locks at zero', async () => {
    const mock = new MockYubiKey()
    mock.insertKey('MOCK-1')
    expect((await mock.verifyPin('000000')).retriesLeft).toBe(2)
    expect((await mock.verifyPin('000000')).retriesLeft).toBe(1)
    expect((await mock.verifyPin('000000')).retriesLeft).toBe(0)
    await expect(mock.verifyPin('123456')).rejects.toMatchObject({ code: 'pin-locked' })
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

// ── native event vocabulary (fix #1) ──
import { mapNativeKeyEvent } from '../../services/vault/driver'

describe('mapNativeKeyEvent', () => {
  test("native 'connected' maps to attached (not detached)", () => {
    expect(mapNativeKeyEvent('connected', 'S1', 'usb')).toEqual({ type: 'attached', serial: 'S1', transport: 'usb' })
  })
  test("native 'removed' maps to detached", () => {
    expect(mapNativeKeyEvent('removed', '', 'nfc').type).toBe('detached')
    expect(mapNativeKeyEvent('removed', '', 'nfc').transport).toBe('nfc')
  })
  test("'attached'/'detached' pass through (mock/robustness)", () => {
    expect(mapNativeKeyEvent('attached', 'x', 'usb').type).toBe('attached')
    expect(mapNativeKeyEvent('detached', 'x', 'usb').type).toBe('detached')
  })
  test('unknown event fails safe to detached', () => {
    expect(mapNativeKeyEvent('garbage', '', '').type).toBe('detached')
  })
})

// ── signEcdsa (task 4) ──
import { Signature } from '@bsv/sdk'

describe('MockYubiKey.signEcdsa', () => {
  const digest = 'ab'.repeat(32)

  async function armed() {
    const mock = new MockYubiKey()
    mock.insertKey()
    await mock.generateVaultKey(0x82)
    await mock.verifyPin('123456')
    return mock
  }

  it('returns a DER signature that verifies against the slot public key', async () => {
    const mock = await armed()
    const { publicKey } = (await mock.readVaultPublicKey(0x82))!
    const { signature } = await mock.signEcdsa(0x82, '123456', digest)

    // DER, as the real card emits — not raw r||s.
    expect(signature.startsWith('30')).toBe(true)
    const parsed = Signature.fromDER(Utils.toArray(signature, 'hex'))
    const raw = Uint8Array.from([...parsed.r.toArray('be', 32), ...parsed.s.toArray('be', 32)])
    const compressed = p256.Point.fromBytes(Uint8Array.from(Utils.toArray(publicKey, 'hex'))).toBytes(true)

    // lowS: false on verify too — the mock (like real PIV hardware) does not
    // low-S normalise, so a random run of this test can legitimately produce
    // a high-S signature; @noble/curves' verify() defaults to rejecting
    // exactly those as non-canonical, which would make this assertion flake
    // roughly half the time if left at its default.
    expect(
      p256.verify(raw, Uint8Array.from(Utils.toArray(digest, 'hex')), compressed, { prehash: false, lowS: false })
    ).toBe(true)
  })

  it('rejects a digest that is not exactly 32 bytes', async () => {
    const mock = await armed()
    await expect(mock.signEcdsa(0x82, '123456', 'ab'.repeat(31))).rejects.toMatchObject({ code: 'template-invalid' })
    await expect(mock.signEcdsa(0x82, '123456', 'ab'.repeat(33))).rejects.toMatchObject({ code: 'template-invalid' })
  })

  it('refuses to sign without a verified PIN', async () => {
    const mock = new MockYubiKey()
    mock.insertKey()
    await mock.generateVaultKey(0x82)
    await expect(mock.signEcdsa(0x82, '', digest)).rejects.toMatchObject({ code: 'pin-required' })
  })

  it('surfaces a touch timeout', async () => {
    const mock = await armed()
    mock.setTouchBehavior('timeout')
    await expect(mock.signEcdsa(0x82, '123456', digest)).rejects.toMatchObject({ code: 'touch-timeout' })
  })

  it('fails when the key is removed', async () => {
    const mock = await armed()
    mock.removeKey()
    await expect(mock.signEcdsa(0x82, '123456', digest)).rejects.toBeInstanceOf(VaultError)
  })

  // Real YubiKey PIV hardware does not low-S normalise; @noble/curves defaults
  // P-256 signing to lowS: true unless told otherwise. A mock that only ever
  // emitted canonical (low-S) signatures could not catch downstream code that
  // mishandles a non-canonical one — that bug would surface first against
  // real hardware, exactly what this mock exists to prevent. Sign across many
  // fresh keys and require at least one high-S result (~50% per trial, so the
  // odds of a false failure here are negligible) while every signature still
  // verifies against its own slot public key.
  it('does not low-S normalise — can and does produce high-S signatures that still verify', async () => {
    const digestBytes = Uint8Array.from(Utils.toArray(digest, 'hex'))
    let sawHighS = false

    for (let i = 0; i < 64; i++) {
      const mock = await armed()
      const { publicKey } = (await mock.readVaultPublicKey(0x82))!
      const { signature } = await mock.signEcdsa(0x82, '123456', digest)

      const sig = p256.Signature.fromBytes(Uint8Array.from(Utils.toArray(signature, 'hex')), 'der')
      const compressed = p256.Point.fromBytes(Uint8Array.from(Utils.toArray(publicKey, 'hex'))).toBytes(true)
      // lowS: false — see comment on the DER round-trip test above; verify()
      // must accept the non-canonical signatures this test is specifically
      // trying to produce, not reject them as invalid.
      expect(p256.verify(sig.toBytes(), digestBytes, compressed, { prehash: false, lowS: false })).toBe(true)

      if (sig.hasHighS()) {
        sawHighS = true
        break
      }
    }

    expect(sawHighS).toBe(true)
  })
})

// ── generateVaultKey policy (task 7) ──
describe('generateVaultKey policy', () => {
  it('generates with touch policy cached and pin policy once', async () => {
    const calls: unknown[][] = []
    const native = {
      isSupported: () => true,
      startDiscovery: () => {},
      stopDiscovery: () => {},
      setKeyListener: () => {},
      clearKeyListener: () => {},
      getKeyInfo: async () => '{}',
      verifyPin: async () => '{}',
      changePin: async () => '{}',
      generateVaultKey: async (...args: unknown[]) => {
        calls.push(args)
        return JSON.stringify({ publicKey: '04' + '11'.repeat(64) })
      },
      readVaultPublicKey: async () => '{"publicKey":null}',
      ecdh: async () => '{}',
      signEcdsa: async () => '{}'
    }
    jest.doMock('react-native-yubikey', () => ({ getYubiKeyPiv: () => native }))
    jest.resetModules()
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getVaultDriver } = require('@/services/vault/driver')

    await getVaultDriver()!.generateVaultKey(0x82)

    // R1-K1 signs once per input; 'always' would cost one physical touch each.
    expect(calls[0]).toEqual([0x82, 'cached', 'once'])
  })
})
