/**
 * The process-wide ceremony singleton.
 *
 * Constructed once against the live driver + store so the vault transfer flow
 * and the React vault context drive the SAME ceremony. Kept out of any React
 * module so importing it never pulls in the component graph.
 */
import { CeremonyController, VaultProgress, VaultR1Signer } from './ceremony'
import { getVaultDriver } from './driver'
import { vaultStore } from './vaultStore'

/** How long an armed session stays usable before it relocks. */
export const VAULT_RETENTION_MS = 120_000

export const ceremony = new CeremonyController({
  getDriver: getVaultDriver,
  store: {
    getMeta: async () => {
      const m = await vaultStore.getMeta()
      return m ? { slot: m.slot, yubiSerial: m.yubiSerial, r1PublicKey: m.r1PublicKey } : null
    }
  },
  retentionMs: VAULT_RETENTION_MS
})

/** Arm the YubiKey for a vault spend. Callers MUST release() in a finally. */
export function requestVaultSigner(reason: string): Promise<VaultR1Signer> {
  return ceremony.requestSigner(reason)
}

/** Report post-arm progress (preparing / signing N of M / broadcasting) so the
 * ceremony sheet can show activity through the seconds-long stretches where the
 * JS thread is busy building R1 unlocking scripts. A no-op when no session is
 * armed, which is what keeps the K1 recovery sweep from raising a sheet. */
export function noteVaultProgress(p: VaultProgress): void {
  ceremony.noteProgress(p)
}
