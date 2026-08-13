/**
 * The PrivilegedKeyManager keyGetter seam.
 *
 * The toolbox routes every BRC-100 `privileged: true` operation through the
 * PrivilegedKeyManager's keyGetter. Today that getter trivially returns the
 * wallet root key (no ceremony). This factory preserves that exactly when the
 * vault is not enrolled, and swaps in the YubiKey ceremony when it is — so
 * enabling the vault is the only thing that changes privileged behaviour, and
 * disabling it restores today's behaviour with zero migration.
 *
 * SECURITY: the returned key is handed straight to the PrivilegedKeyManager,
 * which holds it in its own obfuscated store with scheduled destruction. Never
 * log it here.
 */
import { PrivateKey } from '@bsv/sdk'

export const VAULT_RETENTION_MS = 120_000

export function makePrivilegedKeyGetter(opts: {
  getLegacyRootKey: () => PrivateKey
  isEnrolled: () => Promise<boolean>
  requestCeremony: (reason: string) => Promise<PrivateKey>
}): (reason: string) => Promise<PrivateKey> {
  return async (reason: string): Promise<PrivateKey> => {
    if (!(await opts.isEnrolled())) return opts.getLegacyRootKey()
    return opts.requestCeremony(reason)
  }
}
