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
import { encodeChunk, estimateEncodedBytes, isEmptyChunk } from './codec'
import { GENERATION_CHUNK_THRESHOLD, MAX_ITEMS, MAX_ROUGH_SIZE, type BackupChain } from './constants'
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
import { isBackupPushEnabled } from './preference'

export interface PushDeps {
  storage: StorageExpoSQLite
  /** The wallet's m/0'/0' key. The backup identity and encryption key derive from it. */
  primaryKey: number[]
  /**
   * The network the wallet database belongs to. Folded into the derivation, so each
   * network pushes to its own server account under its own encryption key — a chunk from
   * a testnet database can never land in, or restore into, the mainnet log.
   */
  chain: BackupChain
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
  /** True when the chunk was too large for the server and nothing was sent. */
  oversized?: boolean
  /** True when the user has opted out of pushing; nothing was read or sent. */
  optedOut?: boolean
}

/**
 * Take at most one chunk and append it.
 *
 * One chunk per pass rather than draining in a loop: the monitor runs tasks back-to-back
 * without yielding, so a long pass would stall the JS thread. Successive passes drain the
 * backlog.
 */
export async function pushOnce (deps: PushDeps): Promise<PushResult> {
  // Checked FIRST, ahead of even reading the local database: the opt-out means no wallet
  // data leaves this device, and the cheapest way to guarantee that is to do nothing at
  // all. The cursor is left untouched, so opting back in resumes from where the log
  // stopped instead of skipping everything written while it was off.
  if (!(await isBackupPushEnabled())) {
    return { pushed: 0, bytes: 0, windowClosed: false, rotated: false, optedOut: true }
  }

  const client = resolveClient(deps)
  const pseudonym = backupPseudonym(deps.primaryKey, deps.chain)
  const deviceId = deps.deviceId ?? (await getDeviceId())

  let cursor = await loadCursor(deps.chain, pseudonym, deviceId)

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
    // Window exhausted. Advance `since` past everything seen and reset the offsets, as
    // EntitySyncState does when its merge reports done — except that we advance PAST the
    // high-water mark rather than onto it. See nextInstant.
    const advanced: PushCursor = {
      ...cursor,
      since: nextInstant(cursor.maxUpdatedAt) ?? cursor.since,
      maxUpdatedAt: undefined,
      offsets: zeroOffsets()
    }

    const rotated = shouldRotate(advanced)
    const next = rotated ? rotate(advanced) : advanced
    await saveCursor(deps.chain, pseudonym, deviceId, next)
    return { pushed: 0, bytes: 0, windowClosed: true, rotated }
  }

  // Bail BEFORE the expensive part when the chunk cannot possibly be accepted.
  //
  // maxRoughSize bounds what the toolbox accumulates across records; it cannot bound ONE
  // record. The cap is whatever the server publishes on GET /v1/limits (200 MiB since the
  // transaction-storage-capacity work; cached by the client after the first call) — with
  // records compressed at rest a chunk should never approach it, so tripping this gate
  // now means something is genuinely wrong rather than merely large.
  //
  // Ordering is still the point. Encrypting and signing a doomed payload is synchronous
  // CPU work that blocked the JS thread for ~50s per attempt on device; checking here
  // makes a doomed pass nearly free instead of nearly a minute.
  const estimate = estimateEncodedBytes(chunk)
  const { maxBlobBytes } = await client.limits()
  if (estimate > maxBlobBytes) {
    // Interpolated, not printf-style: React Native's console does not substitute %d, so a
    // format string prints its own placeholders and pushes the numbers to the end.
    console.log(
      `[backup] chunk too large for the server, skipping push · estimate=${estimate} bytes · ` +
        `cap=${maxBlobBytes} · nothing was encrypted or uploaded. This wallet cannot back ` +
        'up until the oversized record is handled.'
    )
    // Cursor deliberately untouched: advancing past this chunk would silently drop records
    // from the backup, which is worse than not backing up. The pass is now cheap, so the
    // monitor retrying costs nothing until the underlying limit is addressed.
    return { pushed: 0, bytes: 0, windowClosed: false, rotated: false, oversized: true }
  }

  const wallet = deriveBackupWallet(deps.primaryKey, deps.chain)
  const ciphertext = await encodeChunk(wallet, chunk, deps.chain)

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
      await saveCursor(deps.chain, pseudonym, deviceId, cursor)
      return { pushed: 0, bytes: 0, windowClosed: false, rotated: false }
    }
    // Anything else: leave the cursor untouched so the same chunk is retried next pass.
    throw e
  }

  // Only advance after the append succeeded, so a failure never skips records.
  await saveCursor(deps.chain, pseudonym, deviceId, {
    ...cursor,
    offsets: advanceOffsets(cursor, chunk),
    maxUpdatedAt: maxUpdatedAt(cursor.maxUpdatedAt, chunk),
    seq,
    prevSha256: sha,
    chunksInGeneration: cursor.chunksInGeneration + 1
  })

  return { pushed: 1, bytes: ciphertext.length, windowClosed: false, rotated: false }
}

