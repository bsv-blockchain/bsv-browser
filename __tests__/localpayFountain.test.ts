import {
  BLOCK_BYTES,
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
    const raw = enc.partAt(1)
    const b64 = raw.slice(FOUNTAIN_QR_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/')
    const bytes = Uint8Array.from(globalThis.atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), c => c.charCodeAt(0))
    bytes[20] ^= 0xff
    let bin = ''
    for (const byte of bytes) bin += String.fromCharCode(byte)
    const corrupt = FOUNTAIN_QR_PREFIX + globalThis.btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

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
})
