/**
 * M2 dev-only proof harness (native-crypto).
 *
 * Runs all 27 native-secp-poc/fixtures/vectors.json vectors through the ROUTED
 * @bsv/sdk calls (the patched primitives — NOT the Nitro module directly, so
 * this proves the routing seam), verifies the native path was actually taken
 * (call-counting proxy around globalThis.__bsvSecpNative), then micro-benches
 * routed vs original-JS for the hot ops.
 *
 * Activated ONLY when the app is launched with EXPO_PUBLIC_SECP_PROOF=1 in a
 * dev build (see index.js). Results go to console AND are POSTed to
 * http://localhost:8787/secp-proof so the host can capture them
 * (native-secp-poc/M2-SIMULATOR-RESULTS.md).
 */
import { BigNumber, Curve, ECDSA, P2PKH, Point, PrivateKey, PublicKey, Schnorr, Signature, Transaction } from '@bsv/sdk'
import vectors from '../native-secp-poc/fixtures/vectors.json'

interface OpStats {
  minUs: number
  p50Us: number
  p95Us: number
  meanUs: number
}

type Report = {
  native: boolean
  hermesDev: boolean
  conformance: { pass: number; fail: number; failures: string[] }
  nativeCallCounts: Record<string, number>
  bench: {
    op: string
    iters: number
    routed: OpStats
    js: OpStats
    speedupMean: number
    speedupP50: number
  }[]  
  m3?: {
    conformance: { pass: number; fail: number; failures: string[] }
    nativeCallCounts: Record<string, number>
    flowCallCounts: { batched: Record<string, number>; singles: Record<string, number> }
    flowBench: Array<{ flow: string; iters: number; batchedMs: OpStats; singlesMs: OpStats; jsMs: OpStats }> // eslint-disable-line @typescript-eslint/array-type
    frames: {
      scenario: string
      runs: number
      frameBudgetMs: number
      totalFrames: number
      droppedFrames: number
      longestStallMs: number
      workloadMsP50: number
    }[]  
  }
}

const hex = (a: number[]): string => a.map((b) => b.toString(16).padStart(2, '0')).join('')
const now = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()

const g = globalThis as Record<string, any>

const NATIVE_KEYS = [
  'ecdsaSign', 'ecdsaVerify', 'pubkeyCreate', 'pubkeyTweakAdd', 'privkeyTweakAdd',
  'ecdhSharedPoint', 'brc42DeriveChild', 'ecdsaRecover', 'ecdsaRecoveryFactor',
  'pubkeyTweakMul', 'pubkeyCombine', 'schnorrGenerateProof', 'schnorrVerifyProof',
  // M3 (issues #8/#9)
  'pubkeyCreateUncompressed', 'ecdhSharedPointUncompressed', 'pubkeyTweakAddUncompressed',
  'ecdsaRecoverUncompressed', 'brc42DeriveChildPubUncompressed',
  'batchEcdsaSign', 'batchEcdsaVerify', 'batchBrc42DeriveChild', 'batchBrc42DeriveChildPubUncompressed'
]
const BATCH_KEYS = ['batchEcdsaSign', 'batchEcdsaVerify', 'batchBrc42DeriveChild', 'batchBrc42DeriveChildPubUncompressed']

/** Counting proxy over a native module object (only keys present on it). */
function countingProxy (real: Record<string, any>, counts: Record<string, number>, omit: string[] = []): Record<string, any> {
  const proxy: Record<string, any> = {}
  for (const key of NATIVE_KEYS) {
    if (typeof real[key] !== 'function' || omit.includes(key)) continue
    proxy[key] = (...args: unknown[]) => {
      counts[key] = (counts[key] ?? 0) + 1
      return real[key](...args)
    }
  }
  return proxy
}

function withCounting<T>(fn: (counts: Record<string, number>) => T): T {
  const real = g.__bsvSecpNative
  const counts: Record<string, number> = {}
  if (real != null) {
    g.__bsvSecpNative = countingProxy(real, counts)
  }
  try {
    return fn(counts)
  } finally {
    if (real != null) g.__bsvSecpNative = real
  }
}

