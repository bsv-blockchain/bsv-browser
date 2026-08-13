/**
 * DEV-only convenience: run the whole vault stack against the software mock
 * YubiKey without hardware. Toggled from wallet-config (DEV builds only).
 *
 * In-session only — installs a MockYubiKey with a key already "inserted" and
 * a non-default PIN so enrollment does not force a PIN change. Clearing it
 * reverts getVaultDriver() to null (or the real native module, if present).
 * Kept in its own module so driver.ts never imports the mock.
 */
import { setMockDriver } from './driver'
import { MockYubiKey } from './mockYubiKey'

let active: MockYubiKey | null = null

export function isMockDriverActive(): boolean {
  return active != null
}

export function setMockDriverEnabled(on: boolean): void {
  if (on) {
    const mock = new MockYubiKey()
    mock.setPin('123456')
    mock.insertKey('MOCK-DEV-1')
    active = mock
    setMockDriver(mock)
  } else {
    active = null
    setMockDriver(null)
  }
}
