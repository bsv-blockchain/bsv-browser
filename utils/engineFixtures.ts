/**
 * Pure fixture → @bsv/sdk Transaction building for the engine native proof
 * harness (utils/engineNativeProof.ts, device-only, EXPO_PUBLIC_SECP_PROOF=1)
 * and its node/jest coverage (__tests__/engineFixtures.test.ts). NO React
 * Native / Expo imports here — only @bsv/sdk and plain TS — so this module
 * loads under plain node with no native modules present.
 *
 * The 53 native-engine-poc/fixtures/engine-sim-fixtures.json sign-flow
 * fixtures come from an external fuzz generator (bsv-fuzz, not in this repo)
 * and deliberately carry u64-scale amounts to exercise the NATIVE engine's
 * u64 LE encoding. @bsv/sdk 2.8.0 added monetary-range validation that many
 * of those amounts now fall outside of, so this module also carries the
 * SDK's own rules (mirrored from
 * node_modules/@bsv/sdk/dist/esm/src/transaction/Transaction.js — sign() /
 * #totalVerifiedOutputs — and script/templates/SignatureUtils.js —
 * resolveSourceDetails / formatPreimage; both enforce the SAME 21e14 = 2.1
 * quadrillion satoshi ceiling via requireSatoshiAmount / requireSatoshis) so
 * callers can classify each fixture as in-range or out-of-range under sdk
 * 2.8, and deterministically rescale an out-of-range fixture into an
 * in-range variant that keeps every other field (keys, scopes, scripts,
 * outpoints, sequences, locktime, version) identical.
 */
import { LockingScript, P2PKH, PrivateKey, Transaction } from '@bsv/sdk'

// ── hex / varint helpers (also used by engineNativeProof.ts's own tx-splice
//    plumbing, which shares this exact framing) ───────────────────────────

