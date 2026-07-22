// gen-vectors.mjs — generate secp-native conformance vectors from the REAL @bsv/sdk.
//
// Usage:
//   node gen-vectors.mjs <sdk-module-spec> <out.json>
//     spec "@bsv/sdk"                          → published package (resolve from CWD)
//     spec "/abs/path/.../src/primitives/index.ts" → ts-stack source (run via tsx:
//       node --import tsx gen-vectors.mjs ...)
//
// All inputs are DETERMINISTIC (sha256 of labeled strings via node:crypto — independent
// of the SDK under test) so both SDK trees generate over identical inputs and outputs
// can be diffed byte-for-byte. Nothing here signs anything real: keys/messages are
// synthetic test labels only.
//
// Vector classes:
//   sign  — (privkey, msg32) → compressed pubkey + DER sig from ECDSA.sign(forceLowS=true).
//           Includes edge keys (1, 2, n-1) and edge msgs (all-zero, all-0xff — the
//           msg >= n reduction path).
//   brc42 — (privkey, counterpartyPub, invoiceNumber) → sharedPoint, hmac tweak,
//           derived privkey + pubkey (PrivateKey.deriveChild).
//   ecdh  — (privkey, pubkey) → compressed shared point (deriveSharedSecret).
//   tweak — (privkey, tweak) → (priv+t) mod n and P+t·G, both from SDK math.
//
// M2 Tier-1 extension classes (issues #5/#6):
//   recover  — sign → CalculateRecoveryFactor → toCompact → RecoverPublicKey /
//              fromMsgHashAndCompactSignature round-trip, plus what RecoverPublicKey
//              returns for EVERY recid 0..3 (null where the SDK throws).
//   tweakMul — (pubkey, scalar) → t·P from Point.mul (incl. scalar 1, 2, n-1, and G).
//   combine  — (pubkeyA, pubkeyB) → A+B from Point.add (incl. doubling and G).
//   schnorr  — @bsv/sdk Schnorr.ts ZK proof-of-shared-secret (NOT BIP-340) flows.
//              generateProof draws its nonce from PrivateKey.fromRandom internally,
//              so accept vectors are composed from the SAME equations/primitives
//              (Schnorr.ts lines: R = r·G, S' = r·B, e = BigNumber(sha256(A‖B‖S‖S'‖R))
//              umod n, z = (r + e·a) umod n) with a DETERMINISTIC label-derived r,
//              then asserted accepted by the REAL new Schnorr().verifyProof at
//              generation time (plus a nondeterministic self-check of the real
//              generateProof — not emitted). Reject vectors corrupt z / swap points
//              and are asserted rejected by the real verifyProof.

import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'

const [spec, outPath] = process.argv.slice(2)
if (!spec || !outPath) {
  console.error('usage: node gen-vectors.mjs <sdk-module-spec> <out.json>')
  process.exit(1)
}

const SDK = await import(spec)
const { BigNumber, Curve, PrivateKey, PublicKey, ECDSA, Hash, Schnorr, Signature } = SDK.default ?? SDK

const curve = new Curve()
const N = curve.n

const sha256hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex')
const toHex32 = (bn) => bn.toArray('be', 32).map((b) => b.toString(16).padStart(2, '0')).join('')
const arrToHex = (a) => a.map((b) => b.toString(16).padStart(2, '0')).join('')

// Deterministic scalar in [1, n-1] from a label (sha256 output; retry on the
// astronomically unlikely out-of-range case).
function scalarFromLabel (label) {
  for (let i = 0; ; i++) {
    const hex = sha256hex(i === 0 ? label : `${label}/retry-${i}`)
    const bn = new BigNumber(hex, 16)
    if (bn.cmpn(0) > 0 && bn.cmp(N) < 0) return hex
  }
}

function privFromHex (hex) {
  return new PrivateKey(hex, 16)
}
function pubHex (priv) {
  return priv.toPublicKey().encode(true, 'hex')
}

