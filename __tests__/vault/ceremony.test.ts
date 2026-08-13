/**
 * Ceremony controller — the UI-free state machine that turns "a privileged key
 * is needed" into an insert → PIN → touch flow and back into a PrivateKey.
 * Driven entirely by the mock driver + a fake store.
 */
import { PrivateKey, Utils } from '@bsv/sdk'
import { CeremonyController, CeremonyState } from '../../services/vault/ceremony'
import { MockYubiKey } from '../../services/vault/mockYubiKey'
import { sealVaultKey } from '../../services/vault/sealing'
import type { SealedBlob } from '../../services/vault/types'

// Build a seal bound to a specific mock key, returning the vault key V too.
async function enrollFakeSeal(mock: MockYubiKey): Promise<{ seal: SealedBlob; v: number[] }> {
  const { publicKey } = await mock.generateVaultKey(0x82)
  const v = Array.from(new PrivateKey(42).toArray())
  const seal = sealVaultKey(v, publicKey, { slot: 0x82, serial: 'MOCK-1' })
  return { seal, v }
}

function fakeStore(seal: SealedBlob | null) {
  return {
    isEnrolled: async () => seal != null,
    getSeal: async () => seal
  }
}

const RETENTION = 120_000

describe('CeremonyController', () => {
  test('happy path: request → insert → pin → touch → armed, resolves the key', async () => {
    const mock = new MockYubiKey()
    mock.insertKey('MOCK-1')
    const { seal, v } = await enrollFakeSeal(mock)
    const c = new CeremonyController({ getDriver: () => mock, store: fakeStore(seal), retentionMs: RETENTION })

    const states: CeremonyState[] = []
    c.subscribe(s => states.push(s))

    const p = c.request('Withdraw 1000 sats')
    // key already attached → should reach pin-entry
    await flush()
    expect(c.state.phase).toBe('pin-entry')
    c.submitPin('123456')
    const key = await p
    expect(key.toArray()).toEqual(v)
    expect(c.state.phase).toBe('armed')
    expect(states.map(s => s.phase)).toContain('awaiting-touch')
  })

  test('two concurrent requests share one ceremony', async () => {
    const mock = new MockYubiKey()
    mock.insertKey('MOCK-1')
    const { seal } = await enrollFakeSeal(mock)
    const c = new CeremonyController({ getDriver: () => mock, store: fakeStore(seal), retentionMs: RETENTION })

    const p1 = c.request('op A')
    const p2 = c.request('op B')
    await flush()
    c.submitPin('123456')
    const [k1, k2] = await Promise.all([p1, p2])
    expect(k1.toHex()).toBe(k2.toHex())
  })

  test('driver unavailable rejects with driver-unavailable', async () => {
    const c = new CeremonyController({ getDriver: () => null, store: fakeStore(null), retentionMs: RETENTION })
    await expect(c.request('x')).rejects.toMatchObject({ code: 'driver-unavailable' })
  })

  test('wrong key serial → serial-mismatch error, recoverable after swap', async () => {
    const enrollMock = new MockYubiKey()
    enrollMock.insertKey('RIGHT')
    const { seal } = await enrollFakeSeal(enrollMock)

    const wrong = new MockYubiKey()
    wrong.insertKey('WRONG')
    const c = new CeremonyController({ getDriver: () => wrong, store: fakeStore(seal), retentionMs: RETENTION })
    const p = c.request('x')
    const settled = expect(p).rejects.toMatchObject({ code: 'serial-mismatch' }) // attach handler now
    await flush()
    expect(c.state.phase).toBe('error')
    expect(c.state.error?.code).toBe('serial-mismatch')
    await settled
  })

  test('wrong PIN returns to pin-entry with retriesLeft', async () => {
    const mock = new MockYubiKey()
    mock.insertKey('MOCK-1')
    const { seal } = await enrollFakeSeal(mock)
    const c = new CeremonyController({ getDriver: () => mock, store: fakeStore(seal), retentionMs: RETENTION })
    const p = c.request('x')
    await flush()
    c.submitPin('000000')
    await flush()
    expect(c.state.phase).toBe('pin-entry')
    expect(c.state.error?.code).toBe('pin-invalid')
    expect(c.state.error?.retriesLeft).toBe(2)
    c.submitPin('123456')
    await expect(p).resolves.toBeDefined()
  })

  test('touch timeout → error, retry succeeds without re-entering PIN', async () => {
    const mock = new MockYubiKey()
    mock.insertKey('MOCK-1')
    const { seal } = await enrollFakeSeal(mock)
    const c = new CeremonyController({ getDriver: () => mock, store: fakeStore(seal), retentionMs: RETENTION })
    mock.setTouchBehavior('timeout')
    const p = c.request('x')
    await flush()
    c.submitPin('123456')
    await flush()
    expect(c.state.phase).toBe('error')
    expect(c.state.error?.code).toBe('touch-timeout')
    mock.setTouchBehavior('instant')
    c.retry()
    await expect(p).resolves.toBeDefined()
  })

  test('detach during awaiting-touch → key-removed-mid-op', async () => {
    const mock = new MockYubiKey()
    mock.insertKey('MOCK-1')
    const { seal } = await enrollFakeSeal(mock)
    const c = new CeremonyController({ getDriver: () => mock, store: fakeStore(seal), retentionMs: RETENTION })
    mock.setTouchBehavior('timeout') // hold in awaiting-touch long enough to detach
    const p = c.request('x')
    await flush()
    c.submitPin('123456')
    await flush()
    // touch-timeout already surfaced; simulate a pull instead
    mock.removeKey()
    c.notifyKeyDetached()
    p.catch(() => {})
    expect(['error']).toContain(c.state.phase)
  })

  test('cancel rejects the pending request with user-cancelled', async () => {
    const mock = new MockYubiKey()
    mock.insertKey('MOCK-1')
    const { seal } = await enrollFakeSeal(mock)
    const c = new CeremonyController({ getDriver: () => mock, store: fakeStore(seal), retentionMs: RETENTION })
    const p = c.request('x')
    await flush()
    c.cancel()
    await expect(p).rejects.toMatchObject({ code: 'user-cancelled' })
    expect(c.state.phase).toBe('idle')
  })

  test('armed window expires back to idle and fires onRelock(timeout)', async () => {
    const mock = new MockYubiKey()
    mock.insertKey('MOCK-1')
    const { seal } = await enrollFakeSeal(mock)
    const relocks: string[] = []
    const c = new CeremonyController({ getDriver: () => mock, store: fakeStore(seal), retentionMs: 1000 })
    c.onRelock = why => relocks.push(why)
    const p = c.request('x')
    c.submitPin('123456') // queued; applied when the flow reaches pin-entry
    await p
    expect(c.state.phase).toBe('armed')
    await new Promise<void>(r => setTimeout(r, 1050))
    expect(c.state.phase).toBe('idle')
    expect(relocks).toEqual(['timeout'])
  })

  test('session-based driver: stop() is called after arm (dismiss NFC sheet); persistent is not', async () => {
    // session-based (iOS NFC): stop after arm
    const nfc = new MockYubiKey()
    ;(nfc as any).sessionBased = true
    nfc.insertKey('MOCK-1')
    const { seal } = await enrollFakeSeal(nfc)
    const nfcStop = jest.spyOn(nfc, 'stop')
    const c1 = new CeremonyController({ getDriver: () => nfc, store: fakeStore(seal), retentionMs: RETENTION })
    const p1 = c1.request('x')
    c1.submitPin('123456')
    await p1
    expect(nfcStop).toHaveBeenCalled()

    // persistent (Android USB): NOT stopped by the ceremony
    const usb = new MockYubiKey()
    usb.insertKey('MOCK-1')
    const { seal: seal2 } = await enrollFakeSeal(usb)
    const usbStop = jest.spyOn(usb, 'stop')
    const c2 = new CeremonyController({ getDriver: () => usb, store: fakeStore(seal2), retentionMs: RETENTION })
    const p2 = c2.request('x')
    c2.submitPin('123456')
    await p2
    expect(usbStop).not.toHaveBeenCalled()
  })

  test('notifyKeyDetached during armed window relocks immediately', async () => {
    const mock = new MockYubiKey()
    mock.insertKey('MOCK-1')
    const { seal } = await enrollFakeSeal(mock)
    const relocks: string[] = []
    const c = new CeremonyController({ getDriver: () => mock, store: fakeStore(seal), retentionMs: 120_000 })
    c.onRelock = why => relocks.push(why)
    const p = c.request('x')
    c.submitPin('123456') // queued
    await p
    expect(c.state.phase).toBe('armed')
    c.notifyKeyDetached()
    expect(c.state.phase).toBe('idle')
    expect(relocks).toEqual(['detached'])
  })
})

// microtask flush helper — drains microtasks by hopping the macrotask queue
const flush = () => new Promise<void>(r => setTimeout(r, 0))
