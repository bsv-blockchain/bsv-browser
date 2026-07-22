/**
 * M5.4/M5.5 dev-gated proof harness (native-crypto, issues #22/#23) — Tier-3
 * engine simulator smoke + ROUTED sign-path proof.
 *
 * M5.4 sections run against the EngineNative Nitro module DIRECTLY at
 * `globalThis.__bsvEngineNative` (seam smoke, kept as regression evidence):
 *
 *   1. engine_version() + engine_ping() round-trip (byte-equality, empty and
 *      random payloads) — the whole seam: ArrayBuffer marshalling, Nitro JSI
 *      crossing, UniFFI RustBuffer round-trip.
 *   2. The 53 embedded sign-flow fixtures
 *      (native-engine-poc/fixtures/engine-sim-fixtures.json — a byte-exact
 *      PREFIX of the recorded M5.3/M5.1 gate corpus, same seed and generator;
 *      expected bytes = the app's patched @bsv/sdk@2.1.6 output via the
 *      bsv-fuzz sdk2 oracle) through `batchSignP2pkhInputs`: the framed reply
 *      is spliced into the unsigned skeleton exactly as the corpus driver does
 *      and must be byte-identical to the SDK-signed tx. Plus 2 must-Err
 *      fixtures (CHRONICLE / FORKID-stripped scope) whose Promise MUST reject.
 *   3. Micro-timing of the 50-input `batchSignP2pkhInputs` bench case (the
 *      run_bench case, async off the JS thread) — the first in-app engine
 *      timing number.
 *
 * M5.5 sections (issue #23) prove the ROUTED path — the same corpus and flows
 * through the PATCHED @bsv/sdk `Transaction.sign` (tier 1 = engine, tier 2 =
 * SecpNative-batched, tier 3 = pure JS):
 *
 *   4. The 53 sign-flow fixtures REBUILT as SDK `Transaction`s (P2PKH
 *      templates reconstructed from each 73B meta record) and signed via
 *      `tx.sign()`: bytes must equal the oracle's expectedSignedTx, with a
 *      counting proxy proving batchSignP2pkhInputs carried ALL signing (one
 *      crossing per case, batchEcdsaSign = 0).
 *   5. Pure-JS re-sign of the representative 50-input tx (both native modules
 *      removed) — byte-identical (the M2/M3 in-app pattern).
 *   6. Fallback tier: a poisoned engine (always rejects) must fall back to the
 *      SecpNative-batched tier and still produce byte-identical output.
 *   7. Flow bench: 50-input `Transaction.sign` engine-routed vs secp-batched
 *      (engine removed) vs pure JS; frame harness for the engine-routed
 *      createAction-scale workload (slicing-free tier-1 path).
 *
 * Activated ONLY under EXPO_PUBLIC_SECP_PROOF=1 (same gate as the secp proof;
 * index.js chains this harness BEFORE the secp one so they never overlap on
 * the JS thread). Results go to console, Documents/engine-proof-result.json,
 * and best-effort POST http://localhost:8787/engine-proof.
 */
import { Beef, P2PKH, PrivateKey, Spend, Transaction, LockingScript } from '@bsv/sdk'
import fixtures from '../native-engine-poc/fixtures/engine-sim-fixtures.json'

interface EngineNativeLike {
  version: () => string
  ping: (payload: ArrayBuffer) => ArrayBuffer
  batchSignP2pkhInputs: (unsignedTx: ArrayBuffer, inputsMeta: ArrayBuffer) => Promise<ArrayBuffer>
  batchVerifyP2pkhInputs: (signedTx: ArrayBuffer, prevoutsMeta: ArrayBuffer) => Promise<ArrayBuffer>
}

interface TimingStats {
  warmups: number
  iters: number
  firstMs: number
  minMs: number
  p50Ms: number
  meanMs: number
}

interface MsStats {
  minMs: number
  p50Ms: number
  p95Ms: number
  meanMs: number
}

interface FrameScenario {
  scenario: string
  runs: number
  frameBudgetMs: number
  totalFrames: number
  droppedFrames: number
  longestStallMs: number
  workloadMsP50: number
}

interface RoutedReport {
  parity: {
    pass: number
    fail: number
    failures: string[]
    cases: number
    inputsSigned: number
    engineCrossings: number
    secpBatchCrossings: number
  }
  jsResign: { pass: boolean; detail: string }
  fallbackPoisoned: { pass: boolean; detail: string; engineAttempts: number; secpBatchCrossings: number }
  flowBench: { flow: string; iters: number; stats: MsStats }[]
  flowCrossings: Record<string, number>
  frames: FrameScenario[]
}

interface VerifyReport {
  parity: {
    pass: number
    cases: number
    inputsVerified: number
    mismatches: number
    forbiddenAccepts: number
    engineCrossings: number
    failures: string[]
  }
  corrupted: { pass: boolean; detail: string }
  shadow: { pass: boolean; eligible: number; divergences: number; agreeInputs: number; detail: string }
  bench: { flow: string; iters: number; stats: MsStats }[]
}

interface EngineReport {
  present: boolean
  version: string | null
  hermesDev: boolean
  fixturesMeta: { seed: string; engine: string; oracle: string }
  ping: { pass: number; fail: number; failures: string[] }
  signFlow: { pass: number; fail: number; failures: string[]; cases: number; inputsSigned: number }
  mustErr: { pass: number; fail: number; failures: string[] }
  timing50: TimingStats | null
  routed: RoutedReport | null
  verify: VerifyReport | null
}

const g = globalThis as Record<string, any>
const now = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
const r3 = (x: number): number => Math.round(x * 1000) / 1000