// ── sign vectors ────────────────────────────────────────────────────────────────
const signInputs = []
for (let i = 0; i < 8; i++) {
  signInputs.push({ priv: scalarFromLabel(`secp-poc/priv/${i}`), msg: sha256hex(`secp-poc/msg/${i}`) })
}
// edge keys × normal msgs
const nMinus1 = toHex32(N.subn(1))
signInputs.push({ priv: '01'.padStart(64, '0'), msg: sha256hex('secp-poc/msg/key1') })
signInputs.push({ priv: '02'.padStart(64, '0'), msg: sha256hex('secp-poc/msg/key2') })
signInputs.push({ priv: nMinus1, msg: sha256hex('secp-poc/msg/keyn1') })
// edge msgs × a normal key
const edgeKey = scalarFromLabel('secp-poc/priv/edgemsg')
signInputs.push({ priv: edgeKey, msg: '00'.repeat(32) }) // z = 0
signInputs.push({ priv: edgeKey, msg: 'ff'.repeat(32) }) // msg >= n → reduction path

const sign = signInputs.map(({ priv, msg }) => {
  const key = privFromHex(priv)
  const sig = ECDSA.sign(new BigNumber(msg, 16), key, true) // forceLowS = true
  const der = arrToHex(sig.toDER())
  // sanity: SDK verifies its own signature
  if (!ECDSA.verify(new BigNumber(msg, 16), sig, key.toPublicKey())) {
    throw new Error(`SDK self-verify failed for msg ${msg}`)
  }
  return { privkey: priv, msg32: msg, pubkey: pubHex(key), der }
})

// ── brc42 deriveChild vectors ───────────────────────────────────────────────────
const invoices = [
  '2-3241645161d8-0',
  '2-3241645161d8-1',
  '1-simple counterparty-42',
  'invoice-12345',
  '2-secp-poc-éü☃', // non-ASCII utf8 path
  'l'.repeat(100) // long invoice
]
const brc42 = invoices.map((invoiceNumber, i) => {
  const privHex = scalarFromLabel(`secp-poc/brc42/priv/${i}`)
  const cpPrivHex = scalarFromLabel(`secp-poc/brc42/cp/${i}`)
  const priv = privFromHex(privHex)
  const cpPub = privFromHex(cpPrivHex).toPublicKey()
  const shared = priv.deriveSharedSecret(cpPub)
  const sharedPointHex = shared.encode(true, 'hex')
  const invoiceBytes = Array.from(Buffer.from(invoiceNumber, 'utf8'))
  const tweak = arrToHex(Hash.sha256hmac(shared.encode(true), invoiceBytes))
  const child = priv.deriveChild(cpPub, invoiceNumber)
  return {
    privkey: privHex,
    counterpartyPub: cpPub.encode(true, 'hex'),
    invoiceNumber,
    sharedPoint: sharedPointHex,
    hmacTweak: tweak,
    derivedPriv: toHex32(child),
    derivedPub: pubHex(child)
  }
})

// ── ecdh vectors ────────────────────────────────────────────────────────────────
const ecdh = [0, 1, 2, 3].map((i) => {
  const aHex = scalarFromLabel(`secp-poc/ecdh/a/${i}`)
  const bHex = i === 3 ? '01'.padStart(64, '0') : scalarFromLabel(`secp-poc/ecdh/b/${i}`)
  const a = privFromHex(aHex)
  const bPub = privFromHex(bHex).toPublicKey()
  return {
    privkey: aHex,
    pubkey: bPub.encode(true, 'hex'),
    sharedPoint: a.deriveSharedSecret(bPub).encode(true, 'hex')
  }
})

