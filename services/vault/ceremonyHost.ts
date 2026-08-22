/**
 * The process-wide ceremony singleton.
 *
 * Constructed once against the live driver + store so the vault transfer flow
 * and the React vault context drive the SAME ceremony. Kept out of any React
 * module so importing it never pulls in the component graph.
 */
import { CeremonyController, VaultKeyHandle, VaultProgress } from './ceremony'
import { getVaultDriver } from './driver'
import { vaultStore } from './vaultStore'

/** How long an armed session stays usable before it relocks — and, since the
 * ceremony now holds the unwrapped vault key rather than a signing session,
 * how long that key may live in memory. */
export const VAULT_RETENTION_MS = 120_000

export const ceremony = new CeremonyController({
  getDriver: getVaultDriver,
  store: {
    // Only what the ceremony needs to run the tap: which slot to talk to and
    // which card is allowed to answer. v4 meta holds no key material at all —
    // everything spendable lives inside the seal.
    getMeta: async () => {
      const m = await vaultStore.getMeta()
      return m ? { slot: m.slot, yubiSerial: m.yubiSerial } : null
    },
    getSeal: () => vaultStore.getSeal()
  },
  retentionMs: VAULT_RETENTION_MS
})

/** Tap the YubiKey to unwrap the vault key for one operation. Callers MUST
 * release() in a finally — that is what drops the key and dismisses the NFC
 * sheet. */
export function requestVaultKey(reason: string): Promise<VaultKeyHandle> {
  return ceremony.requestKey(reason)
}

/** Report post-arm progress (preparing / broadcasting) so the ceremony sheet
 * can show activity through the seconds-long stretches where the JS thread or
 * the network is busy, and so the retention window tracks a live operation
 * instead of expiring underneath it. A no-op when nothing is armed, which is
 * what keeps the K1 recovery sweep from raising a sheet. */
export function noteVaultProgress(p: VaultProgress): void {
  ceremony.noteProgress(p)
}