function runConformance (): { pass: number; fail: number; failures: string[]; counts: Record<string, number> } {
  const curve = new Curve()
  let pass = 0
  const failures: string[] = []
  const check = (label: string, ok: boolean): void => {
    if (ok) pass++
    else failures.push(label)
  }
  const counts = withCounting((counts) => {
    for (const v of vectors.sign) {
      const key = new PrivateKey(v.privkey, 16)
      const sig = ECDSA.sign(new BigNumber(v.msg32, 16), key, true)
      const ok =
        hex(sig.toDER() as number[]) === v.der &&
        key.toPublicKey().encode(true, 'hex') === v.pubkey &&
        ECDSA.verify(
          new BigNumber(v.msg32, 16),
          Signature.fromDER(v.der, 'hex'),
          PublicKey.fromString(v.pubkey)
        )
      check(`sign ${v.msg32.slice(0, 8)}`, ok)
    }
    for (const v of vectors.brc42) {
      const priv = new PrivateKey(v.privkey, 16)
      const cpPub = PublicKey.fromString(v.counterpartyPub)
      const shared = priv.deriveSharedSecret(cpPub)
      const child = priv.deriveChild(cpPub, v.invoiceNumber)
      // Pub-side deriveChild (PublicKey.deriveChild routing): child of cpPub
      // must equal cpPub + tweak·G with the FIXTURE tweak (unrouted g.mul/add
      // are the pure-JS reference).
      const pubSide = cpPub.deriveChild(priv, v.invoiceNumber)
      const expectedPubSide = curve.g
        .mul(new BigNumber(v.hmacTweak, 16))
        .add(Point.fromString(v.counterpartyPub))
        .encode(true, 'hex')
      const ok =
        shared.encode(true, 'hex') === v.sharedPoint &&
        hex(child.toArray('be', 32)) === v.derivedPriv &&
        child.toPublicKey().encode(true, 'hex') === v.derivedPub &&
        pubSide.encode(true, 'hex') === expectedPubSide
      check(`brc42 ${v.invoiceNumber.slice(0, 12)}`, ok)
    }
    for (const v of vectors.ecdh) {
      const shared = new PrivateKey(v.privkey, 16).deriveSharedSecret(PublicKey.fromString(v.pubkey))
      check(`ecdh ${v.privkey.slice(0, 8)}`, shared.encode(true, 'hex') === v.sharedPoint)
    }
    for (const v of vectors.tweak) {
      const k = new PrivateKey(v.privkey, 16)
      const priv = hex(k.add(new BigNumber(v.tweak, 16)).mod(curve.n).toArray('be', 32))
      const pub = curve.g.mul(new BigNumber(v.tweak, 16)).add(k.toPublicKey()).encode(true, 'hex')
      check(`tweak ${v.tweak.slice(0, 8)}`, priv === v.privResult && pub === v.pubResult)
    }
    // M2 Tier-1 extension (issues #5/#6) — the ROUTED recovery entry points
    for (const v of vectors.recover) {
      const msgBN = new BigNumber(v.msg32, 16)
      const sig = Signature.fromCompact(v.compact, 'hex')
      const viaRecover = sig.RecoverPublicKey(v.recovery, msgBN).encode(true, 'hex')
      const viaCompact = PublicKey.fromMsgHashAndCompactSignature(msgBN, v.compact, 'hex').encode(true, 'hex')
      const factor = sig.CalculateRecoveryFactor(PublicKey.fromString(v.pubkey), msgBN)
      check(
        `recover ${v.msg32.slice(0, 8)}`,
        viaRecover === v.pubkey && viaCompact === v.pubkey && factor === v.recovery
      )
    }
    // Schnorr flow calls (routed generateProof draws its own random nonce, so
    // fixture parity is proven via verifyProof; generate is round-tripped
    // against BOTH verifier paths below).
    const schnorr = new Schnorr()
    for (const v of vectors.schnorrAccept) {
      const ok = schnorr.verifyProof(
        Point.fromString(v.A),
        Point.fromString(v.B),
        Point.fromString(v.S),
        { R: Point.fromString(v.R), SPrime: Point.fromString(v.SPrime), z: new BigNumber(v.z, 16) }
      )
      check(`schnorrAccept ${v.z.slice(0, 8)}`, ok === true)
    }
    for (const v of vectors.schnorrReject) {
      const ok = schnorr.verifyProof(
        Point.fromString(v.A),
        Point.fromString(v.B),
        Point.fromString(v.S),
        { R: Point.fromString(v.R), SPrime: Point.fromString(v.SPrime), z: new BigNumber(v.z, 16) }
      )
      check(`schnorrReject ${v.label}`, ok === false)
    }
    // routed generateProof (random nonce) → accepted by BOTH the routed
    // verifier AND the pure-JS verifier (native module temporarily removed)
    for (let i = 0; i < 4; i++) {
      const a = new PrivateKey(vectors.schnorrAccept[i].a, 16)
      const b = new PrivateKey(vectors.schnorrAccept[i].b, 16)
      const A = a.toPublicKey()
      const B = b.toPublicKey()
      const S = B.mul(a)
      const proof = schnorr.generateProof(a, A, B, S)
      const routedVerdict = schnorr.verifyProof(A, B, S, proof)
      const realNative = g.__bsvSecpNative
      delete g.__bsvSecpNative
      const jsVerdict = schnorr.verifyProof(A, B, S, proof)
      if (realNative != null) g.__bsvSecpNative = realNative
      check(`schnorrGen roundtrip ${i}`, routedVerdict === true && jsVerdict === true)
    }
    return counts
  })
  return { pass, fail: failures.length, failures, counts }
}

