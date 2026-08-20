/**
 * The compressed-at-rest transaction envelope.
 *
 * Transactions here are hand-built from bytes rather than assembled with the
 * SDK, so the tests control the exact framing being claimed — including the
 * non-canonical varint case, which no builder would emit.
 *
 * The scripts inside them are REAL: region 1 is rebuilt from the mined mainnet
 * fixture, and region 2 is its scriptCode suffix. A synthetic script would make
 * every match trivially true and prove nothing about discovery.
 */
import { Hash, Utils } from '@bsv/sdk'
import {
  ENVELOPE_FLAG_DIGEST,
  ENVELOPE_MAGIC,
  ENVELOPE_VERSION,
  compressContainer,
  compressTransaction,
  envelopeTxid,
  expandTransaction,
  isEnvelope,
  readEnvelopeRange
} from '@/services/vault/txEnvelope'
import { TEMPLATE_MARKER, describeVaultTemplate, matchesTemplate } from '@/services/vault/templateCodec'
import { R1K1_LOCK_LEN, R1K1_R1_UNLOCK_LEN } from '@/services/vault/r1k1'
import { buildMainnetFixtureScript } from './fixtures/r1k1MainnetFixture'

const SCRIPT_CODE_LEN = 959_572
const PREIMAGE_LEN = 959_733

let LOCK: Uint8Array
let SCRIPT_CODE: Uint8Array

beforeAll(async () => {
  LOCK = Uint8Array.from(await buildMainnetFixtureScript())
  // Region 0x02 is region 0x01 from offset 60 — the codec derives it that way,
  // and asserting it here means a template change breaks this fixture loudly
  // rather than making the input-side tests silently vacuous.
  SCRIPT_CODE = LOCK.subarray(60)
  const versions = await describeVaultTemplate()
  expect(LOCK.length).toBe(R1K1_LOCK_LEN)
  expect(SCRIPT_CODE.length).toBe(SCRIPT_CODE_LEN)
  expect(matchesTemplate(Array.from(LOCK), versions.find(v => v.region === 0x01)!)).toBe(true)
  expect(matchesTemplate(Array.from(SCRIPT_CODE), versions.find(v => v.region === 0x02)!)).toBe(true)
})

// ── byte building ─────────────────────────────────────────────────────────

const varint = (n: number): number[] => {
  if (n < 0xfd) return [n]
  if (n <= 0xffff) return [0xfd, n & 0xff, (n >> 8) & 0xff]
  return [0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]
}

/** A deliberately over-long encoding of a small number. No builder emits this. */
const nonCanonicalVarint = (n: number): number[] => [0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]

const uint64 = (n: number): number[] => {
  const out: number[] = []
  let v = n
  for (let i = 0; i < 8; i++) {
    out.push(v & 0xff)
    v = Math.floor(v / 256)
  }
  return out
}

/** Concatenate without ever spreading a large array into push(...). */
function cat(parts: (Uint8Array | number[])[]): Uint8Array {
  const chunks = parts.map(p => (p instanceof Uint8Array ? p : Uint8Array.from(p)))
  const out = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0))
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

const filled = (n: number, byte: number) => new Uint8Array(n).fill(byte)

/** An R1 unlocking script with the real framing and a real scriptCode inside. */
function r1UnlockingScript(): Uint8Array {
  const script = cat([
    [64],
    filled(64, 0x11), // push(signature)
    [33],
    filled(33, 0x22), // push(pubkey)
    [32],
    filled(32, 0x33), // push(salt)
    [0x4e, PREIMAGE_LEN & 0xff, (PREIMAGE_LEN >> 8) & 0xff, (PREIMAGE_LEN >> 16) & 0xff, (PREIMAGE_LEN >>> 24) & 0xff],
    // preimage: 4 + 32 + 32 + 36 = 104 bytes of prefix, then the scriptCode's
    // own varint, then the scriptCode, then 8 + 4 + 32 + 4 + 4 of suffix.
    filled(104, 0x44),
    [0xfe, SCRIPT_CODE_LEN & 0xff, (SCRIPT_CODE_LEN >> 8) & 0xff, (SCRIPT_CODE_LEN >> 16) & 0xff, 0],
    SCRIPT_CODE,
    filled(52, 0x55),
    [0x00] // the trailing byte after the preimage push
  ])
  expect(script.length).toBe(R1K1_R1_UNLOCK_LEN)
  return script
}

interface TxSpec {
  inputs: { script: Uint8Array }[]
  outputs: { satoshis: number; script: Uint8Array }[]
  inputCountVarint?: (n: number) => number[]
}

