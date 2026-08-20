/**
 * The compressed-at-rest form of a transaction carrying R1-K1 scripts.
 *
 * A vault deposit's rawTx is ~960 KB because the locking script is; a
 * withdrawal's is ~960 KB per input because each R1 unlocking script embeds its
 * own sighash preimage, which embeds the scriptCode. Both of those byte ranges
 * are reconstructible from ~40 bytes, so storing them is pure waste — and the
 * waste is what wedges the backup log and dominates the database.
 *
 * WHY A SPAN LIST AND NOT SUBSTITUTION IN PLACE. The tempting design is to
 * replace each script with its 51-byte compressed form and rewrite the length
 * varint, so the result still parses as a transaction. That design is unsafe and
 * must not be revisited: it produces a SYNTACTICALLY VALID transaction with a
 * WRONG TXID, and nothing in this stack hashes stored bytes to notice. A span
 * list instead keeps every non-substituted byte verbatim in `literal`, so:
 *
 *   - Byte-exactness is structural, not argued. Length prefixes, non-canonical
 *     varints, witness-less quirks and anything else we did not think about are
 *     literal bytes that get copied back unchanged.
 *   - The envelope begins with 0xfe, which no rawTx (version LE `01|02 00 00
 *     00`), BEEF (`01|02 00 be ef`) or AtomicBEEF (`01 01 01 01`) can begin
 *     with, so unexpanded bytes reaching a parser FAIL rather than read
 *     plausibly. 0xff is deliberately not reused: that is the compressed-SCRIPT
 *     marker, and conflating the two reintroduces the false-positive hazard
 *     templateCodec's own throw exists to prevent.
 *
 * WHY THE TXID IS IN THE HEADER. Expansion hashes its own output and compares.
 * At ~960 KB saved per span, 32 bytes is free, and it converts every possible
 * silent corruption — a mangled record, a drifted template, a truncated literal
 * — into one loud, attributable failure. Nothing else in the storage layer
 * verifies bytes against a txid, so this is the only such check on the read path.
 *
 * DISCOVERY IS STRUCTURAL, NEVER A BYTE SEARCH. Region 0x02 (the preimage
 * scriptCode) is a byte-for-byte suffix of region 0x01 (the locking script), so
 * a sliding-window matcher yields overlapping, ambiguous spans. This walks the
 * transaction's own framing instead, and refuses to compress unless the walk
 * lands exactly on the end of the buffer — which also means a transaction this
 * module cannot parse is one it never touches.
 */
import { Hash, Utils } from '@bsv/sdk'
import { VaultError } from './types'
import {
  R1K1_LOCK_LEN,
  R1K1_R1_UNLOCK_LEN
} from './r1k1'
import {
  compressScript,
  compressScriptCode,
  describeCurrentVaultTemplate,
  expandScript,
  matchesTemplate
} from './templateCodec'

/** First byte of an envelope. See the module doc for why not 0xff. */
export const ENVELOPE_MAGIC = 0xfe

export const ENVELOPE_VERSION = 1

/** magic + version + flags + txid(32) + origLength(4) + spanCount(1) */
const HEADER_LEN = 1 + 1 + 1 + 32 + 4 + 1
/** offset(4) + region(1) + recLen(2) */
const SPAN_HEADER_LEN = 4 + 1 + 2

/**
 * Byte offset of the sighash preimage's scriptCode within an R1 unlocking
 * script, and its length.
 *
 * Derived, then verified against the mined mainnet fixture:
 *   push(sig 64)      1 + 64  = 65
 *   push(pubkey 33)   1 + 33  = 34   -> 99
 *   push(salt 32)     1 + 32  = 33   -> 132
 *   PUSHDATA4(preimage 959,733)   5  -> 137
 *   preimage prefix: 4 + 32 + 32 + 36 + 5 (the scriptCode's own varint) = 109
 * so the scriptCode begins at 137 + 109 = 246 and runs 959,572 bytes, leaving
 * one trailing byte after the preimage push (959,871 total).
 */
const UNLOCK_SCRIPT_CODE_OFFSET = 246
const SCRIPT_CODE_LEN = 959_572

type Region = 0x01 | 0x02

interface Span {
  /** Absolute offset in the original rawTx where the substituted bytes begin. */
  offset: number
  region: Region
  /** The compressed record: what templateCodec produced for those bytes. */
  record: Uint8Array
  /** Length of the bytes this record replaces. */
  length: number
}