// ── tweak-add vectors ───────────────────────────────────────────────────────────
const tweak = [0, 1, 2, 3].map((i) => {
  const kHex = i === 3 ? nMinus1 : scalarFromLabel(`secp-poc/tweak/k/${i}`)
  const tHex = scalarFromLabel(`secp-poc/tweak/t/${i}`)
  const k = privFromHex(kHex)
  const t = new BigNumber(tHex, 16)
  const privResult = toHex32(k.add(t).mod(N))
  const pubResult = curve.g.mul(t).add(k.toPublicKey()).encode(true, 'hex')
  return { privkey: kHex, tweak: tHex, pubkey: pubHex(k), privResult, pubResult }
})

// ── recover vectors (issue #5) ──────────────────────────────────────────────────
// sign → factor → compact → recover round-trip, all through the PUBLIC SDK calls
// the app routes (Signature.CalculateRecoveryFactor / RecoverPublicKey /
// PublicKey.fromMsgHashAndCompactSignature).
const recoverInputs = []
for (let i = 0; i < 8; i++) {
  recoverInputs.push({
    priv: scalarFromLabel(`secp-poc/recover/priv/${i}`),
    msg: sha256hex(`secp-poc/recover/msg/${i}`)
  })
}
recoverInputs.push({ priv: '01'.padStart(64, '0'), msg: sha256hex('secp-poc/recover/key1') })
recoverInputs.push({ priv: toHex32(N.subn(1)), msg: '00'.repeat(32) })
recoverInputs.push({ priv: scalarFromLabel('secp-poc/recover/edge'), msg: 'ff'.repeat(32) })

const recover = recoverInputs.map(({ priv, msg }) => {
  const key = privFromHex(priv)
  const pub = key.toPublicKey()
  const msgBN = new BigNumber(msg, 16)
  const sig = ECDSA.sign(msgBN, key, true)
  const recovery = sig.CalculateRecoveryFactor(pub, msgBN)
  const compact = sig.toCompact(recovery, true, 'hex')
  // sanity: both public recovery entry points return the signing key
  if (sig.RecoverPublicKey(recovery, msgBN).encode(true, 'hex') !== pub.encode(true, 'hex')) {
    throw new Error(`RecoverPublicKey round-trip failed for msg ${msg}`)
  }
  if (PublicKey.fromMsgHashAndCompactSignature(msgBN, compact, 'hex').encode(true, 'hex') !== pub.encode(true, 'hex')) {
    throw new Error(`fromMsgHashAndCompactSignature round-trip failed for msg ${msg}`)
  }
  // what the SDK returns for EVERY recid (null = throws). recid 2/3 exercises the
  // documented x = r + n mod-p asymmetry (SDK may fabricate a point where libsecp
  // rejects the field overflow) — the Rust conformance test encodes that rule.
  const recoveredAllFactors = [0, 1, 2, 3].map((recid) => {
    try {
      return sig.RecoverPublicKey(recid, msgBN).encode(true, 'hex')
    } catch {
      return null
    }
  })
  return {
    privkey: priv,
    msg32: msg,
    pubkey: pubHex(key),
    recovery,
    compact,
    recoveredAllFactors
  }
})

// ── tweakMul vectors (t·P via Point.mul) ────────────────────────────────────────
const tweakMul = [0, 1, 2, 3, 4, 5].map((i) => {
  const kHex = i === 4 ? '01'.padStart(64, '0') : scalarFromLabel(`secp-poc/tweakmul/k/${i}`) // i=4 → P = G
  const tHex =
    i === 0
      ? '01'.padStart(64, '0')
      : i === 1
        ? '02'.padStart(64, '0')
        : i === 2
          ? toHex32(N.subn(1))
          : scalarFromLabel(`secp-poc/tweakmul/t/${i}`)
  const P = privFromHex(kHex).toPublicKey()
  const t = new BigNumber(tHex, 16)
  return { pubkey: P.encode(true, 'hex'), scalar: tHex, result: P.mul(t).encode(true, 'hex') }
})