function buildTx(spec: TxSpec): Uint8Array {
  const enc = spec.inputCountVarint ?? varint
  const parts: (Uint8Array | number[])[] = [[1, 0, 0, 0], enc(spec.inputs.length)]
  for (const input of spec.inputs) {
    parts.push(filled(32, 0xaa), [0, 0, 0, 0]) // outpoint
    parts.push(varint(input.script.length), input.script)
    parts.push([0xff, 0xff, 0xff, 0xff]) // sequence
  }
  parts.push(varint(spec.outputs.length))
  for (const o of spec.outputs) {
    parts.push(uint64(o.satoshis), varint(o.script.length), o.script)
  }
  parts.push([0, 0, 0, 0]) // lockTime
  return cat(parts)
}

const txidOf = (tx: Uint8Array): string => Utils.toHex(Hash.hash256(Array.from(tx)).reverse())

const p2pkh = () => Uint8Array.from([0x76, 0xa9, 0x14, ...new Array(20).fill(0x01), 0x88, 0xac])

// ── tests ─────────────────────────────────────────────────────────────────

describe('compressTransaction / expandTransaction', () => {
  it('round-trips a deposit byte-exactly and preserves the txid', async () => {
    const tx = buildTx({ inputs: [{ script: p2pkh() }], outputs: [{ satoshis: 300_000, script: LOCK }] })
    const txid = txidOf(tx)

    const envelope = await compressTransaction(tx, txid)
    expect(isEnvelope(envelope)).toBe(true)
    expect(envelope.length).toBeLessThan(1000)
    expect(envelopeTxid(envelope)).toBe(txid)

    const back = await expandTransaction(envelope)
    expect(Array.from(back)).toEqual(Array.from(tx))
    expect(txidOf(back)).toBe(txid)
  })

  it('round-trips a withdrawal whose input carries the preimage scriptCode', async () => {
    const tx = buildTx({
      inputs: [{ script: r1UnlockingScript() }],
      outputs: [{ satoshis: 250_000, script: p2pkh() }]
    })
    const txid = txidOf(tx)

    const envelope = await compressTransaction(tx, txid)
    expect(envelope.length).toBeLessThan(1000)
    expect(Array.from(await expandTransaction(envelope))).toEqual(Array.from(tx))
  })

  it('round-trips a withdrawal that re-vaults its remainder: two regions at once', async () => {
    const tx = buildTx({
      inputs: [{ script: r1UnlockingScript() }],
      outputs: [
        { satoshis: 200_000, script: LOCK },
        { satoshis: 50_000, script: p2pkh() }
      ]
    })
    const txid = txidOf(tx)

    const envelope = await compressTransaction(tx, txid)
    // ~1.9 MB of script reduced to a header, two records and a small literal.
    expect(tx.length).toBeGreaterThan(1_900_000)
    expect(envelope.length).toBeLessThan(1500)
    expect(Array.from(await expandTransaction(envelope))).toEqual(Array.from(tx))
  })

  it('round-trips several vault inputs', async () => {
    const tx = buildTx({
      inputs: [{ script: r1UnlockingScript() }, { script: r1UnlockingScript() }, { script: r1UnlockingScript() }],
      outputs: [{ satoshis: 700_000, script: p2pkh() }]
    })
    const txid = txidOf(tx)
    const envelope = await compressTransaction(tx, txid)
    expect(Array.from(await expandTransaction(envelope))).toEqual(Array.from(tx))
  })

  it('preserves a NON-CANONICAL varint rather than normalising it', async () => {
    // The whole reason a span list beats substitution in place: length prefixes
    // are literal bytes, so an odd encoding survives and the txid does not move.
    // A design that rewrote varints would produce a valid-looking transaction
    // with a different txid and nothing would notice.
    const tx = buildTx({
      inputs: [{ script: p2pkh() }],
      outputs: [{ satoshis: 300_000, script: LOCK }],
      inputCountVarint: nonCanonicalVarint
    })
    const txid = txidOf(tx)

    const envelope = await compressTransaction(tx, txid)
    const back = await expandTransaction(envelope)
    expect(Array.from(back)).toEqual(Array.from(tx))
    expect(txidOf(back)).toBe(txid)
    // And the odd encoding is still there.
    expect(Array.from(back.subarray(4, 9))).toEqual(nonCanonicalVarint(1))
  })

  it('returns an ordinary transaction unchanged', async () => {
    const tx = buildTx({ inputs: [{ script: p2pkh() }], outputs: [{ satoshis: 1000, script: p2pkh() }] })
    const out = await compressTransaction(tx, txidOf(tx))
    expect(out).toBe(tx as unknown as Uint8Array)
    expect(isEnvelope(out)).toBe(false)
  })

  it('returns unparseable bytes unchanged rather than guessing', async () => {
    // Truncated mid-script: the walk cannot land on the buffer end, so the
    // transaction is stored raw.
    const tx = buildTx({ inputs: [{ script: p2pkh() }], outputs: [{ satoshis: 300_000, script: LOCK }] })
    const truncated = tx.subarray(0, tx.length - 40)
    const out = await compressTransaction(truncated, txidOf(truncated))
    expect(isEnvelope(out)).toBe(false)
  })

  it('is idempotent: compressing an envelope returns it', async () => {
    const tx = buildTx({ inputs: [{ script: p2pkh() }], outputs: [{ satoshis: 300_000, script: LOCK }] })
    const envelope = await compressTransaction(tx, txidOf(tx))
    expect(await compressTransaction(envelope, txidOf(tx))).toBe(envelope)
  })
})