const hexToU8 = (h: string): Uint8Array => {
  const u = new Uint8Array(h.length / 2)
  for (let i = 0; i < u.length; i++) u[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return u
}
const u8ToHex = (u: Uint8Array): string => {
  let s = ''
  for (let i = 0; i < u.length; i++) s += u[i].toString(16).padStart(2, '0')
  return s
}
/** Standalone ArrayBuffer copy (never a view offset) for the Nitro seam. */
const toBuf = (u: Uint8Array): ArrayBuffer => u.slice().buffer as ArrayBuffer

// ── minimal tx splice (mirrors the corpus driver's ser_tx/parse_framed) ──────

function readVarint (u: Uint8Array, off: number): [number, number] {
  const first = u[off]
  if (first < 0xfd) return [first, off + 1]
  if (first === 0xfd) return [u[off + 1] | (u[off + 2] << 8), off + 3]
  if (first === 0xfe) {
    return [(u[off + 1] | (u[off + 2] << 8) | (u[off + 3] << 16)) + u[off + 4] * 0x1000000, off + 5]
  }
  throw new Error('varint 0xff input count not expected in fixtures')
}

function writeVarint (v: number, out: number[]): void {
  if (v < 0xfd) {
    out.push(v)
  } else if (v <= 0xffff) {
    out.push(0xfd, v & 0xff, (v >> 8) & 0xff)
  } else {
    out.push(0xfe, v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff)
  }
}

/** Parse the engine's framed reply: [u32 LE idx][u8 len][script]* → idx→script. */
function parseFramedScripts (framed: Uint8Array): Map<number, Uint8Array> {
  const map = new Map<number, Uint8Array>()
  let off = 0
  while (off < framed.length) {
    const idx = framed[off] | (framed[off + 1] << 8) | (framed[off + 2] << 16) | (framed[off + 3] << 24)
    const len = framed[off + 4]
    map.set(idx >>> 0, framed.subarray(off + 5, off + 5 + len))
    off += 5 + len
  }
  return map
}

/**
 * Splice unlocking scripts into the unsigned skeleton (whose input scripts are
 * all empty), byte-identically to how the corpus driver / SDK serialize.
 */
function spliceSignedTx (unsigned: Uint8Array, scripts: Map<number, Uint8Array>): Uint8Array {
  const out: number[] = []
  let off = 0
  // version
  for (let i = 0; i < 4; i++) out.push(unsigned[off + i])
  off += 4
  const [nIn, o1] = readVarint(unsigned, off)
  off = o1
  writeVarint(nIn, out)
  for (let i = 0; i < nIn; i++) {
    for (let k = 0; k < 36; k++) out.push(unsigned[off + k]) // outpoint
    off += 36
    const [scriptLen, o2] = readVarint(unsigned, off)
    off = o2
    if (scriptLen !== 0) throw new Error(`skeleton input ${i} has non-empty script`)
    const script = scripts.get(i)
    if (script == null) throw new Error(`engine reply missing input ${i}`)
    writeVarint(script.length, out)
    for (let k = 0; k < script.length; k++) out.push(script[k])
    for (let k = 0; k < 4; k++) out.push(unsigned[off + k]) // sequence
    off += 4
  }
  // outputs + locktime: byte-identical tail, copy verbatim
  for (; off < unsigned.length; off++) out.push(unsigned[off])
  return Uint8Array.from(out)
}

// ── proof sections ───────────────────────────────────────────────────────────

function runPing (native: EngineNativeLike): EngineReport['ping'] {
  let pass = 0
  const failures: string[] = []
  const check = (label: string, ok: boolean): void => {
    if (ok) pass++
    else failures.push(label)
  }
  // empty payload
  check('ping empty', new Uint8Array(native.ping(new ArrayBuffer(0))).length === 0)
  // fixed pattern
  const fixed = Uint8Array.from([0, 1, 2, 0xfe, 0xff, 0x7f, 0x80])
  check('ping fixed', u8ToHex(new Uint8Array(native.ping(toBuf(fixed)))) === u8ToHex(fixed))
  // random 4KiB (crypto.getRandomValues via quick-crypto)
  const rand = new Uint8Array(4096)
  ;(g.crypto as Crypto).getRandomValues(rand)
  check('ping random-4KiB', u8ToHex(new Uint8Array(native.ping(toBuf(rand)))) === u8ToHex(rand))
  return { pass, fail: failures.length, failures }
}

async function runSignFlowFixtures (native: EngineNativeLike): Promise<EngineReport['signFlow']> {
  let pass = 0
  let inputsSigned = 0
  const failures: string[] = []
  for (const f of fixtures.signFlow) {
    try {
      const framed = new Uint8Array(
        await native.batchSignP2pkhInputs(toBuf(hexToU8(f.unsignedTx)), toBuf(hexToU8(f.inputsMeta)))
      )
      const signed = spliceSignedTx(hexToU8(f.unsignedTx), parseFramedScripts(framed))
      if (u8ToHex(signed) === f.expectedSignedTx) {
        pass++
        inputsSigned += f.nInputs
      } else {
        failures.push(`case ${f.caseIdx}: bytes differ`)
      }
    } catch (e) {
      failures.push(`case ${f.caseIdx}: ${String(e)}`)
    }
  }
  return { pass, fail: failures.length, failures, cases: fixtures.signFlow.length, inputsSigned }
}

async function runMustErr (native: EngineNativeLike): Promise<EngineReport['mustErr']> {
  let pass = 0
  const failures: string[] = []
  for (const f of fixtures.mustErr) {
    try {
      await native.batchSignP2pkhInputs(toBuf(hexToU8(f.unsignedTx)), toBuf(hexToU8(f.inputsMeta)))
      failures.push(`${f.label}: RESOLVED (must reject)`) // signing these = fund-loss family (b)
    } catch {
      pass++ // Promise rejection is the required behavior
    }
  }
  return { pass, fail: failures.length, failures }
}

async function runTiming50 (native: EngineNativeLike): Promise<TimingStats> {
  const unsigned = toBuf(hexToU8(fixtures.timing.unsignedTx))
  const meta = toBuf(hexToU8(fixtures.timing.inputsMeta))
  // Byte-parity first — a timing over divergent bytes would be meaningless.
  const framed = new Uint8Array(await native.batchSignP2pkhInputs(unsigned, meta))
  const signed = spliceSignedTx(hexToU8(fixtures.timing.unsignedTx), parseFramedScripts(framed))
  if (u8ToHex(signed) !== fixtures.timing.expectedSignedTx) {
    throw new Error('timing case bytes diverge from patched-SDK expected — not timing a wrong result')
  }
  // WARMUP LAW (M5.7 device rung): ~0.5s of the SAME op busy-warmup before any
  // sample — the device track proved short warmups read 5-10x slow on A-series
  // phones (efficiency cores + cold JIT). Minimum 5 runs regardless.
  const warmEnd = now() + 500
  let WARMUPS = 0
  while (WARMUPS < 5 || now() < warmEnd) {
    await native.batchSignP2pkhInputs(unsigned, meta)
    WARMUPS++
  }
  const ITERS = 20
  const samples: number[] = []
  for (let i = 0; i < ITERS; i++) {
    const t0 = now()
    await native.batchSignP2pkhInputs(unsigned, meta)
    samples.push(now() - t0)
  }
  const first = samples[0]
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    warmups: WARMUPS,
    iters: ITERS,
    firstMs: r3(first),
    minMs: r3(sorted[0]),
    p50Ms: r3(sorted[Math.floor(ITERS / 2)]),
    meanMs: r3(samples.reduce((a, b) => a + b, 0) / ITERS)
  }
}

// ── M5.5 (issue #23): the ROUTED sign path ───────────────────────────────────

const ENGINE_KEYS = ['version', 'ping', 'batchSignP2pkhInputs', 'computeSighashSigningOrder']
// mirror of secpNativeProof's NATIVE_KEYS (Nitro methods are not enumerable —
// explicit key list required for a pass-through proxy)
const SECP_KEYS = [
  'ecdsaSign', 'ecdsaVerify', 'pubkeyCreate', 'pubkeyTweakAdd', 'privkeyTweakAdd',
  'ecdhSharedPoint', 'brc42DeriveChild', 'ecdsaRecover', 'ecdsaRecoveryFactor',
  'pubkeyTweakMul', 'pubkeyCombine', 'schnorrGenerateProof', 'schnorrVerifyProof',
  'pubkeyCreateUncompressed', 'ecdhSharedPointUncompressed', 'pubkeyTweakAddUncompressed',
  'ecdsaRecoverUncompressed', 'brc42DeriveChildPubUncompressed',
  'batchEcdsaSign', 'batchEcdsaVerify', 'batchBrc42DeriveChild', 'batchBrc42DeriveChildPubUncompressed'
]

function countProxy (real: Record<string, any>, counts: Record<string, number>, keys: string[]): Record<string, any> {
  const proxy: Record<string, any> = {}
  for (const key of keys) {
    if (typeof real[key] !== 'function') continue
    proxy[key] = (...args: unknown[]) => {
      counts[key] = (counts[key] ?? 0) + 1
      return real[key](...args)
    }
  }
  return proxy
}

interface FixtureMetaRec { priv: number[]; sats: number; scope: number; lock: number[] }

/**
 * Rebuild a corpus fixture as a real SDK Transaction: skeleton bytes → inputs/
 * outputs/locktime, 73B meta records → P2PKH unlock templates (privkey,
 * signOutputs/anyoneCanPay recovered from the sigScope, satoshis + locking
 * script passed explicitly). Signing this through the PATCHED Transaction.sign
 * exercises the real routed path end to end.
 */
function txFromFixture (unsignedHex: string, metaHex: string): Transaction {
  const raw = hexToU8(unsignedHex)
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  const version = dv.getUint32(0, true)
  let off = 4
  const [nIn, o1] = readVarint(raw, off)
  off = o1
  const ins: { txidHex: string; vout: number; seq: number }[] = []
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
  const outs: { sats: number; script: number[] }[] = []
  for (let i = 0; i < nOut; i++) {
    const sats = dv.getUint32(off + 4, true) * 0x100000000 + dv.getUint32(off, true)
    off += 8
    const [scriptLen, o4] = readVarint(raw, off)
    off = o4
    outs.push({ sats, script: Array.from(raw.subarray(off, off + scriptLen)) })
    off += scriptLen
  }
  const lockTime = dv.getUint32(off, true)

  const metaBytes = hexToU8(metaHex)
  if (metaBytes.length % 73 !== 0) throw new Error('fixture meta not 73B records')
  const metas = new Map<number, FixtureMetaRec>()
  const mdv = new DataView(metaBytes.buffer, metaBytes.byteOffset, metaBytes.byteLength)
  for (let mo = 0; mo < metaBytes.length; mo += 73) {
    metas.set(mdv.getUint32(mo, true), {
      priv: Array.from(metaBytes.subarray(mo + 4, mo + 36)),
      sats: mdv.getUint32(mo + 40, true) * 0x100000000 + mdv.getUint32(mo + 36, true),
      scope: mdv.getUint32(mo + 44, true),
      lock: Array.from(metaBytes.subarray(mo + 48, mo + 73))
    })
  }

  const p2pkh = new P2PKH()
  const tx = new Transaction()
  tx.version = version
  tx.lockTime = lockTime
  for (let i = 0; i < nIn; i++) {
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
    tx.addOutput({ satoshis: o.sats, lockingScript: LockingScript.fromBinary(o.script) })
  }
  return tx
}

