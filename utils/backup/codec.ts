/**
 * Encrypted chunk codec.
 *
 * Sync chunks are dominated by raw transaction bytes — TableProvenTx.rawTx,
 * TableProvenTxReq.rawTx/inputBEEF, TableTransaction.rawTx/inputBEEF, merklePath — all
 * typed `number[]`. A naive JSON.stringify renders each byte as up to four characters.
 *
 * The toolbox's own binary-aware serialiser is used, but on its own it does NOT help here:
 * `binaryJsonReplacer` base64-encodes `Uint8Array` only, and the toolbox's own tables use
 * `number[]`, so those fields would pass straight through as decimal arrays. Hence the
 * packing pass below, which converts byte-valued arrays to `Uint8Array` first so the
 * serialiser can compact them, and converts them back on the way in.
 *
 * The server stores opaque bytes and never parses a payload, so this format is a purely
 * client-internal choice with no interop constraint.
 */
import type { CompletedProtoWallet } from '@bsv/sdk'
import { Utils } from '@bsv/sdk'
import type { SyncChunk } from '@bsv/wallet-toolbox-mobile/out/src/sdk/WalletStorage.interfaces'
import {
  parseJsonRpc,
  stringifyJsonRpc
} from '@bsv/wallet-toolbox-mobile/out/src/storage/remoting/BinaryJson'
import { BACKUP_KEY_ID, BACKUP_PROTOCOL } from './constants'

/**
 * Minimum length before a numeric array is worth packing as bytes.
 *
 * Below this the base64 envelope costs more than it saves, and short numeric arrays are
 * usually ids rather than payloads.
 */
const PACK_MIN_LENGTH = 32

/**
 * Repack byte-valued numeric arrays as Uint8Array so the binary serialiser can base64 them.
 *
 * `binaryJsonReplacer` only base64-encodes `Uint8Array`, but every binary field on the
 * toolbox's tables — rawTx, inputBEEF, merklePath — is typed `number[]`, so without this
 * they serialise as decimal arrays at roughly four characters per byte. Packing first turns
 * that into base64 at about 1.37, which is a threefold saving on a payload that is mostly
 * transaction bytes and is pushed repeatedly over mobile data.
 *
 * The transform is lossless in both directions because `unpackBytes` converts every
 * Uint8Array back to `number[]`. An array that merely looked byte-like — small integer ids,
 * say — round-trips to exactly the values it started with.
 */
function packBytes (value: unknown): unknown {
  if (Array.isArray(value)) {
    const isByteArray =
      value.length >= PACK_MIN_LENGTH &&
      value.every(v => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 255)
    if (isByteArray) return new Uint8Array(value as number[])
    return value.map(packBytes)
  }
  if (value != null && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = packBytes(v)
    return out
  }
  return value
}

/**
 * Cheap lower bound on a chunk's encoded size, in bytes.
 *
 * Walks the chunk applying packBytes' own byte-array rule and sums what those arrays cost
 * once base64-encoded, plus every string's own length — with the blob columns compressed at
 * rest, the remaining way a single record goes oversize is a string (a pre-scrub
 * proven_tx_reqs.history carrying megabytes of EF hex in error notes). Everything else —
 * keys, timestamps, numbers — is ignored, so the answer is an UNDERESTIMATE: a chunk this
 * says is too big definitely is.
 *
 * Exists to be run BEFORE encodeChunk. Encrypting and then BRC-31-signing an oversized
 * payload blocked the JS thread for ~50s per attempt on device; the point is to never do
 * that work, not merely to avoid the failed upload at the end of it.
 */
export function estimateEncodedBytes (chunk: SyncChunk): number {
  let bytes = 0
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      // JSON adds quotes and escapes, so the raw length stays a lower bound.
      bytes += value.length
      return
    }
    if (Array.isArray(value)) {
      const isByteArray =
        value.length >= PACK_MIN_LENGTH &&
        value.every(v => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 255)
      // base64 is 4 characters per 3 bytes.
      if (isByteArray) bytes += Math.ceil(value.length / 3) * 4
      else value.forEach(walk)
      return
    }
    if (value != null && typeof value === 'object' && !(value instanceof Date)) {
      for (const v of Object.values(value as Record<string, unknown>)) walk(v)
    }
  }
  walk(chunk)
  return bytes
}