describe('self-verification', () => {
  it('refuses an envelope whose span record was tampered with', async () => {
    const tx = buildTx({ inputs: [{ script: p2pkh() }], outputs: [{ satoshis: 300_000, script: LOCK }] })
    const envelope = await compressTransaction(tx, txidOf(tx))

    // Flip a byte inside the span record's payload. Caught by the RECORD's own
    // checksum, one layer before the envelope's txid check — two independent
    // guards, and the inner one gives the more specific message.
    const tampered = Uint8Array.from(envelope)
    tampered[HEADER_AND_SPAN_HEADER + 12] ^= 0xff
    await expect(expandTransaction(tampered)).rejects.toThrow(/checksum mismatch/)
  })

  it('refuses a tampered LITERAL, which only the txid check can catch', async () => {
    // The literal section is covered by no record checksum: a flipped byte
    // there reconstructs a perfectly well-formed transaction that simply is not
    // the one recorded. This is the case the txid in the header exists for, and
    // the reason storing it was worth 32 bytes.
    const tx = buildTx({ inputs: [{ script: p2pkh() }], outputs: [{ satoshis: 300_000, script: LOCK }] })
    const envelope = await compressTransaction(tx, txidOf(tx))

    const tampered = Uint8Array.from(envelope)
    tampered[tampered.length - 1] ^= 0x01 // a lockTime byte, in the literal tail
    await expect(expandTransaction(tampered)).rejects.toThrow(/expands to txid/)
  })

  it('refuses an envelope whose recorded txid does not match its content', async () => {
    const tx = buildTx({ inputs: [{ script: p2pkh() }], outputs: [{ satoshis: 300_000, script: LOCK }] })
    const envelope = await compressTransaction(tx, txidOf(tx))
    const lying = Uint8Array.from(envelope)
    lying[3] ^= 0xff // first byte of the recorded txid
    await expect(expandTransaction(lying)).rejects.toThrow(/txid/)
  })

  it('refuses a truncated envelope', async () => {
    const tx = buildTx({ inputs: [{ script: p2pkh() }], outputs: [{ satoshis: 300_000, script: LOCK }] })
    const envelope = await compressTransaction(tx, txidOf(tx))
    await expect(expandTransaction(envelope.subarray(0, envelope.length - 5))).rejects.toThrow(/envelope/)
  })

  it('refuses an envelope version it does not know', async () => {
    const tx = buildTx({ inputs: [{ script: p2pkh() }], outputs: [{ satoshis: 300_000, script: LOCK }] })
    const envelope = Uint8Array.from(await compressTransaction(tx, txidOf(tx)))
    envelope[1] = 99
    await expect(expandTransaction(envelope)).rejects.toThrow(/newer build/)
  })

  it('refuses bytes that are not an envelope at all', async () => {
    await expect(expandTransaction(Uint8Array.from([1, 0, 0, 0]))).rejects.toThrow(/not a transaction envelope/)
  })
})

