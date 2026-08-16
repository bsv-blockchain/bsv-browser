/**
 * One backup push pass.
 *
 * Reads a delta `SyncChunk` straight from the local storage provider, encrypts it, and
 * appends it to the remote log.
 *
 * It deliberately does NOT go through `WalletStorageManager`. `updateBackups` and
 * `syncToWriter` take the manager's sync lock via `runAsSync`, which blocks every read and
 * write against active storage for the duration — unacceptable against the project's
 * standing "chrome never JS-blocked" goal. Registering a remote as a backup store also hits
 * the `_conflictingActives` trap, where a fresh remote user reports itself as the active
 * storage and `updateBackups()` then throws `WERR_NOT_ACTIVE`.
 *
 * Reading without the lock means a chunk can be taken mid-write. That is safe here: chunks
 * are `since`-based and replay is idempotent, so a torn read corrects itself on the next
 * pass.
 */
import type { StorageExpoSQLite } from '@/storage'
import type { SyncChunk } from '@bsv/wallet-toolbox-mobile/out/src/sdk/WalletStorage.interfaces'
import { BackupClient, BackupHttpError, ERR_SEQ_CONFLICT } from './client'
import { encodeChunk, isEmptyChunk } from './codec'
import { GENERATION_CHUNK_THRESHOLD, MAX_ITEMS, MAX_ROUGH_SIZE } from './constants'
import {
  ENTITY_NAMES,
  ENTITY_TO_CHUNK_ARRAY,
  freshCursor,
  loadCursor,
  offsetsToArgs,
  saveCursor,
  zeroOffsets,
  type PushCursor
} from './cursor'
import { backupPseudonym, deriveBackupWallet } from './derive'
import { getDeviceId } from './deviceId'

export interface PushDeps {
  storage: StorageExpoSQLite
  /** The wallet's m/0'/0' key. The backup identity and encryption key derive from it. */
  primaryKey: number[]
  /** The wallet's real identity key — used only for the LOCAL user lookup, never sent. */
  identityKey: string
  /** Supply exactly one of these. */
  baseUrl?: string
  client?: BackupClient
  deviceId?: string
}

export interface PushResult {
  /** Chunks appended this pass (0 or 1). */
  pushed: number
  /** Ciphertext bytes appended. */
  bytes: number
  /** True when the `since` window closed and the cursor advanced. */
  windowClosed: boolean
  /** True when a new generation was started. */
  rotated: boolean
}

/**
 * Take at most one chunk and append it.
 *
 * One chunk per pass rather than draining in a loop: the monitor runs tasks back-to-back
 * without yielding, so a long pass would stall the JS thread. Successive passes drain the
 * backlog.
 */