export const hexToU8 = (h: string): Uint8Array => {
  const u = new Uint8Array(h.length / 2)
  for (let i = 0; i < u.length; i++) u[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return u
}

export const u8ToHex = (u: Uint8Array): string => {
  let s = ''
  for (let i = 0; i < u.length; i++) s += u[i].toString(16).padStart(2, '0')
  return s
}

export function readVarint (u: Uint8Array, off: number): [number, number] {
  const first = u[off]
  if (first < 0xfd) return [first, off + 1]
  if (first === 0xfd) return [u[off + 1] | (u[off + 2] << 8), off + 3]
  if (first === 0xfe) {
    return [(u[off + 1] | (u[off + 2] << 8) | (u[off + 3] << 16)) + u[off + 4] * 0x1000000, off + 5]
  }
  throw new Error('varint 0xff input count not expected in fixtures')
}

export function writeVarint (v: number, out: number[]): void {
  if (v < 0xfd) {
    out.push(v)
  } else if (v <= 0xffff) {
    out.push(0xfd, v & 0xff, (v >> 8) & 0xff)
  } else {
    out.push(0xfe, v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff)
  }
}

/** Read 8 raw LE bytes as a BigInt (never loses precision, unlike the u64→Number decode below). */
function readU64LEBig (u: Uint8Array, off: number): bigint {
  let v = 0n
  for (let k = 7; k >= 0; k--) v = (v << 8n) | BigInt(u[off + k])
  return v
}

function writeU64LE (dv: DataView, off: number, v: number): void {
  dv.setUint32(off, v % 0x100000000, true)
  dv.setUint32(off + 4, Math.floor(v / 0x100000000), true)
}

// ── fixture parsing ───────────────────────────────────────────────────────

export interface FixtureMetaRec { priv: number[]; sats: number; scope: number; lock: number[] }

interface FixtureSkeletonInput { txidHex: string; vout: number; seq: number }
interface FixtureSkeletonOutput { sats: number; script: number[]; satsOffset: number }
interface FixtureSkeleton {
  version: number
  lockTime: number
  ins: FixtureSkeletonInput[]
  outs: FixtureSkeletonOutput[]
}

/**
 * Parse a fixture's unsigned-skeleton hex (every input script empty) into
 * inputs/outputs/version/locktime. `satsOffset` is the byte offset of each
 * output's 8-byte LE satoshis field within the skeleton, used by
 * `rescaleFixtureInRange` to rewrite amounts in place.
 */
function parseSkeleton (unsignedHex: string): FixtureSkeleton {
  const raw = hexToU8(unsignedHex)
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  const version = dv.getUint32(0, true)
  let off = 4
  const [nIn, o1] = readVarint(raw, off)
  off = o1
  const ins: FixtureSkeletonInput[] = []
  for (let i = 0; i < nIn; i++) {
    let txidHex = ''
    for (let k = 31; k >= 0; k--) txidHex += raw[off + k].toString(16).padStart(2, '0')
    const vout = dv.getUint32(off + 32, true)
    off += 36
    const [scriptLen, o2] = readVarint(raw, off)
    off = o2
    if (scriptLen !== 0) throw new Error(`fixture skeleton input ${i} has a non-empty script`)
    const seq = dv.getUint32(off, true)
    off += 4
    ins.push({ txidHex, vout, seq })
  }
  const [nOut, o3] = readVarint(raw, off)
  off = o3
  const outs: FixtureSkeletonOutput[] = []
  for (let i = 0; i < nOut; i++) {
    const satsOffset = off
    const sats = dv.getUint32(off + 4, true) * 0x100000000 + dv.getUint32(off, true)
    off += 8
    const [scriptLen, o4] = readVarint(raw, off)
    off = o4
    outs.push({ sats, script: Array.from(raw.subarray(off, off + scriptLen)), satsOffset })
    off += scriptLen
  }
  const lockTime = dv.getUint32(off, true)
  return { version, lockTime, ins, outs }
}

interface RawMetaRecord extends FixtureMetaRec { satsOffset: number }

/** Parse a fixture's 73B-record inputsMeta hex into input index → record. */
function parseMetaRecords (metaHex: string): Map<number, RawMetaRecord> {
  const metaBytes = hexToU8(metaHex)
  if (metaBytes.length % 73 !== 0) throw new Error('fixture meta not 73B records')
  const metas = new Map<number, RawMetaRecord>()
  const mdv = new DataView(metaBytes.buffer, metaBytes.byteOffset, metaBytes.byteLength)
  for (let mo = 0; mo < metaBytes.length; mo += 73) {
    metas.set(mdv.getUint32(mo, true), {
      priv: Array.from(metaBytes.subarray(mo + 4, mo + 36)),
      sats: mdv.getUint32(mo + 40, true) * 0x100000000 + mdv.getUint32(mo + 36, true),
      scope: mdv.getUint32(mo + 44, true),
      lock: Array.from(metaBytes.subarray(mo + 48, mo + 73)),
      satsOffset: mo + 36
    })
  }
  return metas
}

/**
 * Rebuild a corpus fixture as a real SDK Transaction: skeleton bytes →
 * inputs/outputs/locktime, 73B meta records → P2PKH unlock templates
 * (privkey, signOutputs/anyoneCanPay recovered from the sigScope, satoshis +
 * locking script passed explicitly). Signing this through the PATCHED
 * Transaction.sign exercises the real routed path end to end.
 *
 * Output amounts are pushed directly onto `tx.outputs` rather than through
 * `Transaction#addOutput`, which range-checks eagerly (sdk 2.8's
 * `requireSatoshiAmount`, label 'satoshis'): the fixture corpus deliberately
 * carries out-of-range u64-scale amounts, and this harness's job is to prove
 * `tx.sign()` itself rejects them (see `isFixtureInRange` /
 * runRoutedParity in engineNativeProof.ts), not to reject them one
 * constructor call earlier. `addInput` performs no satoshi validation, so it
 * is used normally.
 */
export function txFromFixture (unsignedHex: string, metaHex: string): Transaction {
  const { version, lockTime, ins, outs } = parseSkeleton(unsignedHex)
  const metas = parseMetaRecords(metaHex)

  const p2pkh = new P2PKH()
  const tx = new Transaction()
  tx.version = version
  tx.lockTime = lockTime
  for (let i = 0; i < ins.length; i++) {
    const m = metas.get(i)
    if (m == null) throw new Error(`fixture meta missing input ${i}`)
    const base = m.scope & 0x1f
    if (base !== 1 && base !== 2 && base !== 3) throw new Error(`unexpected scope base ${base} on input ${i}`)
    const signOutputs = (base === 2 ? 'none' : base === 3 ? 'single' : 'all') as 'all' | 'none' | 'single'
    const anyoneCanPay = (m.scope & 0x80) !== 0
    tx.addInput({
      sourceTXID: ins[i].txidHex,
      sourceOutputIndex: ins[i].vout,
      sequence: ins[i].seq,
      unlockingScriptTemplate: p2pkh.unlock(
        new PrivateKey(m.priv), signOutputs, anyoneCanPay, m.sats, LockingScript.fromBinary(m.lock)
      )
    })
  }
  for (const o of outs) {
    tx.outputs.push({ satoshis: o.sats, lockingScript: LockingScript.fromBinary(o.script) })
  }
  return tx
}

// ── sdk 2.8 monetary-range rules ────────────────────────────────────────────

/**
 * sdk 2.8's monetary ceiling (Transaction.js `MAX_SATOSHIS` /
 * SignatureUtils.js `MAX_SATOSHIS` — the same constant in both places).
 */
export const MAX_SATOSHIS = 2_100_000_000_000_000

/** Mirrors `requireSatoshiAmount` / `requireSatoshis`: safe integer in [0, MAX_SATOSHIS]. */
function amountInRange (v: number): boolean {
  return Number.isSafeInteger(v) && v >= 0 && v <= MAX_SATOSHIS
}

export interface FixtureAmounts { inputSats: number[], outputSats: number[] }

/** The exact numbers `txFromFixture` places on inputs' unlock templates and on outputs. */
export function decodeFixtureAmounts (unsignedHex: string, metaHex: string): FixtureAmounts {
  const { ins, outs } = parseSkeleton(unsignedHex)
  const metas = parseMetaRecords(metaHex)
  const inputSats = ins.map((_, i) => {
    const m = metas.get(i)
    if (m == null) throw new Error(`fixture meta missing input ${i}`)
    return m.sats
  })
  return { inputSats, outputSats: outs.map((o) => o.sats) }
}

/**
 * Mirrors sdk 2.8's `Transaction.sign()` monetary validation exactly:
 *  - every input's source satoshis and every output's satoshis must be a
 *    non-negative safe integer <= MAX_SATOSHIS (`Transaction.js`
 *    `requireSatoshiAmount` / `SignatureUtils.js` `requireSatoshis` — the
 *    same 21e14 ceiling in both places, hit via the P2PKH template's
 *    `resolveSourceDetails` for inputs and via `sign()`'s own output loop /
 *    `#totalVerifiedOutputs` for outputs).
 *  - the output total (summed left-to-right exactly as `#totalVerifiedOutputs`
 *    does) must also be a safe integer <= MAX_SATOSHIS.
 *
 * A fixture failing any of these is exactly a fixture `tx.sign()` will
 * reject under sdk 2.8.
 */
export function isFixtureInRange (unsignedHex: string, metaHex: string): boolean {
  const { inputSats, outputSats } = decodeFixtureAmounts(unsignedHex, metaHex)
  if (!inputSats.every(amountInRange)) return false
  if (!outputSats.every(amountInRange)) return false
  let total = 0
  for (const v of outputSats) {
    total += v
    if (!Number.isSafeInteger(total) || total > MAX_SATOSHIS) return false
  }
  return true
}

/**
 * Deterministically maps an out-of-range fixture to a variant whose every
 * amount (inputs' source sats and outputs) is a valid sdk-2.8 amount and
 * whose output total is valid too, keeping everything else (keys, scopes,
 * scripts, outpoints, sequences, locktime, version) byte-identical.
 *
 * Each amount is replaced by (its raw u64 value, read as a BigInt so no
 * precision is lost) mod (a per-field cap) — a pure function of the
 * fixture's own bytes, so the same fixture always rescales to the same
 * variant (no randomness, no external state). Outputs share the
 * MAX_SATOSHIS budget evenly across `outs.length` so their sum stays in
 * range too; inputs' source sats are capped individually since sdk 2.8
 * never sums input amounts in `sign()`.
 */
export function rescaleFixtureInRange (unsignedHex: string, metaHex: string): { unsignedTx: string, inputsMeta: string } {
  const { outs } = parseSkeleton(unsignedHex)
  const metas = parseMetaRecords(metaHex)

  const unsignedBytes = hexToU8(unsignedHex)
  const outDv = new DataView(unsignedBytes.buffer, unsignedBytes.byteOffset, unsignedBytes.byteLength)
  const outCap = outs.length > 0 ? Math.max(0, Math.floor(MAX_SATOSHIS / outs.length)) : MAX_SATOSHIS
  const outModulus = BigInt(outCap) + 1n
  for (const o of outs) {
    const rescaled = Number(readU64LEBig(unsignedBytes, o.satsOffset) % outModulus)
    writeU64LE(outDv, o.satsOffset, rescaled)
  }

  const metaBytes = hexToU8(metaHex)
  const metaDv = new DataView(metaBytes.buffer, metaBytes.byteOffset, metaBytes.byteLength)
  const inModulus = BigInt(MAX_SATOSHIS) + 1n
  for (const m of metas.values()) {
    const rescaled = Number(readU64LEBig(metaBytes, m.satsOffset) % inModulus)
    writeU64LE(metaDv, m.satsOffset, rescaled)
  }

  return { unsignedTx: u8ToHex(unsignedBytes), inputsMeta: u8ToHex(metaBytes) }
}
