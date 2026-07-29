/**
 * A Luby-transform fountain over QR codes, for payment frames too large to
 * fit one symbol.
 *
 * WHY A FOUNTAIN and not numbered chunks: at ~5 QR frames per second a
 * receiver WILL miss frames, and with plain chunk cycling every miss costs a
 * full cycle waiting for that exact index to come around again. Fountain
 * parts are interchangeable — any ~K+ε distinct parts reconstruct the K
 * source blocks — so misses cost almost nothing and neither side needs a
 * back-channel (the QR path has none).
 *
 * DETERMINISM IS THE CONTRACT: part `seq` is a pure function of
 * (message, blockBytes, seq). The first K parts are the source blocks
 * verbatim (the systematic prefix — one clean camera cycle decodes with zero
 * overhead); later parts XOR a subset of blocks chosen by an xorshift32 RNG
 * seeded from `seq` with an ideal-soliton degree. The decoder rebuilds the
 * same subset from the header's `seq` alone.
 *
 * Wire shape (see the plan/spec): 'bsvpayf2:' + base64url(header ‖ payload),
 * header = seq u32BE ‖ K u16BE ‖ msgLen u32BE ‖ crc32 u32BE = 14 bytes,
 * payload = one block-sized XOR. The block size is not in the header — the
 * decoder infers it from the payload length, which also keeps every part the
 * same size (the last source block is zero-padded).
 */
import { CodecError } from './codec'

export const FOUNTAIN_QR_PREFIX = 'bsvpayf2:'
/** 1,214-byte parts ≈ 1,628 QR chars — inside MAX_FRAME_QR_CHARS with margin. */
export const BLOCK_BYTES = 1200
/**
 * Sanity ceiling on the whole message. At ~5 parts/s and 1,200-byte blocks,
 * 64 KB is ~54 source blocks ≈ 15–30 s of scanning — already at the limit of
 * two people holding phones together. Anything bigger means something upstream
 * is wrong (the air-gap payload target is ~400 bytes).
 */
export const MAX_MESSAGE_BYTES = 65536
/** Sender animation cadence: 5 parts per second. */
export const FOUNTAIN_FRAME_MS = 200

const HEADER_BYTES = 14

// ── crc32 (IEEE 802.3, the standard table implementation) ──

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// ── deterministic RNG and part→blocks mapping ──

/** xorshift32. Never returns 0; never seeded with 0. */
function makeRng(seed: number): () => number {
  let x = seed >>> 0
  if (x === 0) x = 0x6d2b79f5
  return () => {
    x ^= x << 13
    x >>>= 0
    x ^= x >>> 17
    x ^= x << 5
    x >>>= 0
    return x
  }
}

/**
 * The block indices XORed into part `seq` (which must be ≥ K — below K the
 * part IS block `seq`). Ideal-soliton degree: 1 with probability 1/K, else
 * d with probability 1/(d(d-1)) via the ceil(1/u) inverse-CDF trick; indices
 * by partial Fisher–Yates so they are distinct.
 */
function blocksForPart(seq: number, k: number): number[] {
  const rng = makeRng((seq * 0x9e3779b1) >>> 0)
  // (0,1] for the degree draw — the +1 keeps 1/u finite.
  const open01 = () => ((rng() >>> 9) + 1) / 2 ** 23
  // [0,1) for index draws — floor stays in range.
  const half01 = () => (rng() >>> 9) / 2 ** 23
  let degree: number
  if (k === 1) degree = 1
  else if (open01() <= 1 / k) degree = 1
  else degree = Math.min(k, Math.ceil(1 / open01()))
  const pool = Array.from({ length: k }, (_, i) => i)
  for (let i = 0; i < degree; i++) {
    const j = i + Math.floor(half01() * (k - i))
    const t = pool[i]
    pool[i] = pool[j]
    pool[j] = t
  }
  return pool.slice(0, degree)
}

function xorInto(target: Uint8Array, source: Uint8Array): void {
  for (let i = 0; i < target.length; i++) target[i] ^= source[i]
}

// ── base64url (same shape codec.ts uses; local so this module stays standalone) ──

function toB64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return globalThis.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/')
  const binary = globalThis.atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  return Uint8Array.from(binary, c => c.charCodeAt(0))
}

// ── encoder ──

export class FountainEncoder {
  private readonly blocks: Uint8Array[]
  private readonly msgLen: number
  private readonly crc: number
  readonly blockCount: number

  constructor(message: Uint8Array, blockBytes: number = BLOCK_BYTES) {
    if (message.length === 0) throw new CodecError('empty fountain message')
    if (message.length > MAX_MESSAGE_BYTES) {
      throw new CodecError(`fountain message of ${message.length} bytes exceeds ${MAX_MESSAGE_BYTES}`)
    }
    this.msgLen = message.length
    this.crc = crc32(message)
    this.blockCount = Math.ceil(message.length / blockBytes)
    this.blocks = []
    for (let i = 0; i < this.blockCount; i++) {
      const block = new Uint8Array(blockBytes) // zero-padded past msgLen
      block.set(message.subarray(i * blockBytes, Math.min((i + 1) * blockBytes, message.length)))
      this.blocks.push(block)
    }
  }

