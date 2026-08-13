/**
 * Privileged keyGetter — the seam that re-points BRC-100 privileged operations
 * at the vault. Not enrolled → the legacy root key, byte-identical to today.
 * Enrolled → resolves through the ceremony.
 */
import { PrivateKey } from '@bsv/sdk'
import { makePrivilegedKeyGetter } from '../../services/vault/privileged'

const rootKey = new PrivateKey(7)

describe('makePrivilegedKeyGetter', () => {
  test('not enrolled → returns the legacy root key', async () => {
    const getter = makePrivilegedKeyGetter({
      getLegacyRootKey: () => rootKey,
      isEnrolled: async () => false,
      requestCeremony: async () => {
        throw new Error('ceremony should not run when not enrolled')
      }
    })
    const k = await getter('some reason')
    expect(k.toHex()).toBe(rootKey.toHex())
  })

  test('enrolled → resolves via the ceremony with the given reason', async () => {
    const vaultKey = new PrivateKey(99)
    const reasons: string[] = []
    const getter = makePrivilegedKeyGetter({
      getLegacyRootKey: () => rootKey,
      isEnrolled: async () => true,
      requestCeremony: async reason => {
        reasons.push(reason)
        return vaultKey
      }
    })
    const k = await getter('Withdraw 5000 sats')
    expect(k.toHex()).toBe(vaultKey.toHex())
    expect(reasons).toEqual(['Withdraw 5000 sats'])
  })
})
