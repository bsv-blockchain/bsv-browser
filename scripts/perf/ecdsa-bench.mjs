#!/usr/bin/env node
/**
 * Node-only micro-benchmark: pure-JS @bsv/sdk ECDSA vs noble fast path.
 *
 * Does not load React Native / Metro. On device, the app prefers native-secp256k1
 * when linked; this script measures the noble fallback that Jest and incomplete
 * native builds use, against stock BSV pure-JS ECDSA.
 *
 * Usage:
 *   node scripts/perf/ecdsa-bench.mjs
 *   node scripts/perf/ecdsa-bench.mjs --n=500
 */

import { performance } from 'node:perf_hooks'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..', '..')
const require = createRequire(import.meta.url)

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const m = a.match(/^--([^=]+)=(.*)$/)
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true]
  })
)
const N = Math.max(1, parseInt(args.n || '100', 10) || 100)

// ── Wire noble hashes (required by @noble/secp256k1 v3) ─────────────────────
const secp = require('@noble/secp256k1')
const { sha256 } = require('@noble/hashes/sha2')
const { hmac } = require('@noble/hashes/hmac')
secp.hashes.sha256 = sha256
secp.hashes.hmacSha256 = (key, msg) => hmac(sha256, key, msg)

// ── BSV pure-JS path (deep require — package exports hide primitives/) ───────
const { PrivateKey, BigNumber } = require('@bsv/sdk')
const OriginalECDSA = require(
  resolve(ROOT, 'node_modules/@bsv/sdk/dist/cjs/src/primitives/ECDSA.js')
)

// Fixed message hash + private key for apples-to-apples comparison
const MSG_HEX = '4d7a2145a347e0aabf58a6a1260ae359436b27eaca5ac5cba6685a6f6e0fe39c'
const PRIV_HEX = '0000000000000000000000000000000000000000000000000000000000000001'

const msgBn = new BigNumber(MSG_HEX, 16)
const privKey = new PrivateKey(PRIV_HEX, 16)
const privBn = privKey

const msg32 = Uint8Array.from(Buffer.from(MSG_HEX, 'hex'))
const priv32 = Uint8Array.from(Buffer.from(PRIV_HEX, 'hex'))

function bench(label, fn, iterations) {
  // Warm-up (discard)
  for (let i = 0; i < Math.min(10, iterations); i++) fn()

  const t0 = performance.now()
  for (let i = 0; i < iterations; i++) fn()
  const t1 = performance.now()
  const totalMs = t1 - t0
  const msPerOp = totalMs / iterations
  const opsPerSec = iterations / (totalMs / 1000)
  return { label, totalMs, msPerOp, opsPerSec, iterations }
}

function printResult(r) {
  console.log(
    `  ${r.label.padEnd(42)} ${r.msPerOp.toFixed(4)} ms/op  ` +
      `(${r.totalMs.toFixed(1)} ms / ${r.iterations} ops, ${Math.round(r.opsPerSec).toLocaleString()} ops/s)`
  )
}

console.log(`\nECDSA micro-benchmark (Node, N=${N})`)
console.log('Comparing pure-JS @bsv/sdk ECDSA vs noble fast path (no native/RN)\n')

// Sanity: both paths produce verifiable low-S signatures
{
  const bsvSig = OriginalECDSA.sign(msgBn, privBn, true)
  const nobleCompact = secp.sign(msg32, priv32, {
    prehash: false,
    lowS: true,
    format: 'compact'
  })
  const pub33 = secp.getPublicKey(priv32, true)
  const nobleOk = secp.verify(nobleCompact, msg32, pub33, { prehash: false, lowS: true })
  const bsvOk = OriginalECDSA.verify(msgBn, bsvSig, privKey.toPublicKey())
  if (!nobleOk || !bsvOk) {
    console.error('Sanity check failed: signatures do not verify')
    process.exit(1)
  }
  console.log('  Sanity: BSV original + noble sign/verify OK\n')
}

const results = []

results.push(
  bench(
    'BSV original ECDSA.sign (forceLowS)',
    () => OriginalECDSA.sign(msgBn, privBn, true),
    N
  )
)

results.push(
  bench(
    'BSV PrivateKey.sign (stock SDK path)',
    () => privKey.sign(Array.from(msg32), 'raw', true),
    N
  )
)

results.push(
  bench(
    'noble secp.sign compact lowS',
    () =>
      secp.sign(msg32, priv32, {
        prehash: false,
        lowS: true,
        format: 'compact'
      }),
    N
  )
)

// Optional: hash baseline (PrivateKey.sign always SHA-256s first)
results.push(
  bench(
    'node:crypto sha256 (32B in)',
    () => createHash('sha256').update(msg32).digest(),
    N
  )
)

console.log('Results:')
for (const r of results) printResult(r)

const bsv = results.find(r => r.label.startsWith('BSV original'))
const noble = results.find(r => r.label.startsWith('noble'))
if (bsv && noble && noble.msPerOp > 0) {
  const speedup = bsv.msPerOp / noble.msPerOp
  console.log(
    `\n  noble vs BSV original ECDSA: ${speedup.toFixed(2)}× ` +
      `(${bsv.msPerOp.toFixed(4)} → ${noble.msPerOp.toFixed(4)} ms/op)`
  )
}

console.log(`
Notes:
  - This is the Node/Jest path (noble). On a rebuilt dev client, installFastEcdsa
    prefers native-secp256k1; log shows "Fast ECDSA backend: native" vs "noble".
  - Device native is typically much faster than noble Node numbers above.
  - Re-run with --n=1000 for tighter medians on faster machines.
`)
