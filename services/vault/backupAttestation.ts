/**
 * Did this wallet's owner back up?
 *
 * This is an ADVISORY record, not a security control. It stores the fact that
 * a user pressed "I have written these down" or completed a print — nothing
 * verifies that paper exists. It gates the vault because inviting someone to
 * lock funds behind a hardware key with no recovery path is a lie, not because
 * the flag protects anything.
 *
 * Scoped per wallet identity ON PURPOSE. Logout clears only four keys and
 * "Delete Wallet" is wired straight to logout(), so a global key would survive
 * a wipe and the next wallet on the device would be born already backed up.
 *
 * Follows vaultStore's conventions: a frozen object literal with async
 * accessors, a numeric `v` discriminant, and getters that swallow parse errors
 * and return null instead of throwing.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'

export const ATTEST_KEY_PREFIX = 'vault_backup_attest_v1_'

export type BackupMedium = 'phrase' | 'shares'

export interface BackupAttestation {
  v: 1
  /** Which route the user took. Both are equivalent for recovery. */
  medium: BackupMedium
  at: number
}

/** Last 8 hex chars of the identity key — the app's established scope suffix. */
const scopeKey = (identityKey: string): string => ATTEST_KEY_PREFIX + identityKey.slice(-8)

export const backupAttestation = {
  async get(identityKey: string): Promise<BackupAttestation | null> {
    const raw = await AsyncStorage.getItem(scopeKey(identityKey))
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as BackupAttestation
      return parsed?.v === 1 ? parsed : null
    } catch {
      return null
    }
  },

  async set(identityKey: string, medium: BackupMedium): Promise<void> {
    const record: BackupAttestation = { v: 1, medium, at: Date.now() }
    await AsyncStorage.setItem(scopeKey(identityKey), JSON.stringify(record))
  },

  async clear(identityKey: string): Promise<void> {
    await AsyncStorage.removeItem(scopeKey(identityKey))
  },

  /** Logout has no identity key to hand, so sweep the prefix. */
  async clearAll(): Promise<void> {
    const keys = await AsyncStorage.getAllKeys()
    const mine = keys.filter(k => k.startsWith(ATTEST_KEY_PREFIX))
    if (mine.length > 0) await AsyncStorage.multiRemove(mine)
  }
}

/**
 * The wallet surface needed to scope an attestation. Structural on purpose:
 * both call sites hold a WalletPermissionsManager, but this module only ever
 * needs the identity key.
 */
export interface AttestationIdentitySource {
  getPublicKey(args: unknown, originator: string): Promise<{ publicKey: string }>
}

/**
 * Resolve the wallet identity that scopes an attestation, on demand.
 *
 * On demand rather than from cached state: a screen that reads a key populated
 * by a mount effect can act before that effect resolves, and would then skip
 * the write silently.
 *
 * Guarded — a rejecting getPublicKey (managers not ready, permission denied)
 * resolves to null rather than propagating. Callers treat null as "cannot
 * attest right now"; an unguarded rejection would surface as an unhandled
 * promise instead of something the user can see.
 */
export async function resolveAttestationIdentity(
  wallet: AttestationIdentitySource | null | undefined,
  adminOriginator: string
): Promise<string | null> {
  try {
    const r = await wallet?.getPublicKey({ identityKey: true }, adminOriginator)
    return r?.publicKey || null
  } catch (err) {
    console.warn('[backupAttestation] identity lookup failed:', err)
    return null
  }
}

/** This wallet's attestation, or null when there is none — or no identity yet. */
export async function readBackupAttestation(
  wallet: AttestationIdentitySource | null | undefined,
  adminOriginator: string
): Promise<BackupAttestation | null> {
  const identityKey = await resolveAttestationIdentity(wallet, adminOriginator)
  if (!identityKey) return null
  try {
    return await backupAttestation.get(identityKey)
  } catch (err) {
    console.warn('[backupAttestation] read failed:', err)
    return null
  }
}

/**
 * Record that the user backed up. The single writer — every surface that can
 * satisfy the vault's backup prerequisite goes through here, so the guard
 * against an unresolved identity cannot drift between them.
 *
 * Returns false when nothing was persisted, and NEVER throws. Callers must
 * surface a false: treating it as success tells the user they are backed up
 * while the deposit gate still refuses them, with nothing on screen to explain
 * why.
 */
export async function recordBackupAttestation(
  wallet: AttestationIdentitySource | null | undefined,
  adminOriginator: string,
  medium: BackupMedium
): Promise<boolean> {
  const identityKey = await resolveAttestationIdentity(wallet, adminOriginator)
  if (!identityKey) return false
  try {
    await backupAttestation.set(identityKey, medium)
    return true
  } catch (err) {
    console.warn('[backupAttestation] write failed:', err)
    return false
  }
}