const asBytes = (b: Uint8Array | number[]): Uint8Array => (b instanceof Uint8Array ? b : Uint8Array.from(b))

/** True when these bytes are an envelope rather than a transaction. */
export function isEnvelope(bytes: Uint8Array | number[] | undefined | null): boolean {
  if (!bytes || bytes.length === 0) return false
  const first = bytes instanceof Uint8Array ? bytes[0] : bytes[0]
  return first === ENVELOPE_MAGIC
}

function writeUInt32BE(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
}

function readUInt32BE(b: Uint8Array, at: number): number {
  return ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0
}

/**
 * One varint reader for the whole module.
 *
 * The SDK has two that disagree — `Transaction.fromReaderInternal` uses
 * `readVarIntNum()` while `BeefTx.scanRawTransaction` uses
 * `readVarIntNum(false)` — so using either of theirs would make discovery
 * depend on which one a future refactor picked. This one is only ever used to
 * WALK: if it disagrees with the real framing, the end-of-buffer assertion
 * fails and the transaction is stored raw. It can therefore be wrong safely,
 * which is the property that matters.
 */
function readVarInt(b: Uint8Array, at: number): { value: number; next: number } {
  const first = b[at]
  if (first < 0xfd) return { value: first, next: at + 1 }
  if (first === 0xfd) return { value: b[at + 1] | (b[at + 2] << 8), next: at + 3 }
  if (first === 0xfe) {
    return { value: (b[at + 1] | (b[at + 2] << 8) | (b[at + 3] << 16) | (b[at + 4] << 24)) >>> 0, next: at + 5 }
  }
  // 0xff: 8 bytes. Beyond anything this codec can act on, but it must be
  // skipped correctly so the walk still lands on the buffer end.
  let value = 0
  for (let i = 0; i < 8; i++) value += b[at + 1 + i] * 2 ** (8 * i)
  return { value, next: at + 9 }
}

/**
 * Walk the transaction and collect substitutable spans.
 *
 * Returns null when the transaction cannot be parsed, or the walk does not land
 * exactly on the end of the buffer. Null means "store it raw" — never "guess".
 */
async function discoverSpans(tx: Uint8Array): Promise<Span[] | null> {
  // The CURRENT version's descriptors, not every registered version's:
  // compression must write exactly one version, and describeVaultTemplate()
  // grows a pair per registered entry — so a `find` over it would silently pick
  // the oldest once a second version exists. Expansion is unaffected: a record's
  // own header names the version expandScript looks up.
  const versions = await describeCurrentVaultTemplate()
  const region1 = versions.find(v => v.region === 0x01)
  const region2 = versions.find(v => v.region === 0x02)
  if (!region1 || !region2) return null

  const spans: Span[] = []
  try {
    let at = 4 // version

    const inputs = readVarInt(tx, at)
    at = inputs.next
    for (let i = 0; i < inputs.value; i++) {
      at += 36 // outpoint
      const script = readVarInt(tx, at)
      at = script.next
      if (script.value === R1K1_R1_UNLOCK_LEN) {
        const start = at + UNLOCK_SCRIPT_CODE_OFFSET
        const window = tx.subarray(start, start + SCRIPT_CODE_LEN)
        if (window.length === SCRIPT_CODE_LEN && matchesTemplate(Array.from(window), region2)) {
          const record = await compressScriptCode(Array.from(window))
          spans.push({ offset: start, region: 0x02, record: asBytes(record), length: SCRIPT_CODE_LEN })
        }
      }
      at += script.value
      at += 4 // sequence
    }

    const outputs = readVarInt(tx, at)
    at = outputs.next
    for (let i = 0; i < outputs.value; i++) {
      at += 8 // satoshis
      const script = readVarInt(tx, at)
      at = script.next
      if (script.value === R1K1_LOCK_LEN) {
        const window = tx.subarray(at, at + R1K1_LOCK_LEN)
        if (window.length === R1K1_LOCK_LEN && matchesTemplate(Array.from(window), region1)) {
          const record = await compressScript(Array.from(window))
          spans.push({ offset: at, region: 0x01, record: asBytes(record), length: R1K1_LOCK_LEN })
        }
      }
      at += script.value
    }

    at += 4 // lockTime
    // The whole safety of structural discovery: if the walk did not consume the
    // transaction exactly, this module does not understand these bytes and must
    // not touch them.
    if (at !== tx.length) return null
  } catch {
    return null
  }

  return spans
}

