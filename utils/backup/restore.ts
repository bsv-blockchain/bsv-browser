/**
 * Restore orchestration.
 *
 * Given nothing but a recovered seed (or the primary key from printed shares), rebuild the
 * wallet database from the encrypted log.
 */
import type { StorageExpoSQLite } from '@/storage'
import { BackupClient, type DeviceSummary } from './client'
import { deriveBackupWallet } from './derive'
import { RemoteSyncReader } from './RemoteSyncReader'

export interface RestoreDeps {
  /** A fresh, migrated storage provider to replay into. */
  storage: StorageExpoSQLite
  /** The wallet's m/0'/0' key, from the mnemonic or from recovery shares. */
  primaryKey: number[]
  /** The wallet's real identity key, for the local user record. */
  identityKey: string
  /** Supply exactly one. */
  baseUrl?: string
  client?: BackupClient
  /** Defaults to the most recently updated device in the manifest. */
  deviceId?: string
  /** Defaults to the newest generation for that device. */
  generation?: number
  /**
   * Called after each replayed chunk, with how many have landed and how many the
   * generation holds. `total` is 0 until the index has been read, i.e. before the
   * first chunk arrives.
   */
  onProgress?: (chunks: number, total: number) => void
}

export interface RestoreResult {
  chunks: number
  deviceId: string
  generation: number
}

/** What the user can choose between when more than one device has a backup. */
export async function listBackups (deps: {
  primaryKey: number[]
  baseUrl?: string
  client?: BackupClient
}): Promise<DeviceSummary[]> {
  return await resolveClient(deps).manifest()
}

/**
 * Replay the newest complete generation into `storage`.
 *
 * Picks the newest generation rather than the oldest because a generation is a full
 * snapshot: the newest one alone is sufficient, and it is the shortest replay.
 */
export async function restoreFromBackup (deps: RestoreDeps): Promise<RestoreResult> {
  const client = resolveClient(deps)
  const wallet = deriveBackupWallet(deps.primaryKey)

  const devices = await client.manifest()
  if (devices.length === 0) {
    throw new Error('No backup found for this wallet')
  }

  const chosen = pickTarget(devices, deps.deviceId, deps.generation)

  const settings = await deps.storage.makeAvailable()

  // processSyncChunk's preconditions, which a fresh, just-migrated database does
  // not meet: it does verifyTruthy(findUserByIdentityKey(identityKey)) and then
  // verifyOne(findSyncStates({storageIdentityKey: fromStorageIdentityKey, userId})).
  // On a new device the restore runs BEFORE addWalletStorageProvider/getAuth ever
  // create the user row, so without seeding both rows here every replay dies with
  // the toolbox's bare "A truthy value is required." Both helpers are idempotent
  // (find-or-insert), so a retry converges.
  const { user } = await deps.storage.findOrInsertUser(deps.identityKey)
  await deps.storage.findOrInsertSyncStateAuth(
    { userId: user.userId, identityKey: deps.identityKey },
    chosen.deviceId,
    'backup-restore'
  )

  const reader = new RemoteSyncReader(client, wallet, chosen.deviceId, chosen.generation, settings)

  let chunks = 0
  for (;;) {
    const chunk = await reader.getSyncChunk({
      identityKey: deps.identityKey,
      fromStorageIdentityKey: chosen.deviceId,
      toStorageIdentityKey: settings.storageIdentityKey,
      maxRoughSize: 0,
      maxItems: 0,
      offsets: []
    })

    const result = await deps.storage.processSyncChunk({
      identityKey: deps.identityKey,
      fromStorageIdentityKey: chosen.deviceId,
      toStorageIdentityKey: settings.storageIdentityKey,
      maxRoughSize: 0,
      maxItems: 0,
      offsets: []
    }, chunk)

    if (result.done) break
    chunks++
    deps.onProgress?.(chunks, reader.length)

    // The reader is finite; this guards against a processSyncChunk that never reports done.
    if (chunks > reader.length) break
  }

  return { chunks, deviceId: chosen.deviceId, generation: chosen.generation }
}

function pickTarget (
  devices: DeviceSummary[],
  deviceId?: string,
  generation?: number
): { deviceId: string, generation: number } {
  const candidates = deviceId != null ? devices.filter(d => d.deviceId === deviceId) : devices
  if (candidates.length === 0) {
    throw new Error(`No backup found for device ${String(deviceId)}`)
  }

  if (generation != null) {
    const exact = candidates.find(d => d.generation === generation)
    if (exact == null) throw new Error(`No backup found for generation ${generation}`)
    return { deviceId: exact.deviceId, generation: exact.generation }
  }

  // Most recently written device, then its newest generation.
  const newest = candidates.reduce((best, d) =>
    d.updatedAt > best.updatedAt ? d : best
  )
  const newestGeneration = candidates
    .filter(d => d.deviceId === newest.deviceId)
    .reduce((best, d) => (d.generation > best.generation ? d : best))

  return { deviceId: newestGeneration.deviceId, generation: newestGeneration.generation }
}

function resolveClient (deps: { primaryKey: number[], baseUrl?: string, client?: BackupClient }): BackupClient {
  if (deps.client != null) return deps.client
  if (deps.baseUrl == null || deps.baseUrl === '') {
    throw new Error('restore requires either a client or a baseUrl')
  }
  return new BackupClient(deps.baseUrl, deps.primaryKey)
}
