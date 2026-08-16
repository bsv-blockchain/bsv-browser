/**
 * Vault access guard (fixes the privilege-escalation review finding).
 *
 * PrivilegedKeyManager's key universe is the wallet's master HD root key — a
 * strictly more sensitive key than the per-app `primaryKey` (m/0'/0') that
 * every ordinary, non-privileged operation signs with. That is true whether
 * or not a vault is enrolled: the R1-K1 vault does not route through this
 * manager at all (the YubiKey signs the R1 branch directly, and the K1 branch
 * is signed from the vault's own HD node — derived from the main mnemonic
 * plus a vault passphrase that the root key cannot reach, since BIP39's
 * `toSeed` is one-way and passphrase-dependent). The toolbox routes every
 * BRC-100 `privileged: true` op through PrivilegedKeyManager regardless, and
 * this app runs with `seekProtocolPermissionsForSigning` / public-key-
 * revelation permissions OFF, so nothing else gates them. That let any web
 * origin, via the CWI bridge, use `getPublicKey({ privileged: true, ... })`,
 * `createSignature`, `encrypt`/`decrypt`, or HMAC ops to reveal or sign with
 * the root key — none of which are spend actions, so none of them ever trip
 * the spending-authorization sheet.
 *
 * Blocking privileged ops for external originators closes that exposure, and
 * it also means the YubiKey ceremony can only ever be triggered by the admin
 * originator (our own vault UI), never by a page.
 *
 * Privileged operations have never been used by external origins in this app
 * (the keyGetter has only ever returned the root key with no ceremony and no
 * web caller — first because there was no vault, now because the vault no
 * longer routes through it either), so denying them breaks nothing real.
 */
import type { WalletInterface } from '@bsv/sdk'

/** BRC-100 methods that accept `privileged: true` and would return / use
 * privileged (root) key material. */
const PRIVILEGED_CAPABLE = new Set<keyof WalletInterface>([
  'getPublicKey',
  'revealCounterpartyKeyLinkage',
  'revealSpecificKeyLinkage',
  'encrypt',
  'decrypt',
  'createHmac',
  'verifyHmac',
  'createSignature',
  'verifySignature'
])

export class VaultAccessDenied extends Error {
  constructor(method: string, originator: string) {
    super(`Privileged operation "${method}" is not permitted for origin "${originator || 'unknown'}"`)
    this.name = 'VaultAccessDenied'
  }
}

/**
 * Wrap a wallet so that `privileged: true` operations from any originator other
 * than `adminOriginator` are rejected. All other calls pass straight through.
 * Apply this to the wallet handed to EXTERNAL callers (the in-tab CWI bridge and
 * the desktop-pairing WalletClient); the vault's own UI keeps calling the
 * unwrapped permissions manager with the admin originator.
 */
export function guardVaultAccess<T extends WalletInterface>(wallet: T, adminOriginator: string): T {
  return new Proxy(wallet, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== 'function' || !PRIVILEGED_CAPABLE.has(prop as keyof WalletInterface)) {
        return typeof value === 'function' ? value.bind(target) : value
      }
      return (args: unknown, originator?: string) => {
        const privileged = !!(args && typeof args === 'object' && (args as { privileged?: boolean }).privileged)
        if (privileged && originator !== adminOriginator) {
          return Promise.reject(new VaultAccessDenied(String(prop), originator ?? ''))
        }
        return (value as (a: unknown, o?: string) => unknown)(args, originator)
      }
    }
  })
}