/**
 * One client per (server, pseudonym), reused across passes. The client caches
 * the server's /v1/limits document — needed for the oversize gate and for the
 * identity key every auth proof signs toward — so constructing a fresh client
 * each pass would re-fetch it every minute for no reason.
 */
let cachedClient: { key: string, client: BackupClient } | undefined

function resolveClient (deps: PushDeps): BackupClient {
  if (deps.client != null) return deps.client
  if (deps.baseUrl == null || deps.baseUrl === '') {
    throw new Error('pushOnce requires either a client or a baseUrl')
  }
  const key = `${deps.baseUrl} ${backupPseudonym(deps.primaryKey, deps.chain)}`
  if (cachedClient?.key !== key) {
    cachedClient = { key, client: new BackupClient(deps.baseUrl, deps.primaryKey, deps.chain) }
  }
  return cachedClient.client
}

/**
 * The instant after a closed window's high-water mark — where the next window starts.
 *
 * This is the one place our cursor deliberately DIVERGES from `EntitySyncState`, which
 * sets `when = maxUpdated_at` exactly. The column comparison is `updated_at >= ?`
 * (storage/methods/findSql.ts), so starting the next window ON the high-water mark
 * re-reads every record sharing that timestamp. For the toolbox that is harmless: it
 * syncs into a storage that merges, so a re-read record is merged again and nothing
 * accumulates. Our writer is an append-only blob log, where the same re-read becomes a
 * brand-new encrypted blob — so the boundary record was uploaded again on the very next
 * window, forever, roughly one duplicate every two passes on a wallet that had gone
 * quiet. Each duplicate also counted toward GENERATION_CHUNK_THRESHOLD, so an idle
 * wallet re-uploaded its entire database about every 200 passes.
 *
 * Advancing by one millisecond is exact rather than approximate: SQLite stores these
 * columns as `toISOString()` text, whose resolution IS one millisecond, so this is the
 * next representable instant and no timestamp can hide in the gap.
 *
 * It cannot skip a record either. A window only closes when a chunk comes back empty,
 * which means nothing at or after `since` remained beyond the offsets — so everything up
 * to and including the high-water mark had already been read and appended. Anything
 * written later necessarily carries a greater `updated_at`, because the closing pass runs
 * at least MIN_PUSH_INTERVAL_MS after the pass that set the mark. (A device clock jumping
 * backwards could still orphan a record, but that was equally true of `>=` and is not
 * something a timestamp cursor can defend against.)
 */
function nextInstant (iso: string | undefined): string | undefined {
  if (iso == null) return undefined
  const t = Date.parse(iso)
  // An unparseable timestamp must not silently reset the window to the epoch; leaving it
  // alone means the caller falls back to the existing `since` and re-reads at worst.
  if (Number.isNaN(t)) return undefined
  return new Date(t + 1).toISOString()
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