/** 53-fixture corpus through the PATCHED Transaction.sign (tier-1 routed). */
async function runRoutedParity (): Promise<RoutedReport['parity']> {
  const realEngine = g.__bsvEngineNative
  const realSecp = g.__bsvSecpNative
  const counts: Record<string, number> = {}
  g.__bsvEngineNative = countProxy(realEngine, counts, ENGINE_KEYS)
  if (realSecp != null) g.__bsvSecpNative = countProxy(realSecp, counts, SECP_KEYS)
  let pass = 0
  let inputsSigned = 0
  const failures: string[] = []
  try {
    for (const f of fixtures.signFlow) {
      try {
        const tx = txFromFixture(f.unsignedTx, f.inputsMeta)
        await tx.sign()
        if (tx.toHex() === f.expectedSignedTx) {
          pass++
          inputsSigned += f.nInputs
        } else {
          failures.push(`case ${f.caseIdx}: routed bytes differ`)
        }
      } catch (e) {
        failures.push(`case ${f.caseIdx}: ${String(e)}`)
      }
    }
  } finally {
    g.__bsvEngineNative = realEngine
    if (realSecp != null) g.__bsvSecpNative = realSecp
  }
  return {
    pass,
    fail: failures.length,
    failures,
    cases: fixtures.signFlow.length,
    inputsSigned,
    engineCrossings: counts.batchSignP2pkhInputs ?? 0,
    secpBatchCrossings: counts.batchEcdsaSign ?? 0
  }
}

/** Representative 50-input tx: engine-routed == pure-JS re-sign == oracle. */
async function runJsResign (): Promise<RoutedReport['jsResign']> {
  const realEngine = g.__bsvEngineNative
  const realSecp = g.__bsvSecpNative
  try {
    const t = fixtures.timing
    const routedTx = txFromFixture(t.unsignedTx, t.inputsMeta)
    await routedTx.sign()
    const routedHex = routedTx.toHex()
    delete g.__bsvEngineNative
    delete g.__bsvSecpNative
    const jsTx = txFromFixture(t.unsignedTx, t.inputsMeta)
    await jsTx.sign()
    const jsHex = jsTx.toHex()
    const ok = routedHex === t.expectedSignedTx && jsHex === routedHex
    return {
      pass: ok,
      detail: ok
        ? '50-input engine-routed == pure-JS re-sign == oracle bytes'
        : `routed==oracle: ${String(routedHex === t.expectedSignedTx)}, js==routed: ${String(jsHex === routedHex)}`
    }
  } finally {
    if (realEngine != null) g.__bsvEngineNative = realEngine
    if (realSecp != null) g.__bsvSecpNative = realSecp
  }
}

/** Poisoned engine (always rejects) → tier-2 secp batch must carry the tx. */
async function runFallbackPoisoned (): Promise<RoutedReport['fallbackPoisoned']> {
  const realEngine = g.__bsvEngineNative
  const realSecp = g.__bsvSecpNative
  const counts: Record<string, number> = {}
  let engineAttempts = 0
  g.__bsvEngineNative = {
    batchSignP2pkhInputs: async () => {
      engineAttempts++
      throw new Error('poisoned engine (simulated UnsupportedScope rejection)')
    }
  }
  if (realSecp != null) g.__bsvSecpNative = countProxy(realSecp, counts, SECP_KEYS)
  try {
    const t = fixtures.timing
    const tx = txFromFixture(t.unsignedTx, t.inputsMeta)
    await tx.sign()
    const bytesOk = tx.toHex() === t.expectedSignedTx
    const secpBatch = counts.batchEcdsaSign ?? 0
    const ok = bytesOk && engineAttempts === 1 && (realSecp == null || secpBatch === 1)
    return {
      pass: ok,
      detail: `bytes==oracle: ${String(bytesOk)}; engine attempts: ${engineAttempts}; tier-2 batchEcdsaSign crossings: ${secpBatch}`,
      engineAttempts,
      secpBatchCrossings: secpBatch
    }
  } finally {
    if (realEngine != null) g.__bsvEngineNative = realEngine
    else delete g.__bsvEngineNative
    if (realSecp != null) g.__bsvSecpNative = realSecp
  }
}

/** N-input P2PKH fixture built through the SDK (same shape as secpNativeProof). */
function sdkTxFixture (nInputs: number): { build: () => Transaction } {
  const p2pkh = new P2PKH()
  const keys: PrivateKey[] = []
  const srcTx = new Transaction()
  for (let i = 0; i < nInputs; i++) {
    const k = new PrivateKey(200000 + i)
    keys.push(k)
    srcTx.addOutput({ lockingScript: p2pkh.lock(k.toAddress()), satoshis: 1000 + i })
  }
  const dest = new PrivateKey(999999).toAddress()
  const build = (): Transaction => {
    const tx = new Transaction()
    for (let i = 0; i < nInputs; i++) {
      tx.addInput({
        sourceTransaction: srcTx,
        sourceOutputIndex: i,
        unlockingScriptTemplate: p2pkh.unlock(keys[i]),
        sequence: 0xffffffff
      })
    }
    tx.addOutput({ lockingScript: p2pkh.lock(dest), satoshis: nInputs * 1000 - 200 })
    return tx
  }
  return { build }
}

const sleep = async (ms: number): Promise<void> => await new Promise((resolve) => setTimeout(resolve, ms))

function msStats (samples: number[]): MsStats {
  const s = [...samples].sort((a, b) => a - b)
  const mean = s.reduce((a, b) => a + b, 0) / s.length
  return {
    minMs: r3(s[0]),
    p50Ms: r3(s[Math.floor(s.length * 0.5)]),
    p95Ms: r3(s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]),
    meanMs: r3(mean)
  }
}

async function benchFlowMs (iters: number, run: () => Promise<void>): Promise<MsStats> {
  // WARMUP LAW (M5.7 device rung): busy-run the SAME flow for ~0.5s (min 3
  // runs) before sampling — 3-run warmups read 5-10x slow on A-series E-cores.
  const warmEnd = now() + 500
  let w = 0
  while (w < 3 || now() < warmEnd) {
    await run()
    w++
  }
  const samples: number[] = []
  for (let i = 0; i < iters; i++) {
    const t0 = now()
    await run()
    samples.push(now() - t0)
  }
  return msStats(samples)
}

/** 50-input Transaction.sign: engine-routed vs secp-batched vs pure JS. */
async function runRoutedFlowBench (): Promise<{ flows: RoutedReport['flowBench']; crossings: Record<string, number> }> {
  const realEngine = g.__bsvEngineNative
  const realSecp = g.__bsvSecpNative
  const flows: RoutedReport['flowBench'] = []
  const crossings: Record<string, number> = {}
  const { build } = sdkTxFixture(50)
  try {
    // engine-routed (tier 1, no time-slicing on this branch) — THE GATE ROW
    // (design-doc hard gate: Release device p50 <= 10ms). >=15 iters per M5.7.
    flows.push({ flow: '50-input Transaction.sign ENGINE-routed (ms)', iters: 16, stats: await benchFlowMs(16, async () => { await build().sign() }) })
    // secp-batched (tier 2, cooperative slicing retained)
    delete g.__bsvEngineNative
    if (realSecp != null) {
      flows.push({ flow: '50-input Transaction.sign secp-batched (engine off) (ms)', iters: 16, stats: await benchFlowMs(16, async () => { await build().sign() }) })
    }
    // pure JS (tier 2 pure-JS branch: shared SignatureHashCache, JS ECDSA)
    delete g.__bsvSecpNative
    flows.push({ flow: '50-input Transaction.sign pure-JS (ms)', iters: 4, stats: await benchFlowMs(4, async () => { await build().sign() }) })
    // counted engine-routed run (crossing evidence)
    if (realEngine != null) g.__bsvEngineNative = countProxy(realEngine, crossings, ENGINE_KEYS)
    if (realSecp != null) g.__bsvSecpNative = countProxy(realSecp, crossings, SECP_KEYS)
    await build().sign()
  } finally {
    if (realEngine != null) g.__bsvEngineNative = realEngine
    else delete g.__bsvEngineNative
    if (realSecp != null) g.__bsvSecpNative = realSecp
    else delete g.__bsvSecpNative
  }
  return { flows, crossings }
}