/**
 * Compress a transaction, or return it unchanged.
 *
 * Unchanged is returned for anything with no R1-K1 span, anything this module
 * cannot parse, and anything already an envelope — so a caller can run this
 * over a mixed set of transactions unconditionally.
 *
 * @param txid the transaction's real txid, big-endian display hex. Recorded so
 *   expansion can verify itself.
 */
export async function compressTransaction(rawTx: Uint8Array | number[], txid: string): Promise<Uint8Array> {
  const tx = asBytes(rawTx)
  if (isEnvelope(tx)) return tx
  if (!/^[0-9a-fA-F]{64}$/.test(txid)) {
    throw new VaultError('template-invalid', 'compressTransaction needs the transaction txid to record')
  }

  const spans = await discoverSpans(tx)
  if (!spans || spans.length === 0) return tx
  if (spans.length > 255) return tx

  // Ascending, non-overlapping, by construction of the walk — asserted anyway,
  // because expansion relies on it and a future change to the walk must fail
  // here rather than there.
  for (let i = 1; i < spans.length; i++) {
    if (spans[i].offset <= spans[i - 1].offset + spans[i - 1].length) return tx
  }

  // Assembled as chunks and copied once. Never spread a byte array into
  // push(...): a 959,632-element spread overflows the call stack, and the
  // literal section of a large transaction is exactly that shape.
  const literalChunks: Uint8Array[] = []
  let cursor = 0
  for (const span of spans) {
    literalChunks.push(tx.subarray(cursor, span.offset))
    cursor = span.offset + span.length
  }
  literalChunks.push(tx.subarray(cursor))
  const literalLen = literalChunks.reduce((sum, c) => sum + c.length, 0)

  const chunks: Uint8Array[] = [
    Uint8Array.from([ENVELOPE_MAGIC, ENVELOPE_VERSION, 0]),
    Uint8Array.from(Utils.toArray(txid, 'hex')),
    Uint8Array.from(writeUInt32BE(tx.length)),
    Uint8Array.from([spans.length])
  ]
  for (const span of spans) {
    chunks.push(
      Uint8Array.from([
        ...writeUInt32BE(span.offset),
        span.region,
        (span.record.length >>> 8) & 0xff,
        span.record.length & 0xff
      ])
    )
    chunks.push(span.record)
  }
  chunks.push(Uint8Array.from(writeUInt32BE(literalLen)), ...literalChunks)

  const total = chunks.reduce((sum, c) => sum + c.length, 0)
  const envelope = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    envelope.set(c, at)
    at += c.length
  }

  // Never emit something larger than what it replaces.
  return envelope.length < tx.length ? envelope : tx
}

/** The txid an envelope records, big-endian display hex. */
export function envelopeTxid(envelope: Uint8Array | number[]): string {
  const b = asBytes(envelope)
  requireEnvelope(b)
  return Utils.toHex(Array.from(b.subarray(3, 35)))
}

function requireEnvelope(b: Uint8Array): void {
  if (b.length < HEADER_LEN || b[0] !== ENVELOPE_MAGIC) {
    throw new VaultError('template-invalid', 'not a transaction envelope')
  }
  if (b[1] !== ENVELOPE_VERSION) {
    throw new VaultError(
      'template-unknown',
      `transaction envelope version ${b[1]} was written by a newer build than this one reads`
    )
  }
}

interface ParsedEnvelope {
  txid: string
  origLength: number
  spans: { offset: number; region: Region; record: Uint8Array }[]
  literal: Uint8Array
}

function parseEnvelope(b: Uint8Array): ParsedEnvelope {
  requireEnvelope(b)
  const txid = Utils.toHex(Array.from(b.subarray(3, 35)))
  const origLength = readUInt32BE(b, 35)
  const spanCount = b[39]

  let at = HEADER_LEN
  const spans: ParsedEnvelope['spans'] = []
  for (let i = 0; i < spanCount; i++) {
    if (at + SPAN_HEADER_LEN > b.length) {
      throw new VaultError('template-invalid', 'transaction envelope is truncated in its span table')
    }
    const offset = readUInt32BE(b, at)
    const region = b[at + 4] as Region
    const recLen = (b[at + 5] << 8) | b[at + 6]
    at += SPAN_HEADER_LEN
    if (at + recLen > b.length) {
      throw new VaultError('template-invalid', 'transaction envelope is truncated in a span record')
    }
    spans.push({ offset, region, record: b.subarray(at, at + recLen) })
    at += recLen
  }

  if (at + 4 > b.length) throw new VaultError('template-invalid', 'transaction envelope has no literal section')
  const literalLen = readUInt32BE(b, at)
  at += 4
  if (at + literalLen !== b.length) {
    throw new VaultError('template-invalid', 'transaction envelope literal length disagrees with its size')
  }
  return { txid, origLength, spans, literal: b.subarray(at) }
}