interface BenchSetup {
  keys: PrivateKey[]
  msgs: BigNumber[]
  cpPub: PublicKey
  sigs: Signature[]
  pubs: PublicKey[]
  pubsAll: PublicKey[]
  recoveries: number[]
  schnorr: Schnorr
  schnorrInstances: { A: PublicKey; B: PublicKey; S: Point; proof: { R: Point; SPrime: Point; z: BigNumber } }[]
}

const r2 = (x: number): number => Math.round(x * 100) / 100

function benchOne (label: string, iters: number, setup: BenchSetup, op: (s: BenchSetup, i: number) => void): OpStats {
  // Pinned warmup: busy-loop the SAME op for ~500ms before timing. The device
  // bench track proved a 3-iteration warmup reads 5-10x slow on these phones
  // (efficiency cores + cold JIT); half a second of the identical work pins the
  // frequency and warms Hermes before any sample is recorded.
  const warmEnd = now() + 500
  let w = 0
  while (now() < warmEnd) {
    op(setup, w % iters)
    w++
  }
  // Per-iteration samples for percentiles. performance.now() call-pair overhead
  // is sub-µs against ops >= tens of µs (asterisked in the results doc).
  const samples: number[] = new Array(iters)
  for (let i = 0; i < iters; i++) {
    const t0 = now()
    op(setup, i)
    samples[i] = (now() - t0) * 1000 // µs
  }
  samples.sort((a, b) => a - b)
  const mean = samples.reduce((a, b) => a + b, 0) / iters
  return {
    minUs: r2(samples[0]),
    p50Us: r2(samples[Math.floor(iters * 0.5)]),
    p95Us: r2(samples[Math.min(iters - 1, Math.floor(iters * 0.95))]),
    meanUs: r2(mean)
  }
}

function runBench (iters: number): Report['bench'] {
  const base = new PrivateKey(vectors.sign[0].privkey, 16)
  const cpPub = PublicKey.fromString(vectors.brc42[0].counterpartyPub)
  const keys: PrivateKey[] = []
  const msgs: BigNumber[] = []
  for (let i = 0; i < iters + 20; i++) {
    const b = base.toArray('be', 32)
    b[0] = 0x0f // keep < n
    b[28] = (i >> 8) & 0xff
    b[29] = i & 0xff
    keys.push(new PrivateKey(b))
    const m = vectors.sign.map((v) => v.msg32)[i % vectors.sign.length]
    const mb = new BigNumber(m, 16).toArray('be', 32)
    mb[30] = (i >> 8) & 0xff
    mb[31] = i & 0xff
    msgs.push(new BigNumber(mb))
  }
  const pubsAll = keys.map((k) => k.toPublicKey())
  const pubs = pubsAll.slice(0, 25)
  const setup: BenchSetup = {
    keys, msgs, cpPub, sigs: [], pubs, pubsAll, recoveries: [], schnorr: new Schnorr(), schnorrInstances: []
  }
  setup.sigs = msgs.map((m, i) => ECDSA.sign(m, keys[i], true))
  setup.recoveries = setup.sigs.map((sig, i) => sig.CalculateRecoveryFactor(pubsAll[i], msgs[i]))
  // Schnorr DH instances + valid proofs (25 reused round-robin — proof
  // generation is the expensive part; verify inputs must be valid proofs)
  for (let i = 0; i < 25; i++) {
    const a = keys[i]
    const A = pubsAll[i]
    const B = pubsAll[(i + 25) % pubsAll.length]
    const S = B.mul(a)
    setup.schnorrInstances.push({ A, B, S, proof: setup.schnorr.generateProof(a, A, B, S) })
  }

  const ops: [string, (s: BenchSetup, i: number) => void][] = [
    ['ECDSA.sign (forceLowS)', (s, i) => { ECDSA.sign(s.msgs[i], s.keys[i], true) }],
    ['ECDSA.verify', (s, i) => { ECDSA.verify(s.msgs[i], s.sigs[i], s.pubsAll[i]) }],
    ['PrivateKey.toPublicKey', (s, i) => { s.keys[i].toPublicKey() }],
    ['PrivateKey.deriveChild (BRC-42)', (s, i) => { s.keys[i].deriveChild(s.cpPub, `bench-${i}`) }],
    ['PublicKey.deriveChild (BRC-42)', (s, i) => { s.cpPub.deriveChild(s.keys[i], `bench-${i}`) }],
    ['PrivateKey.deriveSharedSecret', (s, i) => { s.keys[i].deriveSharedSecret(s.pubs[i % 25]) }],
    ['Signature.RecoverPublicKey', (s, i) => { s.sigs[i].RecoverPublicKey(s.recoveries[i], s.msgs[i]) }],
    ['Signature.CalculateRecoveryFactor', (s, i) => { s.sigs[i].CalculateRecoveryFactor(s.pubsAll[i], s.msgs[i]) }],
    ['Schnorr.generateProof', (s, i) => {
      const inst = s.schnorrInstances[i % 25]
      s.schnorr.generateProof(s.keys[i % 25], inst.A, inst.B, inst.S)
    }],
    ['Schnorr.verifyProof', (s, i) => {
      const inst = s.schnorrInstances[i % 25]
      s.schnorr.verifyProof(inst.A, inst.B, inst.S, inst.proof)
    }]
  ]

  const results: Report['bench'] = []
  const real = g.__bsvSecpNative
  for (const [label, op] of ops) {
    g.__bsvSecpNative = real
    const routed = benchOne(label, iters, setup, op)
    delete g.__bsvSecpNative
    const js = benchOne(label, iters, setup, op)
    g.__bsvSecpNative = real
    results.push({
      op: label,
      iters,
      routed,
      js,
      speedupMean: r2(js.meanUs / routed.meanUs),
      speedupP50: r2(js.p50Us / routed.p50Us)
    })
  }
  return results
}