/**
 * Frame harness (the M3 gate-4 instrument): rAF heartbeat while the
 * createAction-scale workload (20 BRC-42 derivations + 20-input sign) runs.
 */
async function measureFrames (
  scenario: string,
  runs: number,
  frameBudgetMs: number,
  workload: () => Promise<void>
): Promise<FrameScenario> {
  const stamps: number[] = []
  let raf = true
  const tick = (): void => {
    stamps.push(now())
    if (raf) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  await sleep(120)
  const workloadDurations: number[] = []
  for (let i = 0; i < runs; i++) {
    const t0 = now()
    await workload()
    workloadDurations.push(now() - t0)
    await sleep(60)
  }
  await sleep(120)
  raf = false
  await sleep(50)
  let dropped = 0
  let longest = 0
  for (let i = 1; i < stamps.length; i++) {
    const gap = stamps[i] - stamps[i - 1]
    longest = Math.max(longest, gap)
    dropped += Math.max(0, Math.round(gap / frameBudgetMs) - 1)
  }
  workloadDurations.sort((a, b) => a - b)
  return {
    scenario,
    runs,
    frameBudgetMs: r3(frameBudgetMs),
    totalFrames: stamps.length,
    droppedFrames: dropped,
    longestStallMs: r3(longest),
    workloadMsP50: r3(workloadDurations[Math.floor(workloadDurations.length / 2)])
  }
}

async function runRoutedFrameHarness (): Promise<FrameScenario[]> {
  const realEngine = g.__bsvEngineNative
  const realSecp = g.__bsvSecpNative
  const out: FrameScenario[] = []
  const { build } = sdkTxFixture(20)
  const root = new PrivateKey(31337)
  const cpPub = new PrivateKey(999).toPublicKey()
  const invoices = Array.from({ length: 20 }, (_, i) => `2-3241645161d8-engine ${i}`)
  const root32 = hexToU8(root.toHex().padStart(64, '0')).slice().buffer
  const cp33 = Uint8Array.from(cpPub.encode(true) as number[]).buffer

  // measured idle frame budget (median idle rAF gap)
  const stamps: number[] = []
  let raf = true
  const tick = (): void => {
    stamps.push(now())
    if (raf) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  await sleep(600)
  raf = false
  await sleep(50)
  const idleGaps = stamps.slice(1).map((t, i) => t - stamps[i]).sort((a, b) => a - b)
  const frameBudgetMs = Math.max(4, idleGaps[Math.floor(idleGaps.length / 2)] ?? 16.7)

  const workload = async (): Promise<void> => {
    if (realSecp != null && typeof realSecp.batchBrc42DeriveChild === 'function') {
      await realSecp.batchBrc42DeriveChild(root32, cp33, invoices)
    }
    await build().sign()
  }
  try {
    out.push(await measureFrames('createAction-scale ENGINE-routed sign', 5, frameBudgetMs, workload))
    delete g.__bsvEngineNative
    out.push(await measureFrames('createAction-scale secp-batched sign (engine off)', 5, frameBudgetMs, workload))
  } finally {
    if (realEngine != null) g.__bsvEngineNative = realEngine
    else delete g.__bsvEngineNative
    if (realSecp != null) g.__bsvSecpNative = realSecp
  }
  return out
}

async function runRouted (): Promise<RoutedReport> {
  const parity = await runRoutedParity()
  const jsResign = await runJsResign()
  const fallbackPoisoned = await runFallbackPoisoned()
  const { flows, crossings } = await runRoutedFlowBench()
  const frames = await runRoutedFrameHarness()
  return { parity, jsResign, fallbackPoisoned, flowBench: flows, flowCrossings: crossings, frames }
}

// ── M5.6 (issue #24): the VERIFY leg — batchVerifyP2pkhInputs + shadow ────────

/**
 * Build a fully-signed n-input P2PKH tx with CANONICAL locks (P2PKH of the
 * key's own address, so `hash160(pubkey)==lock pkh`), a self-funded source tx,
 * and the beef needed by the toolbox `verifyUnlockScripts`. Scope varies by
 * input when `mixScopes`.
 */
function signedP2pkhFixture (n: number, mixScopes = false): {
  build: () => Promise<{ tx: Transaction; srcTx: Transaction; beef: Beef; txid: string }>
} {
  const p2pkh = new P2PKH()
  const keys: PrivateKey[] = []
  const srcTx = new Transaction()
  for (let i = 0; i < n; i++) {
    const k = new PrivateKey(300000 + i)
    keys.push(k)
    srcTx.addOutput({ lockingScript: p2pkh.lock(k.toAddress()), satoshis: 1000 + i })
  }
  const srcId = srcTx.id('hex')
  const dest = new PrivateKey(999999).toAddress()
  const build = async (): Promise<{ tx: Transaction; srcTx: Transaction; beef: Beef; txid: string }> => {
    const tx = new Transaction()
    for (let i = 0; i < n; i++) {
      const signOutputs = mixScopes ? (['all', 'none', 'single'] as const)[i % 3] : 'all'
      const anyoneCanPay = mixScopes && i % 2 === 0
      tx.addInput({
        sourceTransaction: srcTx,
        sourceTXID: srcId,
        sourceOutputIndex: i,
        unlockingScriptTemplate: p2pkh.unlock(keys[i], signOutputs, anyoneCanPay),
        sequence: 0xffffffff
      })
    }
    tx.addOutput({ lockingScript: p2pkh.lock(dest), satoshis: Math.max(1, n * 1000 - 200) })
    await tx.sign()
    const beef = new Beef()
    beef.mergeTransaction(srcTx)
    beef.mergeTransaction(tx)
    return { tx, srcTx, beef, txid: tx.id('hex') }
  }
  return { build }
}

/** 37B prevout meta [u32 idx][u64 sat][25B lock] for every input of `tx`. */
function buildVerifyMeta (tx: Transaction): ArrayBuffer {
  const n = tx.inputs.length
  const meta = new Uint8Array(n * 37)
  const dv = new DataView(meta.buffer)
  for (let i = 0; i < n; i++) {
    const input = tx.inputs[i]
    const sourceOutput = input.sourceTransaction!.outputs[input.sourceOutputIndex]
    const sats = sourceOutput.satoshis ?? 0
    dv.setUint32(i * 37, i, true)
    dv.setUint32(i * 37 + 4, sats >>> 0, true)
    dv.setUint32(i * 37 + 8, Math.floor(sats / 0x100000000), true)
    meta.set(sourceOutput.lockingScript.toBinary(), i * 37 + 12)
  }
  return meta.buffer
}

/** JS per-input verdict via the SDK `Spend` — the toolbox verifyUnlockScripts semantics. */
function jsVerdicts (tx: Transaction): number[] {
  const out: number[] = []
  for (let i = 0; i < tx.inputs.length; i++) {
    const input = tx.inputs[i]
    const sourceOutput = input.sourceTransaction!.outputs[input.sourceOutputIndex]
    const otherInputs = tx.inputs.filter((_, idx) => idx !== i)
    let v = 0
    try {
      const spend = new Spend({
        sourceTXID: input.sourceTXID!,
        sourceOutputIndex: input.sourceOutputIndex,
        lockingScript: sourceOutput.lockingScript,
        sourceSatoshis: sourceOutput.satoshis ?? 0,
        transactionVersion: tx.version,
        otherInputs,
        unlockingScript: input.unlockingScript!,
        inputSequence: input.sequence ?? 0,
        inputIndex: i,
        outputs: tx.outputs,
        lockTime: tx.lockTime
      })
      v = spend.validate() ? 1 : 0
    } catch {
      v = 0
    }
    out.push(v)
  }
  return out
}

/**
 * 53 signed P2PKH txs (varying input counts + scopes) verified through the
 * Nitro seam: engine `batchVerifyP2pkhInputs` verdict bitmap == JS `Spend`
 * verdict, input-by-input. The FATAL check: engine must never return valid
 * where JS returns invalid.
 */
async function runVerifyParity (native: EngineNativeLike): Promise<VerifyReport['parity']> {
  const counts: Record<string, number> = {}
  const wrapped: EngineNativeLike = {
    ...native,
    batchVerifyP2pkhInputs: async (t, m) => {
      counts.verify = (counts.verify ?? 0) + 1
      return await native.batchVerifyP2pkhInputs(t, m)
    }
  }
  let pass = 0
  let inputsVerified = 0
  let mismatches = 0
  let forbiddenAccepts = 0
  const failures: string[] = []
  for (let c = 0; c < 53; c++) {
    const n = 1 + (c % 12)
    try {
      const { tx } = await signedP2pkhFixture(n, c % 3 === 0).build()
      const signedBuf = Uint8Array.from(tx.toBinary()).buffer as ArrayBuffer
      const metaBuf = buildVerifyMeta(tx)
      const bitmap = new Uint8Array(await wrapped.batchVerifyP2pkhInputs(signedBuf, metaBuf))
      const js = jsVerdicts(tx)
      let caseOk = bitmap.length === n
      for (let i = 0; i < n && caseOk; i++) {
        const nv = bitmap[i] & 1
        const jv = js[i] & 1
        if (nv === 1 && jv === 0) forbiddenAccepts++
        if (nv !== jv) { caseOk = false; mismatches++ }
      }
      if (caseOk) { pass++; inputsVerified += n } else { failures.push(`case ${c} (n=${n}): verdict mismatch`) }
    } catch (e) {
      failures.push(`case ${c}: ${String(e)}`)
    }
  }
  return { pass, cases: 53, inputsVerified, mismatches, forbiddenAccepts, engineCrossings: counts.verify ?? 0, failures }
}

/** Corrupt one input's sig → engine AND JS both mark that input invalid.
 *  NOTE: @bsv/sdk caches the signed serialization at sign() time, so mutating
 *  the live unlockingScript object does NOT propagate to tx.toBinary(). Corrupt
 *  BOTH surfaces at the same DER-body byte: the serialized bytes the engine
 *  parses AND the live chunk the JS Spend reads. */
async function runVerifyCorrupted (native: EngineNativeLike): Promise<VerifyReport['corrupted']> {
  try {
    const { tx } = await signedP2pkhFixture(5).build()
    const sig = (tx.inputs[2].unlockingScript as any).chunks[0].data as number[] // DER‖sighashflag
    const bytes = Uint8Array.from(tx.toBinary())
    // Locate input 2's (unique 71-byte) sig run inside the serialized tx.
    let off = -1
    outer: for (let i = 0; i <= bytes.length - sig.length; i++) {
      for (let j = 0; j < sig.length; j++) if (bytes[i + j] !== (sig[j] & 0xff)) continue outer
      off = i
      break
    }
    if (off < 0) throw new Error('could not locate input 2 sig in serialized tx')
    bytes[off + 5] ^= 0xff // the bytes the engine parses (a byte inside r)
    sig[5] ^= 0xff // the live chunk the JS Spend reads (same DER-body byte)
    const signedBuf = bytes.buffer as ArrayBuffer
    const bitmap = new Uint8Array(await native.batchVerifyP2pkhInputs(signedBuf, buildVerifyMeta(tx)))
    const js = jsVerdicts(tx)
    const engineRejected = bitmap[2] === 0
    const jsRejected = js[2] === 0
    const othersOk = bitmap[0] === 1 && bitmap[1] === 1 && bitmap[3] === 1 && bitmap[4] === 1
    const ok = engineRejected && jsRejected && othersOk && js[0] === 1
    return { pass: ok, detail: `input2 engine=${bitmap[2]} js=${js[2]} (both must be 0); others valid=${String(othersOk)}` }
  } catch (e) {
    return { pass: false, detail: String(e) }
  }
}

/**
 * The REAL shadow path in-app: call the patched toolbox `verifyUnlockScripts`
 * on a representative signed tx + beef (engine present) and read the shadow
 * counters it populated on `globalThis.__bsvEngineShadow` — divergences must
 * be 0 and every input must have agreed.
 */
async function runVerifyShadow (): Promise<VerifyReport['shadow']> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { verifyUnlockScripts } = require('@bsv/wallet-toolbox-mobile/out/src/signer/methods/completeSignedTransaction')
    const { tx, beef, txid } = await signedP2pkhFixture(20, true).build()
    delete g.__bsvEngineShadow
    verifyUnlockScripts(txid, beef) // JS authoritative; engine shadows alongside
    const s = g.__bsvEngineShadow
    if (s?.pending != null) await s.pending
    const eligible = s?.verifyEligible ?? 0
    const divergences = s?.verifyDivergences ?? 0
    const agreeInputs = s?.verifyAgreeInputs ?? 0
    const ok = eligible === 1 && divergences === 0 && agreeInputs === tx.inputs.length
    return {
      pass: ok,
      eligible,
      divergences,
      agreeInputs,
      detail: `eligible ${eligible}/1, divergences ${divergences} (want 0), agreed ${agreeInputs}/${tx.inputs.length} inputs`
    }
  } catch (e) {
    return { pass: false, eligible: 0, divergences: -1, agreeInputs: 0, detail: String(e) }
  }
}

