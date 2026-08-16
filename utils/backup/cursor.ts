/**
 * Push cursor.
 *
 * The toolbox normally keeps sync state on the *writer* — `EntitySyncState` is loaded from
 * whatever storage is receiving the data. Our writer is an opaque blob log that holds no
 * state at all, so the client keeps the equivalent bookkeeping here.
 *
 * The semantics mirror `EntitySyncState` exactly, because a divergence would either skip
 * records (a silent hole in a restore) or resend them forever:
 *
 *  · `offsets` are per-entity counts of items already consumed *within the current `since`
 *    window*, and grow as chunks are taken.
 *  · When a chunk comes back completely empty the window is exhausted: `since` advances to
 *    the greatest `updated_at` seen, and every offset resets to zero.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import { cursorKey } from './constants'

/** The twelve entity names used by `offsets`, singular and camelCase, as the toolbox emits them. */
export const ENTITY_NAMES = [
  'provenTx',
  'outputBasket',
  'outputTag',
  'txLabel',
  'transaction',
  'output',
  'txLabelMap',
  'outputTagMap',
  'certificate',
  'certificateField',
  'commission',
  'provenTxReq'
] as const

export type EntityName = (typeof ENTITY_NAMES)[number]

/** Maps an offset entity name to its plural array on a SyncChunk. */
export const ENTITY_TO_CHUNK_ARRAY: Record<EntityName, string> = {
  provenTx: 'provenTxs',
  outputBasket: 'outputBaskets',
  outputTag: 'outputTags',
  txLabel: 'txLabels',
  transaction: 'transactions',
  output: 'outputs',
  txLabelMap: 'txLabelMaps',
  outputTagMap: 'outputTagMaps',
  certificate: 'certificates',
  certificateField: 'certificateFields',
  commission: 'commissions',
  provenTxReq: 'provenTxReqs'
}

export interface PushCursor {
  /** ISO timestamp; only records updated at or after this are considered. */
  since?: string
  /** Per-entity consumed counts within the current `since` window. */
  offsets: Record<EntityName, number>
  /** Greatest `updated_at` seen in this window; becomes `since` when the window closes. */
  maxUpdatedAt?: string
  /** Current generation. Generations are full snapshots; older ones get pruned. */
  generation: number
  /** Sequence of the last chunk appended in this generation. */
  seq: number
  /** sha256 of the last appended chunk, chaining the log so gaps are detectable. */
  prevSha256?: string
  /** Chunks appended in this generation, used to decide when to rotate. */
  chunksInGeneration: number
}

export function freshCursor (generation = 1): PushCursor {
  return {
    since: undefined,
    offsets: zeroOffsets(),
    maxUpdatedAt: undefined,
    generation,
    seq: 0,
    prevSha256: undefined,
    chunksInGeneration: 0
  }
}

export function zeroOffsets (): Record<EntityName, number> {
  const out = {} as Record<EntityName, number>
  for (const name of ENTITY_NAMES) out[name] = 0
  return out
}

/** Offsets in the array-of-pairs shape `RequestSyncChunkArgs` expects. */
// eslint-disable-next-line @typescript-eslint/array-type -- matches the SDK's own signature
export function offsetsToArgs (offsets: Record<EntityName, number>): Array<{ name: string, offset: number }> {
  return ENTITY_NAMES.map(name => ({ name, offset: offsets[name] ?? 0 }))
}

export async function loadCursor (pseudonym: string, deviceId: string): Promise<PushCursor> {
  const raw = await AsyncStorage.getItem(cursorKey(pseudonym, deviceId))
  if (raw == null) return freshCursor()

  try {
    const parsed = JSON.parse(raw) as Partial<PushCursor>
    return {
      since: parsed.since,
      // Merge over a zeroed base so a cursor written by an older build, before a new
      // entity existed, does not produce an undefined offset.
      offsets: { ...zeroOffsets(), ...(parsed.offsets ?? {}) },
      maxUpdatedAt: parsed.maxUpdatedAt,
      generation: parsed.generation ?? 1,
      seq: parsed.seq ?? 0,
      prevSha256: parsed.prevSha256,
      chunksInGeneration: parsed.chunksInGeneration ?? 0
    }
  } catch {
    // A corrupt cursor must not wedge backups forever. Starting a fresh generation costs
    // one full snapshot and is always safe.
    return freshCursor()
  }
}

export async function saveCursor (pseudonym: string, deviceId: string, c: PushCursor): Promise<void> {
  await AsyncStorage.setItem(cursorKey(pseudonym, deviceId), JSON.stringify(c))
}

export async function clearCursor (pseudonym: string, deviceId: string): Promise<void> {
  await AsyncStorage.removeItem(cursorKey(pseudonym, deviceId))
}