// ═══ M3 (issues #8/#9/#10): batch flows, uncompressed routes, frame harness ═══

const sleep = async (ms: number): Promise<void> => await new Promise((resolve) => setTimeout(resolve, ms))
const hexU8 = (u: Uint8Array): string => Array.from(u).map((b) => b.toString(16).padStart(2, '0')).join('')
const hexToBuf = (h: string): ArrayBuffer => {
  const u = new Uint8Array(h.length / 2)
  for (let i = 0; i < u.length; i++) u[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return u.buffer
}

/** N-input P2PKH transaction fixture (distinct keys, self-funded source tx). */
function txFixture (nInputs: number): { build: () => Transaction } {
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

/** M3 conformance: batch fns vs SDK-generated vectors + routed flow equivalence. */
async function runM3Conformance (): Promise<{ pass: number; fail: number; failures: string[]; counts: Record<string, number> }> {
  let pass = 0
  const failures: string[] = []
  const check = (label: string, ok: boolean): void => {
    if (ok) pass++
    else failures.push(label)
  }
  const counts: Record<string, number> = {}
  const real = g.__bsvSecpNative
  if (real == null) return { pass, fail: 1, failures: ['native module absent'], counts }
  g.__bsvSecpNative = countingProxy(real, counts)
  try {
    const nat = g.__bsvSecpNative
    // batchSign vectors: ONE native call == per-element SDK DER + pubkey
    {
      const v = (vectors as any).batchSign as { privkey: string; msg32: string; der: string; pubkey: string }[]
      const msgs = hexToBuf(v.map((t) => t.msg32).join(''))
      const keys = hexToBuf(v.map((t) => t.privkey).join(''))
      const framed = new Uint8Array(await nat.batchEcdsaSign(msgs, keys))
      let off = 0
      let ok = true
      for (const t of v) {
        const len = framed[off]
        ok = ok &&
          hexU8(framed.subarray(off + 1, off + 1 + len)) === t.der &&
          hexU8(framed.subarray(off + 1 + len, off + 1 + len + 33)) === t.pubkey
        off += 1 + len + 33
      }
      check('m3 batchSign vectors', ok && off === framed.length)
    }
    // batchVerify vectors: verdicts match the SDK's per-element verdicts
    for (const setName of ['valid', 'corrupted'] as const) {
      const set = (vectors as any).batchVerify[setName] as { msg32: string; der: string; pubkey: string; valid: boolean }[]
      const msgs = hexToBuf(set.map((t) => t.msg32).join(''))
      const sigs = hexToBuf(set.map((t) => (t.der.length / 2).toString(16).padStart(2, '0') + t.der).join(''))
      const pubs = hexToBuf(set.map((t) => t.pubkey).join(''))
      const verdicts = new Uint8Array(await nat.batchEcdsaVerify(msgs, sigs, pubs))
      check(`m3 batchVerify ${setName}`, set.every((t, i) => (verdicts[i] === 1) === t.valid))
    }
    // batchDerive vectors: priv side + uncompressed pub side
    {
      const d = (vectors as any).batchDerive
      const privCat = new Uint8Array(await nat.batchBrc42DeriveChild(
        hexToBuf(d.root), hexToBuf(d.counterpartyPub), d.invoiceNumbers))
      const pubCat = new Uint8Array(await nat.batchBrc42DeriveChildPubUncompressed(
        hexToBuf(d.counterpartyPriv), hexToBuf(d.rootPub), d.invoiceNumbers))
      check('m3 batchDerive priv', d.derivedPrivs.every((h: string, i: number) => hexU8(privCat.subarray(i * 32, (i + 1) * 32)) === h))
      check('m3 batchDerive pubUncompressed', d.derivedPubsUncompressed.every((h: string, i: number) => hexU8(pubCat.subarray(i * 65, (i + 1) * 65)) === h))
    }
    // uncompressed single-op vectors through the ROUTED SDK calls (the calls
    // now internally take the *Uncompressed native fns — counts prove it)
    {
      const u = (vectors as any).uncompressed
      const k = new PrivateKey(u.privkey, 16)
      check('m3 uncomp toPublicKey', k.toPublicKey().encode(false, 'hex') === u.pubkeyCreate)
      check('m3 uncomp deriveSharedSecret', k.deriveSharedSecret(PublicKey.fromString(u.pubkey)).encode(false, 'hex') === u.ecdhSharedPoint)
      const sig = Signature.fromCompact(u.compact, 'hex')
      const rec = (parseInt(u.compact.slice(0, 2), 16) - 27) & 3
      check('m3 uncomp RecoverPublicKey', sig.RecoverPublicKey(rec, new BigNumber(u.msg32, 16)).encode(false, 'hex') === u.recovered)
    }
    // ROUTED FLOW: Transaction.sign batch path == pure-JS byte-identical, and
    // the whole 12-input signing took exactly ONE native crossing. M5.5: with
    // the Tier-3 engine present the crossing is batchSignP2pkhInputs (tier 1)
    // and batchEcdsaSign stays fallback-only (0 here); with the engine absent
    // the crossing is batchEcdsaSign (tier 2) exactly as in M3.
    {
      const { build } = txFixture(12)
      const realEngine = g.__bsvEngineNative
      const engineCounts: Record<string, number> = {}
      if (realEngine != null) {
        g.__bsvEngineNative = {
          batchSignP2pkhInputs: (...args: unknown[]) => {
            engineCounts.batchSignP2pkhInputs = (engineCounts.batchSignP2pkhInputs ?? 0) + 1
            return realEngine.batchSignP2pkhInputs(...args)
          }
        }
      }
      const before = counts.batchEcdsaSign ?? 0
      const txN = build()
      await txN.sign()
      const secpCrossings = (counts.batchEcdsaSign ?? 0) - before
      const engineCrossings = engineCounts.batchSignP2pkhInputs ?? 0
      const oneCrossing = realEngine != null
        ? engineCrossings === 1 && secpCrossings === 0
        : secpCrossings === 1
      const nativeHex = txN.toHex()
      delete g.__bsvSecpNative
      delete g.__bsvEngineNative
      const txJ = build()
      await txJ.sign()
      g.__bsvSecpNative = countingProxy(real, counts)
      if (realEngine != null) g.__bsvEngineNative = realEngine
      check('m3 tx.sign one crossing', oneCrossing)
      check('m3 tx.sign batch == pure-JS bytes', nativeHex === txJ.toHex())
    }
    // PublicKey.deriveChild single-composite route parity (uncompressed out)
    {
      const d = (vectors as any).batchDerive
      const rootPub = PublicKey.fromString(d.rootPub)
      const cpPriv = new PrivateKey(d.counterpartyPriv, 16)
      check('m3 pub deriveChild composite', d.invoiceNumbers.every((inv: string, i: number) =>
        rootPub.deriveChild(cpPriv, inv).encode(false, 'hex') === d.derivedPubsUncompressed[i]))
    }
    return { pass, fail: failures.length, failures, counts }
  } finally {
    g.__bsvSecpNative = real
  }
}

interface FlowStats { flow: string, iters: number, batchedMs: OpStats, singlesMs: OpStats, jsMs: OpStats }

function msStats (samples: number[]): OpStats {
  const s = [...samples].sort((a, b) => a - b)
  const mean = s.reduce((a, b) => a + b, 0) / s.length
  return {
    minUs: r2(s[0]),
    p50Us: r2(s[Math.floor(s.length * 0.5)]),
    p95Us: r2(s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]),
    meanUs: r2(mean)
  } // NOTE: field names say Us; flow benches record MILLISECONDS (formatter labels them)
}

async function benchFlow (label: string, iters: number, run: () => Promise<void>): Promise<OpStats> {
  // flow-scale warmup: 3 runs (each flow run is itself hundreds of ops)
  for (let w = 0; w < 3; w++) await run()
  const samples: number[] = []
  for (let i = 0; i < iters; i++) {
    const t0 = now()
    await run()
    samples.push(now() - t0)
  }
  return msStats(samples)
}

/** Flow benches: 50-input sign and 20-key derive — batched vs singles vs JS.
 *  M5.5: the Tier-3 engine is REMOVED for the duration so these legs keep
 *  measuring the secp tiers (the M3 numbers stay comparable release-to-
 *  release); the engine-routed flow bench lives in engineNativeProof.ts. */
async function runM3FlowBench (): Promise<{ flows: FlowStats[]; batchedCounts: Record<string, number>; singlesCounts: Record<string, number> }> {
  const real = g.__bsvSecpNative
  const realEngine = g.__bsvEngineNative
  delete g.__bsvEngineNative
  try {
    return await runM3FlowBenchInner(real)
  } finally {
    if (realEngine != null) g.__bsvEngineNative = realEngine
  }
}

async function runM3FlowBenchInner (real: any): Promise<{ flows: FlowStats[]; batchedCounts: Record<string, number>; singlesCounts: Record<string, number> }> {
  const flows: FlowStats[] = []
  const batchedCounts: Record<string, number> = {}
  const singlesCounts: Record<string, number> = {}
  if (real == null) return { flows, batchedCounts, singlesCounts }

  // ── 50-input Transaction.sign ────────────────────────────────────────────
  {
    const { build } = txFixture(50)
    const signIters = 12
    g.__bsvSecpNative = real
    const batchedMs = await benchFlow('sign50 batched', signIters, async () => { await build().sign() })
    g.__bsvSecpNative = countingProxy(real, singlesCounts, BATCH_KEYS) // native singles, no batch fns
    const singlesMs = await benchFlow('sign50 singles', signIters, async () => { await build().sign() })
    delete g.__bsvSecpNative
    const jsMs = await benchFlow('sign50 js', 4, async () => { await build().sign() }) // pure JS is ~50x slower; fewer iters
    g.__bsvSecpNative = countingProxy(real, batchedCounts)
    await build().sign() // one counted batched run for the crossing-count evidence
    g.__bsvSecpNative = real
    flows.push({ flow: '50-input Transaction.sign (ms)', iters: signIters, batchedMs, singlesMs, jsMs })
  }

  // ── 20-key BRC-42 derive (one counterparty, 20 invoice numbers) ──────────
  {
    const root = new PrivateKey(31337)
    const cpPub = new PrivateKey(999).toPublicKey()
    const invoices = Array.from({ length: 20 }, (_, i) => `2-3241645161d8-flow ${i}`)
    const root32 = hexToBuf(root.toHex().padStart(64, '0'))
    const cp33 = Uint8Array.from(cpPub.encode(true) as number[]).buffer
    const deriveIters = 30
    g.__bsvSecpNative = real
    const batchedMs = await benchFlow('derive20 batched', deriveIters, async () => {
      await real.batchBrc42DeriveChild(root32, cp33, invoices)
    })
    const singlesMs = await benchFlow('derive20 singles', deriveIters, async () => {
      for (const inv of invoices) root.deriveChild(cpPub, inv)
    })
    delete g.__bsvSecpNative
    const jsMs = await benchFlow('derive20 js', 6, async () => {
      for (const inv of invoices) root.deriveChild(cpPub, inv)
    })
    g.__bsvSecpNative = countingProxy(real, batchedCounts)
    await (g.__bsvSecpNative as any).batchBrc42DeriveChild(root32, cp33, invoices)
    g.__bsvSecpNative = real
    flows.push({ flow: '20-key BRC-42 deriveChild (ms)', iters: deriveIters, batchedMs, singlesMs, jsMs })
  }
  return { flows, batchedCounts, singlesCounts }
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

/**
 * Frame-drop harness (issue #10, the standard's gate-4 number): runs a
 * requestAnimationFrame loop — the JS thread's frame heartbeat — WHILE a
 * createAction-scale crypto workload executes, and counts missed frames from
 * inter-frame gaps. rAF on the RN JS thread stalls exactly when the JS thread
 * is busy, which is the jank GROK_REVIEW items 1/10 complain about (UI-thread
 * Reanimated worklets keep running, but JS-driven animation/gesture/response
 * work does not — this measures that).
 */
async function measureFrames (
  scenario: string,
  runs: number,
  frameBudgetMs: number,
  workload: () => Promise<void> | void
): Promise<FrameScenario> {
  const stamps: number[] = []
  let raf = true
  const tick = (): void => {
    stamps.push(now())
    if (raf) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  await sleep(120) // settle the loop before loading it
  const workloadDurations: number[] = []
  for (let i = 0; i < runs; i++) {
    const t0 = now()
    await workload()
    workloadDurations.push(now() - t0)
    await sleep(60) // breathing room between runs (frames here count too)
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
    frameBudgetMs: r2(frameBudgetMs),
    totalFrames: stamps.length,
    droppedFrames: dropped,
    longestStallMs: r2(longest),
    workloadMsP50: r2(workloadDurations[Math.floor(workloadDurations.length / 2)])
  }
}

/** The representative createAction-scale workload: 20 BRC-42 derivations + a 20-input tx sign.
 *  M5.5: engine removed for the duration (same rationale as runM3FlowBench). */
async function runM3FrameHarness (): Promise<FrameScenario[]> {
  const realEngine = g.__bsvEngineNative
  delete g.__bsvEngineNative
  try {
    return await runM3FrameHarnessInner()
  } finally {
    if (realEngine != null) g.__bsvEngineNative = realEngine
  }
}

async function runM3FrameHarnessInner (): Promise<FrameScenario[]> {
  const real = g.__bsvSecpNative
  const out: FrameScenario[] = []
  const { build } = txFixture(20)
  const root = new PrivateKey(31337)
  const cpPub = new PrivateKey(999).toPublicKey()
  const invoices = Array.from({ length: 20 }, (_, i) => `2-3241645161d8-frame ${i}`)
  const root32 = hexToBuf(root.toHex().padStart(64, '0'))
  const cp33 = Uint8Array.from(cpPub.encode(true) as number[]).buffer

  // measure the device's real frame budget from an idle rAF loop (ProMotion
  // devices tick at 120Hz → ~8.3ms; simulators/60Hz → ~16.7ms): median idle gap
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

  const workloadBatched = async (): Promise<void> => {
    // the routed app flow: batched off-thread derive + one-crossing tx sign
    await (g.__bsvSecpNative as any).batchBrc42DeriveChild(root32, cp33, invoices)
    await build().sign()
  }
  const workloadSingles = async (): Promise<void> => {
    for (const inv of invoices) root.deriveChild(cpPub, inv)
    await build().sign()
  }

  if (real != null) {
    g.__bsvSecpNative = real
    out.push(await measureFrames('createAction-scale routed+batched (after)', 5, frameBudgetMs, workloadBatched))
    g.__bsvSecpNative = countingProxy(real, {}, BATCH_KEYS)
    out.push(await measureFrames('createAction-scale routed singles', 5, frameBudgetMs, workloadSingles))
  }
  delete g.__bsvSecpNative
  out.push(await measureFrames('createAction-scale pure-JS (before)', 3, frameBudgetMs, workloadSingles))
  if (real != null) g.__bsvSecpNative = real
  return out
}

function formatReport (r: Report): string {
  const lines: string[] = []
  lines.push('════ SecpNative M2 proof ════')
  lines.push(`native module present: ${String(r.native)}  |  hermes dev mode: ${String(r.hermesDev)}`)
  lines.push(`conformance (routed SDK calls): ${r.conformance.pass}/${r.conformance.pass + r.conformance.fail} pass`)
  if (r.conformance.failures.length > 0) lines.push(`FAILURES: ${r.conformance.failures.join(', ')}`)
  lines.push(`native call counts during conformance: ${JSON.stringify(r.nativeCallCounts)}`)
  lines.push('')
  lines.push('| op | iters | routed min/p50/p95/mean µs | pure-JS min/p50/p95/mean µs | speedup (mean / p50) |')
  lines.push('|---|---|---|---|---|')
  for (const b of r.bench) {
    const f = (s: OpStats): string => `${s.minUs} / ${s.p50Us} / ${s.p95Us} / ${s.meanUs}`
    lines.push(`| ${b.op} | ${b.iters} | ${f(b.routed)} | ${f(b.js)} | ${b.speedupMean}x / ${b.speedupP50}x |`)
  }
  if (r.m3 != null) {
    const m = r.m3
    lines.push('')
    lines.push('════ M3 (issues #8/#9/#10) ════')
    lines.push(`m3 conformance (batch fns + routed flows): ${m.conformance.pass}/${m.conformance.pass + m.conformance.fail} pass`)
    if (m.conformance.failures.length > 0) lines.push(`M3 FAILURES: ${m.conformance.failures.join(', ')}`)
    lines.push(`m3 native call counts: ${JSON.stringify(m.nativeCallCounts)}`)
    lines.push(`flow crossing counts — batched: ${JSON.stringify(m.flowCallCounts.batched)}  singles: ${JSON.stringify(m.flowCallCounts.singles)}`)
    lines.push('')
    lines.push('| flow | iters | batched min/p50/p95/mean ms | singles min/p50/p95/mean ms | pure-JS min/p50/p95/mean ms |')
    lines.push('|---|---|---|---|---|')
    for (const f of m.flowBench) {
      const s = (x: OpStats): string => `${x.minUs} / ${x.p50Us} / ${x.p95Us} / ${x.meanUs}`
      lines.push(`| ${f.flow} | ${f.iters} | ${s(f.batchedMs)} | ${s(f.singlesMs)} | ${s(f.jsMs)} |`)
    }
    lines.push('')
    lines.push('| frame scenario | runs | budget ms | frames | dropped | longest stall ms | workload p50 ms |')
    lines.push('|---|---|---|---|---|---|---|')
    for (const fr of m.frames) {
      lines.push(`| ${fr.scenario} | ${fr.runs} | ${fr.frameBudgetMs} | ${fr.totalFrames} | ${fr.droppedFrames} | ${fr.longestStallMs} | ${fr.workloadMsP50} |`)
    }
  }
  return lines.join('\n')
}

async function deliverReport (payload: string): Promise<void> {
  // 1) Write into the app's Documents dir so the host can pull it via
  //    `xcrun devicectl device copy from ... --domain-type appDataContainer`
  //    (works wired, no network assumptions — the release/device path).
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const FileSystem = require('expo-file-system/legacy') as typeof import('expo-file-system/legacy')
    if (FileSystem.documentDirectory != null) {
      await FileSystem.writeAsStringAsync(FileSystem.documentDirectory + 'secp-proof-result.json', payload)
      console.log('[SecpNative] proof written to Documents/secp-proof-result.json')
    }
  } catch (e) {
    console.warn('[SecpNative] file delivery failed:', e)
  }
  // 2) Best-effort POSTs: localhost (simulator) and an optional host LAN IP
  //    baked in at bundle time via EXPO_PUBLIC_SECP_PROOF_HOST (device).
  const hosts = ['localhost']
  if (process.env.EXPO_PUBLIC_SECP_PROOF_HOST != null && process.env.EXPO_PUBLIC_SECP_PROOF_HOST !== '') {
    hosts.push(process.env.EXPO_PUBLIC_SECP_PROOF_HOST)
  }
  for (const host of hosts) {
    try {
      await fetch(`http://${host}:8787/secp-proof`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload
      })
    } catch {
      // capture server not reachable on this host — the file + console stand alone
    }
  }
}

export async function runSecpProof (): Promise<Report> {
  const native = g.__bsvSecpNative != null
  const conf = runConformance()
  const report: Report = {
    native,
    hermesDev: typeof __DEV__ !== 'undefined' && __DEV__,
    conformance: { pass: conf.pass, fail: conf.fail, failures: conf.failures },
    nativeCallCounts: conf.counts,
    bench: runBench(200)
  }
  // M3 (issues #8/#9/#10): batch conformance, flow benches, frame harness.
  try {
    const m3Conf = await runM3Conformance()
    const { flows, batchedCounts, singlesCounts } = await runM3FlowBench()
    const frames = await runM3FrameHarness()
    report.m3 = {
      conformance: { pass: m3Conf.pass, fail: m3Conf.fail, failures: m3Conf.failures },
      nativeCallCounts: m3Conf.counts,
      flowCallCounts: { batched: batchedCounts, singles: singlesCounts },
      flowBench: flows,
      frames
    }
  } catch (e) {
    console.error('[SecpNative] M3 proof section failed:', e)
  }
  const text = formatReport(report)
  console.log(text)
  await deliverReport(JSON.stringify({ report, text }))
  return report
}

export function scheduleSecpProof (): void {
  // Give the app + JSI modules a moment to finish booting before hammering the JS thread.
  setTimeout(() => {
    runSecpProof().catch((e) => console.error('[SecpNative] proof run failed:', e))
  }, 4000)
}