describe('the magic byte', () => {
  it('cannot begin a real transaction, BEEF or AtomicBEEF', () => {
    // Transaction version is 1 or 2 little-endian; BEEF and AtomicBEEF have
    // their own prefixes. None can start with 0xfe, which is what makes an
    // unexpanded envelope reaching a parser fail loudly instead of reading
    // plausibly.
    expect(ENVELOPE_MAGIC).toBe(0xfe)
    for (const first of [0x01, 0x02, 0x04]) expect(isEnvelope([first, 0, 0, 0])).toBe(false)
    expect(ENVELOPE_VERSION).toBe(1)
  })

  it('is distinct from the compressed-script marker', async () => {
    // 0xff marks a compressed SCRIPT. Conflating the two would reintroduce the
    // false-positive hazard templateCodec's own throw exists to prevent.
    expect(TEMPLATE_MARKER).toBe(0xff)
    expect(ENVELOPE_MAGIC).not.toBe(TEMPLATE_MARKER)
  })

  it('reports non-envelopes without throwing', () => {
    expect(isEnvelope(undefined)).toBe(false)
    expect(isEnvelope(null)).toBe(false)
    expect(isEnvelope([])).toBe(false)
    expect(isEnvelope(new Uint8Array(0))).toBe(false)
  })
})

/** Offset of the first span record's payload: envelope header + span header. */
const HEADER_AND_SPAN_HEADER = 40 + 7 + 11

describe('readEnvelopeRange', () => {
  it('reads an output script at its recorded offset, byte-exactly', async () => {
    // This is the path that silently evicts funds if it returns the wrong
    // bytes: outputs.scriptOffset/scriptLength are absolute offsets into the
    // UNCOMPRESSED rawTx, and hashOutputScript hashes whatever comes back.
    const tx = buildTx({ inputs: [{ script: p2pkh() }], outputs: [{ satoshis: 300_000, script: LOCK }] })
    const envelope = await compressTransaction(tx, txidOf(tx))

    // Where the locking script actually starts in the original bytes.
    const scriptOffset = tx.length - 4 - R1K1_LOCK_LEN
    expect(Array.from(tx.subarray(scriptOffset, scriptOffset + 8))).toEqual(Array.from(LOCK.subarray(0, 8)))

    const range = await readEnvelopeRange(envelope, scriptOffset, R1K1_LOCK_LEN)
    expect(range.length).toBe(R1K1_LOCK_LEN)
    expect(Array.from(range)).toEqual(Array.from(LOCK))
  })

  it('matches a plain slice of the original at every boundary', async () => {
    const tx = buildTx({
      inputs: [{ script: r1UnlockingScript() }],
      outputs: [{ satoshis: 200_000, script: LOCK }, { satoshis: 5000, script: p2pkh() }]
    })
    const envelope = await compressTransaction(tx, txidOf(tx))

    const cases: [number, number][] = [
      [0, 4], // version, entirely literal
      [0, 200], // literal spanning into the first span
      [tx.length - 4, 4], // lockTime, literal after the last span
      [4, 64], // input count and outpoint
      [1_000_000, 32] // deep inside a span
    ]
    for (const [offset, length] of cases) {
      const range = await readEnvelopeRange(envelope, offset, length)
      expect(Array.from(range)).toEqual(Array.from(tx.subarray(offset, offset + length)))
    }
  })

  it('clamps a range that runs past the end, exactly as slice does', async () => {
    const tx = buildTx({ inputs: [{ script: p2pkh() }], outputs: [{ satoshis: 300_000, script: LOCK }] })
    const envelope = await compressTransaction(tx, txidOf(tx))
    const range = await readEnvelopeRange(envelope, tx.length - 10, 500)
    expect(Array.from(range)).toEqual(Array.from(tx.subarray(tx.length - 10)))
  })

  it('returns nothing for a range beyond the transaction', async () => {
    const tx = buildTx({ inputs: [{ script: p2pkh() }], outputs: [{ satoshis: 300_000, script: LOCK }] })
    const envelope = await compressTransaction(tx, txidOf(tx))
    expect((await readEnvelopeRange(envelope, tx.length + 10, 4)).length).toBe(0)
  })

  it('rejects a non-integer range rather than guessing', async () => {
    const tx = buildTx({ inputs: [{ script: p2pkh() }], outputs: [{ satoshis: 300_000, script: LOCK }] })
    const envelope = await compressTransaction(tx, txidOf(tx))
    await expect(readEnvelopeRange(envelope, 1.5, 4)).rejects.toThrow(/integer/)
  })
})