// ── combine vectors (A+B via Point.add) ─────────────────────────────────────────
const combine = [0, 1, 2, 3, 4, 5].map((i) => {
  const aHex = scalarFromLabel(`secp-poc/combine/a/${i}`)
  // i=4 → doubling (B = A); i=5 → B = G
  const bHex = i === 4 ? aHex : i === 5 ? '01'.padStart(64, '0') : scalarFromLabel(`secp-poc/combine/b/${i}`)
  const A = privFromHex(aHex).toPublicKey()
  const B = privFromHex(bHex).toPublicKey()
  return {
    pubkeyA: A.encode(true, 'hex'),
    pubkeyB: B.encode(true, 'hex'),
    result: A.add(B).encode(true, 'hex')
  }
})

// ── schnorr vectors (issue #6 — Schnorr.ts ZK proof of shared secret) ───────────
const schnorrApi = new Schnorr()
const schnorrAccept = [0, 1, 2, 3, 4, 5].map((i) => {
  const aHex = i === 4 ? '01'.padStart(64, '0') : scalarFromLabel(`secp-poc/schnorr/a/${i}`)
  const bHex = i === 5 ? toHex32(N.subn(1)) : scalarFromLabel(`secp-poc/schnorr/b/${i}`)
  const rHex = scalarFromLabel(`secp-poc/schnorr/r/${i}`)
  const a = privFromHex(aHex)
  const b = privFromHex(bHex)
  const r = privFromHex(rHex)
  const A = a.toPublicKey()
  const B = b.toPublicKey()
  const S = B.mul(a) // the DH shared secret (SDK example: S = B.mul(a))
  // Schnorr.generateProof body with the label-derived nonce r:
  const R = r.toPublicKey()
  const SPrime = B.mul(r)
  const e = new BigNumber(
    Hash.sha256([
      ...A.encode(true),
      ...B.encode(true),
      ...S.encode(true),
      ...SPrime.encode(true),
      ...R.encode(true)
    ])
  ).umod(N)
  const z = r.add(e.mul(a)).umod(N)
  // the REAL SDK verifier must accept the composed proof
  if (schnorrApi.verifyProof(A, B, S, { R, SPrime, z }) !== true) {
    throw new Error(`SDK verifyProof rejected composed proof ${i} — equations diverged from Schnorr.ts`)
  }
  return {
    a: aHex,
    b: bHex,
    r: rHex,
    A: A.encode(true, 'hex'),
    B: B.encode(true, 'hex'),
    S: S.encode(true, 'hex'),
    R: R.encode(true, 'hex'),
    SPrime: SPrime.encode(true, 'hex'),
    e: toHex32(e),
    z: toHex32(z)
  }
})
// nondeterministic self-check (NOT emitted): the real generateProof output passes
// the same verifier — guards the composed-equations assumption end-to-end.
{
  const a = privFromHex(schnorrAccept[0].a)
  const b = privFromHex(schnorrAccept[0].b)
  const A = a.toPublicKey()
  const B = b.toPublicKey()
  const S = B.mul(a)
  const proof = schnorrApi.generateProof(a, A, B, S)
  if (schnorrApi.verifyProof(A, B, S, proof) !== true) {
    throw new Error('SDK generateProof/verifyProof self-check failed')
  }
}
// reject vectors: single corruptions of accept vector 0, each asserted rejected
// by the REAL verifyProof. All fields stay well-formed (valid points, z < n) so
// both implementations reach the equation checks.
const schnorrReject = (() => {
  const v = schnorrAccept[0]
  const pt = (hexStr) => PublicKey.fromString(hexStr)
  const cases = [
    { label: 'z+1', A: v.A, B: v.B, S: v.S, R: v.R, SPrime: v.SPrime, z: toHex32(new BigNumber(v.z, 16).addn(1).umod(N)) },
    { label: 'swap R/SPrime', A: v.A, B: v.B, S: v.S, R: v.SPrime, SPrime: v.R, z: v.z },
    { label: 'wrong S', A: v.A, B: v.B, S: v.SPrime, R: v.R, SPrime: v.SPrime, z: v.z },
    { label: 'wrong A', A: schnorrAccept[1].A, B: v.B, S: v.S, R: v.R, SPrime: v.SPrime, z: v.z },
    { label: 'wrong B', A: v.A, B: schnorrAccept[1].B, S: v.S, R: v.R, SPrime: v.SPrime, z: v.z }
  ]
  for (const c of cases) {
    const verdict = schnorrApi.verifyProof(pt(c.A), pt(c.B), pt(c.S), {
      R: pt(c.R),
      SPrime: pt(c.SPrime),
      z: new BigNumber(c.z, 16)
    })
    if (verdict !== false) throw new Error(`SDK verifyProof ACCEPTED corrupted proof (${c.label})`)
  }
  return cases
})()