export async function pushOnce (deps: PushDeps): Promise<PushResult> {
  const client = resolveClient(deps)
  const pseudonym = backupPseudonym(deps.primaryKey)
  const deviceId = deps.deviceId ?? (await getDeviceId())

  let cursor = await loadCursor(pseudonym, deviceId)

  const chunk = await deps.storage.getSyncChunk({
    identityKey: deps.identityKey,
    fromStorageIdentityKey: deps.identityKey,
    toStorageIdentityKey: pseudonym,
    since: cursor.since != null ? new Date(cursor.since) : undefined,
    maxRoughSize: MAX_ROUGH_SIZE,
    maxItems: MAX_ITEMS,
    offsets: offsetsToArgs(cursor.offsets)
  })

  if (isEmptyChunk(chunk)) {
    // Window exhausted. Advance `since` past everything seen and reset the offsets, exactly
    // as EntitySyncState does when its merge reports done.
    const advanced: PushCursor = {
      ...cursor,
      since: cursor.maxUpdatedAt ?? cursor.since,
      maxUpdatedAt: undefined,
      offsets: zeroOffsets()
    }

    const rotated = shouldRotate(advanced)
    const next = rotated ? rotate(advanced) : advanced
    await saveCursor(pseudonym, deviceId, next)
    return { pushed: 0, bytes: 0, windowClosed: true, rotated }
  }

  const wallet = deriveBackupWallet(deps.primaryKey)
  const ciphertext = await encodeChunk(wallet, chunk)

  const seq = cursor.seq + 1
  let sha: string
  try {
    const r = await client.append(deviceId, cursor.generation, seq, cursor.prevSha256, ciphertext)
    sha = r.sha256
  } catch (e) {
    if (e instanceof BackupHttpError && e.code === ERR_SEQ_CONFLICT) {
      // The server and the cursor disagree about the head. Resynchronise from the server's
      // view rather than retrying into the same wall — this happens after a reinstall that
      // kept the log but lost the cursor, or if two devices shared a device id.
      cursor = await resyncFromServer(client, pseudonym, deviceId, cursor)
      await saveCursor(pseudonym, deviceId, cursor)
      return { pushed: 0, bytes: 0, windowClosed: false, rotated: false }
    }
    // Anything else: leave the cursor untouched so the same chunk is retried next pass.
    throw e
  }

  // Only advance after the append succeeded, so a failure never skips records.
  await saveCursor(pseudonym, deviceId, {
    ...cursor,
    offsets: advanceOffsets(cursor, chunk),
    maxUpdatedAt: maxUpdatedAt(cursor.maxUpdatedAt, chunk),
    seq,
    prevSha256: sha,
    chunksInGeneration: cursor.chunksInGeneration + 1
  })

  return { pushed: 1, bytes: ciphertext.length, windowClosed: false, rotated: false }
}

function resolveClient (deps: PushDeps): BackupClient {
  if (deps.client != null) return deps.client
  if (deps.baseUrl == null || deps.baseUrl === '') {
    throw new Error('pushOnce requires either a client or a baseUrl')
  }
  return new BackupClient(deps.baseUrl, deps.primaryKey)
}

/** Per-entity consumed counts grow by what this chunk carried. */
function advanceOffsets (cursor: PushCursor, chunk: SyncChunk): PushCursor['offsets'] {
  const c = chunk as unknown as Record<string, unknown[] | undefined>
  const next = { ...cursor.offsets }
  for (const name of ENTITY_NAMES) {
    next[name] = (next[name] ?? 0) + (c[ENTITY_TO_CHUNK_ARRAY[name]]?.length ?? 0)
  }
  return next
}

/** Greatest `updated_at` across everything in this chunk. */
function maxUpdatedAt (current: string | undefined, chunk: SyncChunk): string | undefined {
  const c = chunk as unknown as Record<string, Array<Record<string, unknown>> | undefined> // eslint-disable-line @typescript-eslint/array-type
  let max = current

  for (const name of ENTITY_NAMES) {
    for (const item of c[ENTITY_TO_CHUNK_ARRAY[name]] ?? []) {
      const raw = item.updated_at
      if (raw == null) continue
      const iso = raw instanceof Date ? raw.toISOString() : String(raw)
      if (max == null || iso > max) max = iso
    }
  }
  return max
}

/**
 * Rotate only at a window boundary.
 *
 * A generation is meant to be a coherent snapshot, so starting one mid-window would leave a
 * partially written generation that a restore could not trust.
 */
function shouldRotate (cursor: PushCursor): boolean {
  return cursor.chunksInGeneration >= GENERATION_CHUNK_THRESHOLD
}

/** Begin a new generation: a full snapshot, from sequence one, with no `since` filter. */
function rotate (cursor: PushCursor): PushCursor {
  return freshCursor(cursor.generation + 1)
}

/**
 * Rebuild the cursor from the server's head after a sequence conflict.
 *
 * The server is authoritative about what it holds. Rather than guess which records the
 * remote log already covers, start a fresh generation — one extra full snapshot is cheap
 * next to a restore with a hole in it.
 */
async function resyncFromServer (
  client: BackupClient,
  _pseudonym: string,
  deviceId: string,
  cursor: PushCursor
): Promise<PushCursor> {
  const devices = await client.manifest()
  const newest = devices
    .filter(d => d.deviceId === deviceId)
    .reduce<number>((max, d) => Math.max(max, d.generation), cursor.generation)

  return freshCursor(newest + 1)
}