describe('compressContainer', () => {
  // A BEEF is a container of several transactions with no single txid, so the
  // header commits to SHA-256 of the whole blob instead. Everything else — spans,
  // literal, reconstruction — is shared with the transaction path.
  const beefish = (txs: Uint8Array[]): Uint8Array =>
    cat([
      [0x01, 0x00, 0xbe, 0xef], // version
      [0x01], // one BUMP
      filled(37, 0x77), // BUMP bytes this codec deliberately does not parse
      varint(txs.length),
      ...txs.flatMap(t => [t, [0x00]] as (Uint8Array | number[])[])
    ])

  it('round-trips a container carrying a vault transaction', async () => {
    const tx = buildTx({ inputs: [{ script: p2pkh() }], outputs: [{ satoshis: 300_000, script: LOCK }] })
    const blob = beefish([tx])

    const envelope = await compressContainer(blob)
    expect(isEnvelope(envelope)).toBe(true)
    expect(blob.length).toBeGreaterThan(950_000)
    expect(envelope.length).toBeLessThan(1200)
    expect(Array.from(await expandTransaction(envelope))).toEqual(Array.from(blob))
  })

  it('round-trips a withdrawal-shaped container: unlocking scripts and a re-vault output', async () => {
    // The shape that actually wedges the backup log — inputBEEF carries ~1.83 MB
    // per vault input, several times the rawTx it accompanies.
    const spend = buildTx({
      inputs: [{ script: r1UnlockingScript() }, { script: r1UnlockingScript() }],
      outputs: [{ satoshis: 400_000, script: LOCK }, { satoshis: 50_000, script: p2pkh() }]
    })
    const blob = beefish([spend])

    const envelope = await compressContainer(blob)
    expect(blob.length).toBeGreaterThan(2_800_000)
    expect(envelope.length).toBeLessThan(2000)
    expect(Array.from(await expandTransaction(envelope))).toEqual(Array.from(blob))
  })

  it('round-trips several transactions in one container', async () => {
    const a = buildTx({ inputs: [{ script: p2pkh() }], outputs: [{ satoshis: 300_000, script: LOCK }] })
    const b = buildTx({ inputs: [{ script: r1UnlockingScript() }], outputs: [{ satoshis: 1000, script: p2pkh() }] })
    const blob = beefish([a, b])

    const envelope = await compressContainer(blob)
    expect(Array.from(await expandTransaction(envelope))).toEqual(Array.from(blob))
  })

  it('does not report a scriptCode inside a locking script as its own span', async () => {
    // Region 0x02 is a byte-for-byte SUFFIX of region 0x01, so a naive scan finds
    // one inside every locking script and produces overlapping spans. Region 0x01
    // is claimed first and its range excluded.
    const tx = buildTx({ inputs: [{ script: p2pkh() }], outputs: [{ satoshis: 300_000, script: LOCK }] })
    const blob = beefish([tx])
    const envelope = await compressContainer(blob)
    expect(envelope[39]).toBe(1) // spanCount
    expect(Array.from(await expandTransaction(envelope))).toEqual(Array.from(blob))
  })

  it('leaves a container with no vault script unchanged', async () => {
    const blob = beefish([buildTx({ inputs: [{ script: p2pkh() }], outputs: [{ satoshis: 1000, script: p2pkh() }] })])
    expect(await compressContainer(blob)).toBe(blob)
  })

  it('refuses a tampered container: the digest, not a txid, is what it checks', async () => {
    const tx = buildTx({ inputs: [{ script: p2pkh() }], outputs: [{ satoshis: 300_000, script: LOCK }] })
    const envelope = Uint8Array.from(await compressContainer(beefish([tx])))
    envelope[envelope.length - 1] ^= 0x01
    await expect(expandTransaction(envelope)).rejects.toThrow(/container envelope expands to digest/)
  })

  it('sets the digest flag, and a transaction envelope does not', async () => {
    const tx = buildTx({ inputs: [{ script: p2pkh() }], outputs: [{ satoshis: 300_000, script: LOCK }] })
    const container = await compressContainer(beefish([tx]))
    const single = await compressTransaction(tx, txidOf(tx))
    expect(container[2] & ENVELOPE_FLAG_DIGEST).toBe(ENVELOPE_FLAG_DIGEST)
    expect(single[2] & ENVELOPE_FLAG_DIGEST).toBe(0)
  })

  it('is idempotent', async () => {
    const blob = beefish([buildTx({ inputs: [{ script: p2pkh() }], outputs: [{ satoshis: 300_000, script: LOCK }] })])
    const once = await compressContainer(blob)
    expect(await compressContainer(once)).toBe(once)
  })

  it('serves ranges out of a container envelope too', async () => {
    const tx = buildTx({ inputs: [{ script: p2pkh() }], outputs: [{ satoshis: 300_000, script: LOCK }] })
    const blob = beefish([tx])
    const envelope = await compressContainer(blob)
    for (const [offset, length] of [[0, 5], [40, 64], [blob.length - 3, 3]]) {
      expect(Array.from(await readEnvelopeRange(envelope, offset, length))).toEqual(
        Array.from(blob.subarray(offset, offset + length))
      )
    }
  })
})