// ── M3 Tier-2 vector classes (issues #8/#9 — batch flows + uncompressed) ────────
//
// batchSign     — N (msg, key) pairs; expected per element: DER (forceLowS sign)
//                 AND compressed pubkey (the batch fn returns both, framed).
// batchVerify   — the batchSign set with verdicts, incl. corrupted elements.
// batchDerive   — ONE root + ONE counterparty + N invoice numbers; expected
//                 child privs (priv-side) and UNCOMPRESSED child pubs (pub-side,
//                 PublicKey.deriveChild(priv, invoice).encode(false)).
// uncompressed  — the four point-returning single ops with encode(false) results:
//                 toPublicKey / deriveSharedSecret / tweak-add / RecoverPublicKey.
const batchSign = (() => {
  const els = []
  for (let i = 0; i < 12; i++) {
    const privHex = i === 10 ? '01'.padStart(64, '0') : i === 11 ? nMinus1 : scalarFromLabel(`secp-poc/batch/priv/${i}`)
    const msgHex = i === 9 ? 'ff'.repeat(32) : sha256hex(`secp-poc/batch/msg/${i}`)
    const key = privFromHex(privHex)
    const sig = ECDSA.sign(new BigNumber(msgHex, 16), key, true)
    els.push({
      privkey: privHex,
      msg32: msgHex,
      der: arrToHex(sig.toDER()),
      pubkey: pubHex(key)
    })
  }
  return els
})()

const batchVerify = (() => {
  // all-valid set + a set with two corruptions (wrong msg, corrupted sig s+1)
  const valid = batchSign.map((v) => ({ msg32: v.msg32, der: v.der, pubkey: v.pubkey, valid: true }))
  const corrupted = batchSign.slice(0, 6).map((v, i) => {
    if (i === 2) {
      // wrong message
      const flipped = (parseInt(v.msg32.slice(0, 2), 16) ^ 1).toString(16).padStart(2, '0') + v.msg32.slice(2)
      return { msg32: flipped, der: v.der, pubkey: v.pubkey, valid: false }
    }
    if (i === 4) {
      // wrong key
      return { msg32: v.msg32, der: v.der, pubkey: batchSign[5].pubkey, valid: false }
    }
    return { msg32: v.msg32, der: v.der, pubkey: v.pubkey, valid: true }
  })
  // assert with the REAL SDK verify
  for (const c of [...valid, ...corrupted]) {
    const verdict = ECDSA.verify(new BigNumber(c.msg32, 16), Signature.fromDER(c.der, 'hex'), PublicKey.fromString(c.pubkey))
    if (verdict !== c.valid) throw new Error('SDK verify disagreed with batchVerify vector construction')
  }
  return { valid, corrupted }
})()