  /** Part `seq`, ready to render. Deterministic; seq may grow without bound. */
  partAt(seq: number): string {
    const k = this.blockCount
    const payload =
      seq < k
        ? this.blocks[seq].slice()
        : (() => {
            const mixed = new Uint8Array(this.blocks[0].length)
            for (const index of blocksForPart(seq, k)) xorInto(mixed, this.blocks[index])
            return mixed
          })()
    const out = new Uint8Array(HEADER_BYTES + payload.length)
    const view = new DataView(out.buffer)
    view.setUint32(0, seq >>> 0)
    view.setUint16(4, k)
    view.setUint32(6, this.msgLen)
    view.setUint32(10, this.crc)
    out.set(payload, HEADER_BYTES)
    return FOUNTAIN_QR_PREFIX + toB64url(out)
  }
}

// ── decoder ──

interface PendingPart {
  indices: Set<number>
  payload: Uint8Array
}

export class FountainDecoder {
  private key = ''
  private total = 0
  private msgLen = 0
  private crc = 0
  private seen = new Set<number>()
  private solved: (Uint8Array | null)[] = []
  private solvedCount = 0
  private pending: PendingPart[] = []

  private reset(key: string, total: number, msgLen: number, crc: number): void {
    this.key = key
    this.total = total
    this.msgLen = msgLen
    this.crc = crc
    this.seen = new Set()
    this.solved = Array.from({ length: total }, () => null)
    this.solvedCount = 0
    this.pending = []
  }

  /**
   * Feed one scanned string. Never throws: anything that is not a well-formed
   * part of the current message reports `ok: false` and changes nothing —
   * the camera WILL hand this stray reads.
   */
  accept(text: string): { ok: boolean; done: boolean; have: number; total: number } {
    const state = () => ({
      ok: true,
      done: this.solvedCount === this.total && this.total > 0,
      have: this.solvedCount,
      total: this.total
    })
    if (typeof text !== 'string' || !text.startsWith(FOUNTAIN_QR_PREFIX)) {
      return { ok: false, done: false, have: this.solvedCount, total: this.total }
    }
    let bytes: Uint8Array
    try {
      bytes = fromB64url(text.slice(FOUNTAIN_QR_PREFIX.length))
    } catch {
      return { ok: false, done: false, have: this.solvedCount, total: this.total }
    }
    if (bytes.length <= HEADER_BYTES) return { ok: false, done: false, have: this.solvedCount, total: this.total }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const seq = view.getUint32(0)
    const total = view.getUint16(4)
    const msgLen = view.getUint32(6)
    const crc = view.getUint32(10)
    const payload = bytes.slice(HEADER_BYTES)
    if (total === 0 || msgLen === 0 || msgLen > MAX_MESSAGE_BYTES) {
      return { ok: false, done: false, have: this.solvedCount, total: this.total }
    }
    if (Math.ceil(msgLen / payload.length) !== total) {
      // Block size, msgLen and K must agree, or the sender and this decoder
      // are not talking about the same message shape.
      return { ok: false, done: false, have: this.solvedCount, total: this.total }
    }

    // A different (K, msgLen, crc) is a different message: start over. This is
    // also the corrupt-assembly recovery path — message() resets on a crc
    // mismatch, and the still-running sender re-fills this decoder.
    const key = `${total}:${msgLen}:${crc}`
    if (key !== this.key) this.reset(key, total, msgLen, crc)

    if (this.seen.has(seq)) return state()
    this.seen.add(seq)

    const indices = seq < total ? new Set([seq]) : new Set(blocksForPart(seq, total))
    this.ingest({ indices, payload })
    return state()
  }

  /** Peeling: reduce by what is solved; solve degree-1 remainders; cascade. */
  private ingest(part: PendingPart): void {
    for (const index of [...part.indices]) {
      const known = this.solved[index]
      if (known) {
        xorInto(part.payload, known)
        part.indices.delete(index)
      }
    }
    if (part.indices.size === 0) return // pure redundancy
    if (part.indices.size > 1) {
      this.pending.push(part)
      return
    }
    const [index] = part.indices
    if (this.solved[index]) return
    this.solved[index] = part.payload
    this.solvedCount++
    // Every pending part that referenced this block sheds it; re-ingest any
    // that became degree-1. Loop to a fixpoint — one solve can cascade.
    let progressed = true
    while (progressed) {
      progressed = false
      const still: PendingPart[] = []
      for (const p of this.pending) {
        for (const i of [...p.indices]) {
          const known = this.solved[i]
          if (known) {
            xorInto(p.payload, known)
            p.indices.delete(i)
          }
        }
        if (p.indices.size === 1) {
          const [i] = p.indices
          if (!this.solved[i]) {
            this.solved[i] = p.payload
            this.solvedCount++
            progressed = true
          }
        } else if (p.indices.size > 1) {
          still.push(p)
        }
      }
      this.pending = still
    }
  }

  /**
   * The assembled message once `accept` reported done — crc-checked. A
   * mismatch discards the assembly, resets the decoder, and returns null;
   * the sender is still looping, so collection simply continues.
   */
  message(): Uint8Array | null {
    if (this.total === 0 || this.solvedCount !== this.total) return null
    const blockBytes = this.solved[0]!.length
    const out = new Uint8Array(this.total * blockBytes)
    for (let i = 0; i < this.total; i++) out.set(this.solved[i]!, i * blockBytes)
    const trimmed = out.slice(0, this.msgLen)
    if (crc32(trimmed) !== this.crc) {
      this.reset('', 0, 0, 0)
      return null
    }
    return trimmed
  }
}