/**
 * The second O(n²) killed: the toolbox JS `verifyUnlockScripts` (fresh `Spend`
 * per input + per-input sync ECDSA) vs ONE async engine crossing, 50 inputs.
 */
async function runVerifyBench (native: EngineNativeLike): Promise<VerifyReport['bench']> {
  const out: VerifyReport['bench'] = []
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { verifyUnlockScripts } = require('@bsv/wallet-toolbox-mobile/out/src/signer/methods/completeSignedTransaction')
  const { tx, beef, txid } = await signedP2pkhFixture(50).build()
  const signedBuf = Uint8Array.from(tx.toBinary()).buffer as ArrayBuffer
  const metaBuf = buildVerifyMeta(tx)
  // Byte/verdict parity first — timing a wrong result is meaningless.
  const bitmap = new Uint8Array(await native.batchVerifyP2pkhInputs(signedBuf, metaBuf))
  if (!bitmap.every((b) => b === 1)) throw new Error('verify bench tx did not verify all-valid natively')

  // JS-only leg: the per-input Spend interpreter (engine removed for this leg).
  const realEngine = g.__bsvEngineNative
  delete g.__bsvEngineNative
  try {
    out.push({ flow: '50-input verifyUnlockScripts JS Spend (per-input) (ms)', iters: 12, stats: await benchFlowMs(12, async () => { verifyUnlockScripts(txid, beef) }) })
  } finally {
    if (realEngine != null) g.__bsvEngineNative = realEngine
  }
  // Engine leg: one async batchVerifyP2pkhInputs crossing (fresh copies).
  out.push({ flow: '50-input batchVerifyP2pkhInputs ONE crossing (ms)', iters: 12, stats: await benchFlowMs(12, async () => { await native.batchVerifyP2pkhInputs(Uint8Array.from(tx.toBinary()).buffer as ArrayBuffer, buildVerifyMeta(tx)) }) })
  return out
}

async function runVerify (native: EngineNativeLike): Promise<VerifyReport> {
  const parity = await runVerifyParity(native)
  const corrupted = await runVerifyCorrupted(native)
  const shadow = await runVerifyShadow()
  const bench = await runVerifyBench(native)
  return { parity, corrupted, shadow, bench }
}