const batchDerive = (() => {
  const rootHex = scalarFromLabel('secp-poc/batchderive/root')
  const cpHex = scalarFromLabel('secp-poc/batchderive/cp')
  const root = privFromHex(rootHex)
  const cpPriv = privFromHex(cpHex)
  const cpPub = cpPriv.toPublicKey()
  const invoiceNumbers = [
    '2-3241645161d8-prefix suffix0',
    '2-3241645161d8-prefix suffix1',
    '2-3241645161d8-prefix suffix2',
    '1-batch éü☃-0',
    'x'.repeat(120)
  ]
  const derivedPrivs = invoiceNumbers.map((inv) => toHex32(root.deriveChild(cpPub, inv)))
  // pub-side: child of ROOT'S PUBKEY derived by the counterparty (their view of
  // our child key) — PublicKey.deriveChild(cpPriv, invoice) on root.toPublicKey()
  const rootPub = root.toPublicKey()
  const derivedPubsUncompressed = invoiceNumbers.map((inv) => rootPub.deriveChild(cpPriv, inv).encode(false, 'hex'))
  // cross-check: child pub == pubkey(child priv) — BRC-42 consistency
  derivedPrivs.forEach((childHex, i) => {
    if (privFromHex(childHex).toPublicKey().encode(false, 'hex') !== derivedPubsUncompressed[i]) {
      throw new Error('BRC-42 priv/pub batch derivation consistency failed at generation time')
    }
  })
  return {
    root: rootHex,
    counterpartyPriv: cpHex,
    counterpartyPub: cpPub.encode(true, 'hex'),
    rootPub: rootPub.encode(true, 'hex'),
    invoiceNumbers,
    derivedPrivs,
    derivedPubsUncompressed
  }
})()

const uncompressed = (() => {
  const kHex = scalarFromLabel('secp-poc/uncomp/k')
  const bHex = scalarFromLabel('secp-poc/uncomp/b')
  const tHex = scalarFromLabel('secp-poc/uncomp/t')
  const k = privFromHex(kHex)
  const bPub = privFromHex(bHex).toPublicKey()
  const msg = sha256hex('secp-poc/uncomp/msg')
  const msgBN = new BigNumber(msg, 16)
  const sig = ECDSA.sign(msgBN, k, true)
  const recovery = sig.CalculateRecoveryFactor(k.toPublicKey(), msgBN)
  return {
    privkey: kHex,
    pubkey: bPub.encode(true, 'hex'),
    tweak: tHex,
    msg32: msg,
    compact: sig.toCompact(recovery, true, 'hex'),
    pubkeyCreate: k.toPublicKey().encode(false, 'hex'),
    ecdhSharedPoint: k.deriveSharedSecret(bPub).encode(false, 'hex'),
    tweakAdd: curve.g.mul(new BigNumber(tHex, 16)).add(bPub).encode(false, 'hex'),
    recovered: sig.RecoverPublicKey(recovery, msgBN).encode(false, 'hex')
  }
})()

// Signature is referenced to fail fast if the SDK surface is missing it.
if (typeof Signature !== 'function') throw new Error('SDK missing Signature export')

// PublicKey is referenced to fail fast if the SDK surface is missing it (Nitro will use it).
if (typeof PublicKey !== 'function') throw new Error('SDK missing PublicKey export')

const out = {
  meta: {
    generator: 'native-secp-poc/scripts/gen-vectors.mjs',
    sdkSpec: spec,
    note: 'Synthetic deterministic test vectors — sha256-of-label keys/messages, nothing real signed.'
  },
  sign,
  brc42,
  ecdh,
  tweak,
  recover,
  tweakMul,
  combine,
  schnorrAccept,
  schnorrReject,
  batchSign,
  batchVerify,
  batchDerive,
  uncompressed
}
writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n')
console.log(
  `wrote ${outPath}: ${sign.length} sign, ${brc42.length} brc42, ${ecdh.length} ecdh, ${tweak.length} tweak, ` +
    `${recover.length} recover, ${tweakMul.length} tweakMul, ${combine.length} combine, ` +
    `${schnorrAccept.length} schnorrAccept, ${schnorrReject.length} schnorrReject, ` +
    `${batchSign.length} batchSign, ${batchVerify.valid.length + batchVerify.corrupted.length} batchVerify, ` +
    `${batchDerive.invoiceNumbers.length} batchDerive, 1 uncompressed vectors`
)
