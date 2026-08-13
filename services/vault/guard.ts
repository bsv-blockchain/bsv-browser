/**
 * Vault access guard (fixes the privilege-escalation review finding).
 *
 * Once a vault is enrolled, the PrivilegedKeyManager's key universe IS the
 * vault key `V` — the secret that controls `admin vault` funds. The toolbox
 * routes every BRC-100 `privileged: true` op through that manager, and this
 * app runs with `seekProtocolPermissionsForSigning` / public-key-revelation
 * permissions OFF, so nothing else gates them. That let any web origin, via the
 * CWI bridge, (1) `getPublicKey({ privileged: true, protocolID: [2,'vault'] })`
 * to enumerate deposit keys and (2) `createSignature({ privileged: true, ... })`
 * to sign a transaction spending the wallet-owned vault UTXOs — and because
 * `computeNetSpend` nets originator-supplied inputs against outputs, an
 * attacker who returns ~all value to themselves shows `netSpent <= 0` and never
 * trips the spending-authorization sheet.
 *
 * The toolbox's own signer cannot forge these signatures — it derives from the
 * NON-privileged root key and has no access to `V` — so the ONLY path to a
 * vault-spending signature is a privileged op. Blocking privileged ops for
 * external originators therefore closes both enumeration and spending in one
 * rule, and it also means the YubiKey ceremony can only ever be triggered by
 * the admin originator (our own vault UI), never by a page.
 *
 * Privileged operations have never been used by external origins in this app
 * (the pre-vault keyGetter returned the root key with no ceremony and no web
 * caller), so denying them breaks nothing real.
 */
import type { WalletInterface } from '@bsv/sdk'

/** BRC-100 methods that accept `privileged: true` and would return / use
 * privileged (vault) key material. */
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
