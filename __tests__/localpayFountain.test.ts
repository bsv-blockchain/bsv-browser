import { MAX_FRAME_QR_CHARS } from '@/utils/localpay/codec'
import {
  FOUNTAIN_QR_PREFIX,
  FountainDecoder,
  FountainEncoder,
  MAX_MESSAGE_BYTES,
  crc32
} from '@/utils/localpay/fountain'

/** Deterministic pseudo-random payload, sized to span several blocks. */
function message(len: number): Uint8Array {
  const m = new Uint8Array(len)
  for (let i = 0; i < len; i++) m[i] = (i * 31 + 7) & 0xff
  return m
}

function drain(decoder: FountainDecoder, encoder: FountainEncoder, seqs: Iterable<number>): Uint8Array | null {
  for (const seq of seqs) {
    const s = decoder.accept(encoder.partAt(seq))
    if (s.done) return decoder.message()
  }
  return null
}

/** Decodes a rendered part back to its raw header ‖ payload bytes, for hand-corrupting a wire part in tests. */
function partBytes(raw: string): Uint8Array {
  const b64 = raw.slice(FOUNTAIN_QR_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/')
  return Uint8Array.from(globalThis.atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), c => c.charCodeAt(0))
}

/** Re-renders raw header ‖ payload bytes as a wire part string. */
function toPart(bytes: Uint8Array): string {
  let bin = ''
  for (const byte of bytes) bin += String.fromCharCode(byte)
  return FOUNTAIN_QR_PREFIX + globalThis.btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

describe('crc32', () => {
  it('matches the standard vector', () => {
    // CRC-32 of ascii "123456789" is 0xCBF43926.
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })
})

describe('FountainEncoder', () => {
  it('emits parts of constant size with the right prefix', () => {
    const enc = new FountainEncoder(message(5000), 1200)
    const p0 = enc.partAt(0)
    const p9 = enc.partAt(9)
    expect(p0.startsWith(FOUNTAIN_QR_PREFIX)).toBe(true)
    expect(p0.length).toBe(p9.length)
  })

  it('refuses an empty or oversize message', () => {
    expect(() => new FountainEncoder(new Uint8Array(0))).toThrow()
    expect(() => new FountainEncoder(message(MAX_MESSAGE_BYTES + 1))).toThrow()
  })

  it('computes blockCount as ceil(len / blockBytes)', () => {
    expect(new FountainEncoder(message(2400), 1200).blockCount).toBe(2)
    expect(new FountainEncoder(message(2401), 1200).blockCount).toBe(3)
  })

  it('a default-block part always fits a renderable QR', () => {
    const enc = new FountainEncoder(message(MAX_MESSAGE_BYTES)) // default BLOCK_BYTES
    expect(enc.partAt(0).length).toBeLessThanOrEqual(MAX_FRAME_QR_CHARS)
    expect(enc.partAt(enc.blockCount + 1).length).toBeLessThanOrEqual(MAX_FRAME_QR_CHARS)
  })
})

describe('FountainDecoder', () => {
  it('decodes from one clean systematic cycle', () => {
    const msg = message(5000) // K = 5 at 1200
    const enc = new FountainEncoder(msg, 1200)
    const dec = new FountainDecoder()
    const out = drain(dec, enc, [0, 1, 2, 3, 4])
    expect(out).not.toBeNull()
    expect(Array.from(out!)).toEqual(Array.from(msg))
  })

  it('reports progress', () => {
    const enc = new FountainEncoder(message(5000), 1200)
    const dec = new FountainDecoder()
    expect(dec.accept(enc.partAt(0))).toEqual({ ok: true, done: false, have: 1, total: 5 })
    expect(dec.accept(enc.partAt(0))).toEqual({ ok: true, done: false, have: 1, total: 5 }) // duplicate
  })

  it('recovers a message when systematic parts are missed (mixed parts only past K)', () => {
    const msg = message(6000) // K = 5
    const enc = new FountainEncoder(msg, 1200)
    const dec = new FountainDecoder()
    // Skip parts 1 and 3 entirely; feed the rest of the first two cycles.
    const out = drain(dec, enc, [0, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19])
    expect(out).not.toBeNull()
    expect(Array.from(out!)).toEqual(Array.from(msg))
  })

  it('handles out-of-order and interleaved duplicates', () => {
    const msg = message(3700) // K = 4, last block padded
    const enc = new FountainEncoder(msg, 1200)
    const dec = new FountainDecoder()
    const out = drain(dec, enc, [3, 3, 1, 6, 0, 1, 5, 2])
    expect(out).not.toBeNull()
    expect(Array.from(out!)).toEqual(Array.from(msg))
  })

  it('decodes a message that is an exact multiple of the block size', () => {
    const msg = message(2400)
    const enc = new FountainEncoder(msg, 1200)
    const dec = new FountainDecoder()
    const out = drain(dec, enc, [0, 1])
    expect(Array.from(out!)).toEqual(Array.from(msg))
  })

  it('a single-block message decodes from one part', () => {
    const msg = message(37)
    const enc = new FountainEncoder(msg, 1200)
    const dec = new FountainDecoder()
    const out = drain(dec, enc, [0])
    expect(Array.from(out!)).toEqual(Array.from(msg))
  })

  it('ignores strings that are not parts', () => {
    const dec = new FountainDecoder()
    expect(dec.accept('bsvpay1:notapart').ok).toBe(false)
    expect(dec.accept('bsvpayf2:!!!not-base64!!!').ok).toBe(false)
  })

  it('resets when a different message arrives', () => {
    const encA = new FountainEncoder(message(5000), 1200)
    const encB = new FountainEncoder(message(2400), 1200)
    const dec = new FountainDecoder()
    dec.accept(encA.partAt(0))
    const s = dec.accept(encB.partAt(0))
    expect(s.total).toBe(2)
    expect(s.have).toBe(1)
  })

  it('a corrupt assembly is discarded and collection continues', () => {
    const msg = message(2400) // K = 2
    const enc = new FountainEncoder(msg, 1200)
    const dec = new FountainDecoder()
    // Hand-corrupt part 1's payload: decode its base64, flip a payload byte,
    // re-encode with the SAME header (so crc in the header no longer matches
    // the assembled bytes).
    const bytes = partBytes(enc.partAt(1))
    bytes[20] ^= 0xff
    const corrupt = toPart(bytes)

    dec.accept(enc.partAt(0))
    const s = dec.accept(corrupt)
    expect(s.done).toBe(true)
    expect(dec.message()).toBeNull() // crc mismatch → discard, decoder reset
    // The stream keeps flowing; a fresh clean cycle completes.
    dec.accept(enc.partAt(0))
    const s2 = dec.accept(enc.partAt(1))
    expect(s2.done).toBe(true)
    expect(Array.from(dec.message()!)).toEqual(Array.from(msg))
  })

  it('rejects a part whose payload length disagrees with the pinned session block size', () => {
    // Two honest encoders over the SAME message but different blockBytes: both
    // produce blockCount 2 for len 2400 (ceil(2400/1200)=2, ceil(2400/1500)=2),
    // same msgLen and crc — so they collide on the exact same session key,
    // despite disagreeing on payload length.
    const msg = message(2400)
    const enc1200 = new FountainEncoder(msg, 1200)
    const enc1500 = new FountainEncoder(msg, 1500)
    const dec = new FountainDecoder()

    dec.accept(enc1200.partAt(0)) // pins the session's block size at 1200
    const mismatched = dec.accept(enc1500.partAt(0))
    expect(mismatched.ok).toBe(false)
    expect(mismatched.have).toBe(1)
    expect(mismatched.total).toBe(2)

    // Session survives the mismatch; the remaining honest part still completes it.
    const s = dec.accept(enc1200.partAt(1))
    expect(s.done).toBe(true)
    expect(Array.from(dec.message()!)).toEqual(Array.from(msg))
  })

  it('rejects a part whose payload was extended past the pinned block size (header untouched)', () => {
    const msg = message(2400) // K = 2
    const enc = new FountainEncoder(msg, 1200)
    const dec = new FountainDecoder()

    dec.accept(enc.partAt(0)) // pins the session's block size at 1200

    // Extend part 1's payload by 7 bytes; the header (seq/total/msgLen/crc) is
    // untouched, and ceil(2400/1207) is still 2, so the agreement check alone
    // would let this through.
    const bytes = partBytes(enc.partAt(1))
    const extended = new Uint8Array(bytes.length + 7)
    extended.set(bytes)
    const corrupt = toPart(extended)

    const s = dec.accept(corrupt)
    expect(s.ok).toBe(false)
    expect(s.have).toBe(1)
    expect(s.total).toBe(2)

    // Session survives; the honest part still completes it.
    const s2 = dec.accept(enc.partAt(1))
    expect(s2.done).toBe(true)
    expect(Array.from(dec.message()!)).toEqual(Array.from(msg))
  })
})