// ── CR-DEVICE bundle (issues #30 CR-2, #32 CR-4, #34 CR-6) ────────────────────
//
// ONE Release device build, three device-measurement caveat-resolutions off it,
// gated by EXPO_PUBLIC_CR_DEVICE=1 (independent of the SECP_PROOF harness so the
// soak runs on a clean JS thread). Writes Documents/cr-device-result.json.
//
//   CR-4 (B4) — sustained-load / thermal soak: the engine-routed 50-input sign
//     flow run continuously for a timed soak, p50/p95 windowed per 500-op bucket,
//     to show NO thermal cliff across the soak.
//   CR-2 (B2/B6) — many-run (>=20) engine-routed frame-stall DISTRIBUTION: the
//     rAF heartbeat (the JS-thread 60Hz render/animation proxy) sampled across
//     many runs of the engine-routed sign, reporting the per-run longest JS-thread
//     stall distribution — retires the "rounds to 0" caveat by showing sub-budget
//     stalls directly, not by a rounding rule. The Instruments/xctrace Animation-
//     Hitches UI-thread trace (the actual render thread) is captured OUT OF BAND
//     by the driver while this build runs (see CR-DEVICE-RESULTS.md).
//   CR-6 (D1) — identity A/B: this SAME code runs under two bundle ids; each build
//     stamps its inlined bundle-id label and records the routed-sign bench. The
//     driver compares the two p50s (within-noise-identical => identity is
//     timing-irrelevant).

interface SoakBucket {
  bucket: number
  opsFrom: number
  opsTo: number
  minMs: number
  p50Ms: number
  p95Ms: number
  maxMs: number
  meanMs: number
}

interface CrDeviceReport {
  bundleIdLabel: string | null
  enginePresent: boolean
  engineVersion: string | null
  hermesDev: boolean
  // engine actually carries the signs on THIS build (not a silent fallback)
  parity: { pass: number; cases: number; engineCrossings: number; secpBatchCrossings: number }
  // CR-6 A/B unit — identical protocol on both bundle ids
  routedSignBench: { flow: string; iters: number; warmups: number; stats: MsStats } | null
  // CR-4 soak
  soak: {
    unit: string
    inputsPerOp: number
    targetMs: number
    warmups: number
    totalOps: number
    totalSignatures: number
    elapsedSec: number
    bucketOps: number
    buckets: SoakBucket[]
    overall: MsStats
    firstBucketP50Ms: number
    lastBucketP50Ms: number
    lastOverFirstP50: number
    maxBucketP95Ms: number
  } | null
  // CR-2 many-run frame-stall distribution
  frames: {
    scenario: string
    runs: number
    frameBudgetMs: number
    budget60hzMs: number
    totalFrames: number
    droppedFrames: number
    workloadP50Ms: number
    // per-run longest JS-thread stall (max inter-frame gap inside each run window)
    perRunLongestStallMs: number[]
    stallP50Ms: number
    stallP95Ms: number
    stallMaxMs: number
    runsUnderBudget: number
    // overall inter-frame gap distribution across all runs
    gapP50Ms: number
    gapP95Ms: number
    gapP99Ms: number
    gapMaxMs: number
  } | null
}

/** Engine-routed 50-input Transaction.sign p50/p95 — the A/B bench unit. */
async function runCrRoutedSignBench (): Promise<CrDeviceReport['routedSignBench']> {
  const { build } = sdkTxFixture(50)
  const ITERS = 20
  // warmup law, then sampled — same protocol both bundle ids
  const warmEnd = now() + 500
  let warmups = 0
  while (warmups < 5 || now() < warmEnd) {
    await build().sign()
    warmups++
  }
  const samples: number[] = []
  for (let i = 0; i < ITERS; i++) {
    const t0 = now()
    await build().sign()
    samples.push(now() - t0)
  }
  return { flow: '50-input Transaction.sign ENGINE-routed (ms)', iters: ITERS, warmups, stats: msStats(samples) }
}

/** CR-4: timed thermal soak of the engine-routed 50-input sign, windowed p50/p95. */
async function runCrSoak (): Promise<NonNullable<CrDeviceReport['soak']>> {
  const { build } = sdkTxFixture(50)
  const inputsPerOp = 50
  // 5-minute soak by default; overridable, hard time+op caps so it always ends.
  const rawTarget = Number(process.env.EXPO_PUBLIC_CR_SOAK_MS ?? '300000')
  const targetMs = Number.isFinite(rawTarget) && rawTarget > 0 ? rawTarget : 300000
  const HARD_MS = targetMs + 60000 // absolute wall cap
  const HARD_OPS = 120000 // absolute op cap
  const MIN_OPS = 5000
  const bucketOps = 500

  // warmup law
  const warmEnd = now() + 500
  let warmups = 0
  while (warmups < 5 || now() < warmEnd) {
    await build().sign()
    warmups++
  }

  const start = now()
  const buckets: SoakBucket[] = []
  const overall: number[] = []
  let cur: number[] = []
  let ops = 0
  let bucketFrom = 0
  const closeBucket = (): void => {
    if (cur.length === 0) return
    const s = msStats(cur)
    buckets.push({
      bucket: buckets.length,
      opsFrom: bucketFrom,
      opsTo: ops - 1,
      minMs: s.minMs,
      p50Ms: s.p50Ms,
      p95Ms: s.p95Ms,
      maxMs: r3(Math.max(...cur)),
      meanMs: s.meanMs
    })
    bucketFrom = ops
    cur = []
  }
  // loop until BOTH the time target and the min-op floor are met (or a hard cap)
  while (((now() - start) < targetMs || ops < MIN_OPS) && ops < HARD_OPS && (now() - start) < HARD_MS) {
    const t0 = now()
    await build().sign()
    const dt = now() - t0
    cur.push(dt)
    overall.push(dt)
    ops++
    if (cur.length >= bucketOps) closeBucket()
  }
  closeBucket()
  const elapsedSec = r3((now() - start) / 1000)
  const first = buckets[0]?.p50Ms ?? 0
  const last = buckets[buckets.length - 1]?.p50Ms ?? 0
  return {
    unit: '50-input engine-routed Transaction.sign (one flow = one op = 50 signatures)',
    inputsPerOp,
    targetMs,
    warmups,
    totalOps: ops,
    totalSignatures: ops * inputsPerOp,
    elapsedSec,
    bucketOps,
    buckets,
    overall: msStats(overall),
    firstBucketP50Ms: first,
    lastBucketP50Ms: last,
    lastOverFirstP50: first > 0 ? r3(last / first) : 0,
    maxBucketP95Ms: r3(Math.max(...buckets.map((b) => b.p95Ms)))
  }
}

/**
 * CR-2: many-run engine-routed frame-stall distribution. rAF heartbeat (the
 * JS-thread 60Hz render/animation proxy) runs the whole time; the engine-routed
 * 50-input sign is the createAction-scale workload; per-run longest JS-thread
 * stall = the max inter-frame gap inside that run's window. RUNS>=20 so the
 * longest-stall claim is a measured distribution, not a rounding rule (B6).
 */