/**
 * Expand an envelope back to the exact original transaction bytes.
 *
 * Self-verifying: the reconstruction is hashed and compared against the recorded
 * txid, so a drifted template, a mangled record or a truncated literal is a
 * loud, attributable failure rather than wrong bytes handed to a broadcaster.
 */
export async function expandTransaction(envelope: Uint8Array | number[]): Promise<Uint8Array> {
  const b = asBytes(envelope)
  const parsed = parseEnvelope(b)

  const expanded: Uint8Array[] = []
  for (const span of parsed.spans) {
    const bytes = await expandScript(Array.from(span.record))
    expanded.push(asBytes(bytes))
  }

  const total = expanded.reduce((sum, e) => sum + e.length, 0) + parsed.literal.length
  if (total !== parsed.origLength) {
    throw new VaultError(
      'template-invalid',
      `transaction envelope reconstructs to ${total} bytes but records ${parsed.origLength}`
    )
  }

  const out = new Uint8Array(parsed.origLength)
  let literalAt = 0
  let outAt = 0
  for (let i = 0; i < parsed.spans.length; i++) {
    const span = parsed.spans[i]
    if (span.offset < outAt) {
      throw new VaultError('template-invalid', 'transaction envelope spans are not in ascending order')
    }
    const literalRun = span.offset - outAt
    out.set(parsed.literal.subarray(literalAt, literalAt + literalRun), outAt)
    literalAt += literalRun
    outAt += literalRun
    out.set(expanded[i], outAt)
    outAt += expanded[i].length
  }
  out.set(parsed.literal.subarray(literalAt), outAt)

  const txid = Utils.toHex(Hash.hash256(Array.from(out)).reverse())
  if (txid !== parsed.txid) {
    throw new VaultError(
      'template-invalid',
      `transaction envelope expands to txid ${txid} but records ${parsed.txid}`
    )
  }
  return out
}

/**
 * Read a byte range of the ORIGINAL transaction from an envelope.
 *
 * Required because `outputs.scriptOffset`/`scriptLength` are absolute offsets
 * into the uncompressed rawTx, and with `maxOutputScript = 1024` the outputs
 * that take that path are exactly the ~960 KB vault scripts. Slicing an
 * envelope at those offsets would return wrong bytes with NO exception, which
 * `Services.hashOutputScript` then hashes — and three separate writers persist
 * `spendable = false` on the answer. Silent fund eviction; this function is the
 * reason it cannot happen.
 *
 * Expands only the spans the range actually intersects.
 */
export async function readEnvelopeRange(
  envelope: Uint8Array | number[],
  offset: number,
  length: number
): Promise<Uint8Array> {
  const b = asBytes(envelope)
  const parsed = parseEnvelope(b)
  if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0) {
    throw new VaultError('template-invalid', 'readEnvelopeRange needs integer offset and length')
  }

  const end = Math.min(offset + length, parsed.origLength)
  if (offset >= parsed.origLength) return new Uint8Array(0)

  const out = new Uint8Array(end - offset)
  let literalAt = 0
  let outAt = 0 // cursor in ORIGINAL coordinates

  const emit = (src: Uint8Array, srcStart: number, srcEnd: number, originStart: number): void => {
    // Intersect [originStart, originStart + (srcEnd - srcStart)) with [offset, end)
    const from = Math.max(offset, originStart)
    const to = Math.min(end, originStart + (srcEnd - srcStart))
    if (to <= from) return
    out.set(src.subarray(srcStart + (from - originStart), srcStart + (to - originStart)), from - offset)
  }

  for (const span of parsed.spans) {
    const literalRun = span.offset - outAt
    emit(parsed.literal, literalAt, literalAt + literalRun, outAt)
    literalAt += literalRun
    outAt += literalRun

    // Only expand a span the requested range actually touches.
    const spanLen = readUInt32BE(span.record, 3)
    if (offset < outAt + spanLen && end > outAt) {
      const bytes = asBytes(await expandScript(Array.from(span.record)))
      emit(bytes, 0, bytes.length, outAt)
      outAt += bytes.length
    } else {
      outAt += spanLen
    }
  }
  emit(parsed.literal, literalAt, parsed.literal.length, outAt)

  return out
}
