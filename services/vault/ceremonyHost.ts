/**
 * The process-wide ceremony singleton.
 *
 * Constructed once against the live driver + store so both the wallet
 * (PrivilegedKeyManager keyGetter → requestCeremony) and the React vault
 * context (which subscribes for the sheet UI) drive the SAME ceremony. Kept
 * out of any React module so importing it never pulls in the component graph —
 * WalletContext and VaultContext both depend on this, not on each other.
 */
import { CeremonyController } from './ceremony'
import { getVaultDriver } from './driver'
import { vaultStore } from './vaultStore'
import { VAULT_RETENTION_MS } from './privileged'

export const ceremony = new CeremonyController({
  getDriver: getVaultDriver,
  store: { isEnrolled: () => vaultStore.isEnrolled(), getSeal: () => vaultStore.getSeal() },
  retentionMs: VAULT_RETENTION_MS
})

/** Passed to makePrivilegedKeyGetter as `requestCeremony`. */
export function requestCeremony(reason: string): Promise<import('@bsv/sdk').PrivateKey> {
  return ceremony.request(reason)
}