/** The table columns the toolbox types as Date. BinaryJson has no Date support:
 * encode writes them as ISO strings, so decode must revive them — the merge
 * entities call `.getTime()`/date arithmetic on them directly
 * (EntityProvenTxReq.mergeExisting was the first to crash on a string). */
const DATE_KEYS = new Set(['created_at', 'updated_at'])

/** Inverse of packBytes: every Uint8Array becomes the `number[]` the toolbox
 * expects, and date columns come back as Date instances. */
function unpackBytes (value: unknown, key?: string): unknown {
  if (value instanceof Uint8Array) return Array.from(value)
  if (typeof value === 'string' && key != null && DATE_KEYS.has(key)) {
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? value : d
  }
  if (Array.isArray(value)) return value.map(v => unpackBytes(v))
  if (value != null && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = unpackBytes(v, k)
    return out
  }
  return value
}

/**
 * Serialise and encrypt a sync chunk.
 *
 * `counterparty: 'self'` is the entire zero-knowledge property. With 'self' the symmetric
 * key comes from the wallet's own key material and nobody else can derive it; naming the
 * server as counterparty instead would let the server decrypt via ECDH. One enum value
 * decides it.
 */
export async function encodeChunk (
  wallet: CompletedProtoWallet,
  chunk: SyncChunk
): Promise<number[]> {
  const json = stringifyJsonRpc(packBytes(chunk), true)
  const { ciphertext } = await wallet.encrypt({
    plaintext: Utils.toArray(json, 'utf8'),
    protocolID: BACKUP_PROTOCOL,
    keyID: BACKUP_KEY_ID,
    counterparty: 'self'
  })
  return ciphertext
}

/** Decrypt and parse a sync chunk. Throws if the ciphertext was not written by this key. */
export async function decodeChunk (
  wallet: CompletedProtoWallet,
  ciphertext: number[]
): Promise<SyncChunk> {
  const { plaintext } = await wallet.decrypt({
    ciphertext,
    protocolID: BACKUP_PROTOCOL,
    keyID: BACKUP_KEY_ID,
    counterparty: 'self'
  })
  return unpackBytes(parseJsonRpc(Utils.toUTF8(plaintext), true)) as SyncChunk
}

/** The twelve entity arrays a SyncChunk carries, in the protocol's dependency order. */
export const CHUNK_ENTITIES = [
  'provenTxs',
  'provenTxReqs',
  'outputBaskets',
  'txLabels',
  'outputTags',
  'transactions',
  'txLabelMaps',
  'commissions',
  'outputs',
  'outputTagMaps',
  'certificates',
  'certificateFields'
] as const

/**
 * True when a chunk carries no records at all.
 *
 * The toolbox treats an all-empty chunk as the completion sentinel, so this doubles as
 * "nothing left to push" and "restore is finished".
 */
export function isEmptyChunk (chunk: SyncChunk): boolean {
  const c = chunk as unknown as Record<string, unknown[] | undefined>
  return CHUNK_ENTITIES.every(name => (c[name]?.length ?? 0) === 0)
}

/**
 * An all-empty chunk with every entity array present.
 *
 * All twelve must exist as arrays: the toolbox's consumer loops forever on an `undefined`
 * entity array rather than treating it as empty.
 */
export function emptyChunk (from: string, to: string, userIdentityKey: string): SyncChunk {
  const chunk: Record<string, unknown> = {
    fromStorageIdentityKey: from,
    toStorageIdentityKey: to,
    userIdentityKey
  }
  for (const name of CHUNK_ENTITIES) chunk[name] = []
  return chunk as unknown as SyncChunk
}