async function runCrFrames (): Promise<NonNullable<CrDeviceReport['frames']>> {
  const { build } = sdkTxFixture(50)
  const RUNS = 30

  // measured idle frame budget (median idle rAF gap) — same as the M5.7 harness
  const idle: number[] = []
  let rafIdle = true
  const tickIdle = (): void => { idle.push(now()); if (rafIdle) requestAnimationFrame(tickIdle) }
  requestAnimationFrame(tickIdle)
  await sleep(600)
  rafIdle = false
  await sleep(50)
  const idleGaps = idle.slice(1).map((t, i) => t - idle[i]).sort((a, b) => a - b)
  const budget60hzMs = idleGaps[Math.floor(idleGaps.length / 2)] ?? 16.667
  const frameBudgetMs = Math.max(4, budget60hzMs)

  // warmup law before the measured runs
  const warmEnd = now() + 500
  while (now() < warmEnd) await build().sign()

  const stamps: number[] = []
  let raf2 = true
  const tick2 = (): void => { stamps.push(now()); if (raf2) requestAnimationFrame(tick2) }
  requestAnimationFrame(tick2)
  await sleep(120)

  const runWindows: Array<[number, number]> = [] // eslint-disable-line @typescript-eslint/array-type
  const workloadDurations: number[] = []
  for (let i = 0; i < RUNS; i++) {
    const t0 = now()
    await build().sign()
    const t1 = now()
    workloadDurations.push(t1 - t0)
    runWindows.push([t0, t1])
    await sleep(60)
  }
  await sleep(120)
  raf2 = false
  await sleep(50)

  // overall inter-frame gap distribution
  const gaps: number[] = []
  let dropped = 0
  for (let i = 1; i < stamps.length; i++) {
    const gap = stamps[i] - stamps[i - 1]
    gaps.push(gap)
    dropped += Math.max(0, Math.round(gap / frameBudgetMs) - 1)
  }
  const gapsSorted = [...gaps].sort((a, b) => a - b)
  const pct = (arr: number[], p: number): number => r3(arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] ?? 0)

  // per-run longest JS-thread stall = max inter-frame gap whose END falls inside
  // the run window (the sign held the thread across that gap).
  const perRun: number[] = []
  for (const [ws, we] of runWindows) {
    let longest = 0
    for (let i = 1; i < stamps.length; i++) {
      if (stamps[i] >= ws && stamps[i] <= we) longest = Math.max(longest, stamps[i] - stamps[i - 1])
    }
    perRun.push(r3(longest))
  }
  const perRunSorted = [...perRun].sort((a, b) => a - b)
  const BUDGET_1FRAME = 1000 / 60 // 16.667 ms
  const runsUnderBudget = perRun.filter((s) => s < BUDGET_1FRAME).length
  workloadDurations.sort((a, b) => a - b)

  return {
    scenario: 'createAction-scale ENGINE-routed 50-input sign under a 60Hz rAF heartbeat',
    runs: RUNS,
    frameBudgetMs: r3(frameBudgetMs),
    budget60hzMs: r3(budget60hzMs),
    totalFrames: stamps.length,
    droppedFrames: dropped,
    workloadP50Ms: r3(workloadDurations[Math.floor(workloadDurations.length / 2)]),
    perRunLongestStallMs: perRun,
    stallP50Ms: pct(perRunSorted, 0.5),
    stallP95Ms: pct(perRunSorted, 0.95),
    stallMaxMs: r3(Math.max(...perRun)),
    runsUnderBudget,
    gapP50Ms: pct(gapsSorted, 0.5),
    gapP95Ms: pct(gapsSorted, 0.95),
    gapP99Ms: pct(gapsSorted, 0.99),
    gapMaxMs: r3(Math.max(...gaps))
  }
}

function formatCrDevice (r: CrDeviceReport): string {
  const L: string[] = []
  L.push('════ CR-DEVICE (A13) — #30 CR-2 / #32 CR-4 / #34 CR-6 ════')
  L.push(`bundle-id label (inlined): ${r.bundleIdLabel ?? 'n/a'}`)
  L.push(`engine present: ${String(r.enginePresent)} | version ${r.engineVersion ?? 'n/a'} | hermes dev: ${String(r.hermesDev)}`)
  L.push(`routed parity (engine carries signs): ${r.parity.pass}/${r.parity.cases} | engine crossings ${r.parity.engineCrossings} (expect ${r.parity.cases}) | tier-2 batchEcdsaSign ${r.parity.secpBatchCrossings} (expect 0)`)
  if (r.routedSignBench != null) {
    const b = r.routedSignBench
    L.push('')
    L.push('── CR-6 A/B bench unit ──')
    L.push(`${b.flow}: min ${b.stats.minMs} / p50 ${b.stats.p50Ms} / p95 ${b.stats.p95Ms} / mean ${b.stats.meanMs} ms over ${b.iters} iters (${b.warmups} warmups)`)
  }
  if (r.soak != null) {
    const s = r.soak
    L.push('')
    L.push('── CR-4 sustained-load / thermal soak ──')
    L.push(`unit: ${s.unit}`)
    L.push(`total ${s.totalOps} ops (${s.totalSignatures} signatures) in ${s.elapsedSec}s | overall min ${s.overall.minMs} / p50 ${s.overall.p50Ms} / p95 ${s.overall.p95Ms} / mean ${s.overall.meanMs} ms`)
    L.push(`first-bucket p50 ${s.firstBucketP50Ms} ms → last-bucket p50 ${s.lastBucketP50Ms} ms (last/first ${s.lastOverFirstP50}×); max bucket p95 ${s.maxBucketP95Ms} ms`)
    L.push('| bucket | ops | min | p50 | p95 | max | mean ms |')
    L.push('|---|---|---|---|---|---|---|')
    for (const b of s.buckets) {
      L.push(`| ${b.bucket} | ${b.opsFrom}-${b.opsTo} | ${b.minMs} | ${b.p50Ms} | ${b.p95Ms} | ${b.maxMs} | ${b.meanMs} |`)
    }
  }
  if (r.frames != null) {
    const f = r.frames
    L.push('')
    L.push('── CR-2 many-run frame-stall distribution ──')
    L.push(`scenario: ${f.scenario} | runs ${f.runs} | budget ${f.frameBudgetMs} ms (60Hz idle ${f.budget60hzMs} ms)`)
    L.push(`frames ${f.totalFrames} | dropped ${f.droppedFrames} | workload p50 ${f.workloadP50Ms} ms`)
    L.push(`per-run longest JS-thread stall: p50 ${f.stallP50Ms} / p95 ${f.stallP95Ms} / max ${f.stallMaxMs} ms | runs under 16.667ms budget: ${f.runsUnderBudget}/${f.runs}`)
    L.push(`all inter-frame gaps: p50 ${f.gapP50Ms} / p95 ${f.gapP95Ms} / p99 ${f.gapP99Ms} / max ${f.gapMaxMs} ms`)
    L.push(`per-run longest stalls (ms): ${f.perRunLongestStallMs.join(', ')}`)
  }
  return L.join('\n')
}

async function deliverCrDevice (payload: string): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const FileSystem = require('expo-file-system/legacy') as typeof import('expo-file-system/legacy')
    if (FileSystem.documentDirectory != null) {
      await FileSystem.writeAsStringAsync(FileSystem.documentDirectory + 'cr-device-result.json', payload)
      console.log('[CR-DEVICE] result written to Documents/cr-device-result.json')
    }
  } catch (e) {
    console.warn('[CR-DEVICE] file delivery failed:', e)
  }
}

export async function runCrDevice (): Promise<CrDeviceReport> {
  const native = g.__bsvEngineNative as EngineNativeLike | undefined
  const report: CrDeviceReport = {
    bundleIdLabel: process.env.EXPO_PUBLIC_CR_BUNDLE_ID ?? null,
    enginePresent: native != null,
    engineVersion: null,
    hermesDev: typeof __DEV__ !== 'undefined' && __DEV__,
    parity: { pass: 0, cases: fixtures.signFlow.length, engineCrossings: 0, secpBatchCrossings: 0 },
    routedSignBench: null,
    soak: null,
    frames: null
  }
  if (native != null) {
    try {
      report.engineVersion = native.version()
      const p = await runRoutedParity()
      report.parity = { pass: p.pass, cases: p.cases, engineCrossings: p.engineCrossings, secpBatchCrossings: p.secpBatchCrossings }
    } catch (e) {
      console.error('[CR-DEVICE] parity failed:', e)
    }
    // A/B bench (both bundle ids) — always
    try {
      report.routedSignBench = await runCrRoutedSignBench()
    } catch (e) {
      console.error('[CR-DEVICE] routed sign bench failed:', e)
    }
    // heavy soak + many-run frames only on the FULL build (EXPO_PUBLIC_CR_FULL=1)
    if (process.env.EXPO_PUBLIC_CR_FULL === '1') {
      try {
        report.frames = await runCrFrames()
      } catch (e) {
        console.error('[CR-DEVICE] frames failed:', e)
      }
      try {
        report.soak = await runCrSoak()
      } catch (e) {
        console.error('[CR-DEVICE] soak failed:', e)
      }
    }
  }
  const text = formatCrDevice(report)
  console.log(text)
  await deliverCrDevice(JSON.stringify({ report, text }))
  return report
}

// ── report plumbing (mirrors secpNativeProof's deliverReport) ────────────────

function formatReport (r: EngineReport): string {
  const lines: string[] = []
  lines.push('════ EngineNative M5.4 simulator smoke ════')
  lines.push(`engine module present: ${String(r.present)}  |  hermes dev mode: ${String(r.hermesDev)}`)
  lines.push(`engine_version: ${r.version ?? 'n/a'}`)
  lines.push(`fixtures: corpus-prefix seed ${r.fixturesMeta.seed}, oracle = ${r.fixturesMeta.oracle}`)
  lines.push(`ping round-trips: ${r.ping.pass}/${r.ping.pass + r.ping.fail} pass`)
  if (r.ping.failures.length > 0) lines.push(`PING FAILURES: ${r.ping.failures.join(', ')}`)
  lines.push(
    `batchSignP2pkhInputs fixtures: ${r.signFlow.pass}/${r.signFlow.cases} byte-identical ` +
      `(${r.signFlow.inputsSigned} inputs signed natively)`
  )
  if (r.signFlow.failures.length > 0) lines.push(`SIGN-FLOW FAILURES: ${r.signFlow.failures.join(' | ')}`)
  lines.push(`must-Err fixtures (CHRONICLE / no-FORKID): ${r.mustErr.pass}/${r.mustErr.pass + r.mustErr.fail} rejected`)
  if (r.mustErr.failures.length > 0) lines.push(`MUST-ERR FAILURES: ${r.mustErr.failures.join(' | ')}`)
  if (r.timing50 != null) {
    const t = r.timing50
    lines.push(
      `50-input batchSignP2pkhInputs (one crossing, off-thread): first ${t.firstMs} ms, ` +
        `min ${t.minMs} / p50 ${t.p50Ms} / mean ${t.meanMs} ms over ${t.iters} iters (${t.warmups} warmups)`
    )
  }
  if (r.routed != null) {
    const m = r.routed
    lines.push('')
    lines.push('════ M5.5 — ROUTED Transaction.sign (issue #23) ════')
    lines.push(
      `routed corpus parity: ${m.parity.pass}/${m.parity.cases} byte-identical through tx.sign() ` +
        `(${m.parity.inputsSigned} inputs) | engine crossings ${m.parity.engineCrossings} ` +
        `(expect ${m.parity.cases}) | tier-2 batchEcdsaSign crossings ${m.parity.secpBatchCrossings} (expect 0)`
    )
    if (m.parity.failures.length > 0) lines.push(`ROUTED FAILURES: ${m.parity.failures.slice(0, 10).join(' | ')}`)
    lines.push(`pure-JS re-sign: ${m.jsResign.pass ? 'PASS' : 'FAIL'} — ${m.jsResign.detail}`)
    lines.push(`poisoned-engine fallback: ${m.fallbackPoisoned.pass ? 'PASS' : 'FAIL'} — ${m.fallbackPoisoned.detail}`)
    lines.push('')
    lines.push('| flow | iters | min / p50 / p95 / mean ms |')
    lines.push('|---|---|---|')
    for (const f of m.flowBench) {
      lines.push(`| ${f.flow} | ${f.iters} | ${f.stats.minMs} / ${f.stats.p50Ms} / ${f.stats.p95Ms} / ${f.stats.meanMs} |`)
    }
    lines.push(`routed-flow crossing counts (one counted 50-input sign): ${JSON.stringify(m.flowCrossings)}`)
    lines.push('')
    lines.push('| frame scenario | runs | budget ms | frames | dropped | longest stall ms | workload p50 ms |')
    lines.push('|---|---|---|---|---|---|---|')
    for (const fr of m.frames) {
      lines.push(`| ${fr.scenario} | ${fr.runs} | ${fr.frameBudgetMs} | ${fr.totalFrames} | ${fr.droppedFrames} | ${fr.longestStallMs} | ${fr.workloadMsP50} |`)
    }
  }
  if (r.verify != null) {
    const v = r.verify
    lines.push('')
    lines.push('════ M5.6 — VERIFY leg (issue #24, batchVerifyP2pkhInputs + shadow) ════')
    lines.push(
      `verdict parity: ${v.parity.pass}/${v.parity.cases} txs byte-verdict-identical through the seam ` +
        `(${v.parity.inputsVerified} inputs) | engine crossings ${v.parity.engineCrossings} (expect ${v.parity.cases}) | ` +
        `mismatches ${v.parity.mismatches} | FORBIDDEN native-accept-JS-reject ${v.parity.forbiddenAccepts}`
    )
    if (v.parity.failures.length > 0) lines.push(`VERIFY FAILURES: ${v.parity.failures.slice(0, 10).join(' | ')}`)
    lines.push(`corrupted-sig reject parity: ${v.corrupted.pass ? 'PASS' : 'FAIL'} — ${v.corrupted.detail}`)
    lines.push(`shadow-mode (real verifyUnlockScripts): ${v.shadow.pass ? 'PASS' : 'FAIL'} — ${v.shadow.detail}`)
    lines.push('')
    lines.push('| verify flow | iters | min / p50 / p95 / mean ms |')
    lines.push('|---|---|---|')
    for (const f of v.bench) {
      lines.push(`| ${f.flow} | ${f.iters} | ${f.stats.minMs} / ${f.stats.p50Ms} / ${f.stats.p95Ms} / ${f.stats.meanMs} |`)
    }
  }
  return lines.join('\n')
}

async function deliverReport (payload: string): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const FileSystem = require('expo-file-system/legacy') as typeof import('expo-file-system/legacy')
    if (FileSystem.documentDirectory != null) {
      await FileSystem.writeAsStringAsync(FileSystem.documentDirectory + 'engine-proof-result.json', payload)
      console.log('[EngineNative] proof written to Documents/engine-proof-result.json')
    }
  } catch (e) {
    console.warn('[EngineNative] file delivery failed:', e)
  }
  const hosts = ['localhost']
  if (process.env.EXPO_PUBLIC_SECP_PROOF_HOST != null && process.env.EXPO_PUBLIC_SECP_PROOF_HOST !== '') {
    hosts.push(process.env.EXPO_PUBLIC_SECP_PROOF_HOST)
  }
  for (const host of hosts) {
    try {
      await fetch(`http://${host}:8787/engine-proof`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload
      })
    } catch {
      // capture server not reachable — the file + console stand alone
    }
  }
}

export async function runEngineProof (): Promise<EngineReport> {
  const native = g.__bsvEngineNative as EngineNativeLike | undefined
  const report: EngineReport = {
    present: native != null,
    version: null,
    hermesDev: typeof __DEV__ !== 'undefined' && __DEV__,
    fixturesMeta: {
      seed: fixtures.meta.seed,
      engine: fixtures.meta.engine,
      oracle: fixtures.meta.oracle
    },
    ping: { pass: 0, fail: 0, failures: [] },
    signFlow: { pass: 0, fail: 0, failures: [], cases: fixtures.signFlow.length, inputsSigned: 0 },
    mustErr: { pass: 0, fail: 0, failures: [] },
    timing50: null,
    routed: null,
    verify: null
  }
  if (native != null) {
    try {
      report.version = native.version()
      report.ping = runPing(native)
      report.signFlow = await runSignFlowFixtures(native)
      report.mustErr = await runMustErr(native)
      report.timing50 = await runTiming50(native)
    } catch (e) {
      console.error('[EngineNative] proof section failed:', e)
    }
    try {
      report.routed = await runRouted()
    } catch (e) {
      console.error('[EngineNative] routed proof section failed:', e)
    }
    try {
      report.verify = await runVerify(native)
    } catch (e) {
      console.error('[EngineNative] verify proof section failed:', e)
    }
  }
  const text = formatReport(report)
  console.log(text)
  await deliverReport(JSON.stringify({ report, text }))
  return report
}

export function scheduleEngineProof (): void {
  setTimeout(() => {
    runEngineProof().catch((e) => console.error('[EngineNative] proof run failed:', e))
  }, 4000)
}
