/**
 * Generates the vault ceremony tones as committed WAV assets.
 *
 * Design brief (spec §5.3): "delightful but serious". A heavy door, not a slot
 * machine. Two tones, both tuned well below full scale to sit under the
 * existing payment chime:
 *
 *   vault-open.wav  (~0.7s) low rounded dyad rising a minor third (D3→F3),
 *                   soft-mallet timbre + a faint metallic partial tail —
 *                   a bolt turning and a door easing open.
 *   vault-close.wav (~0.5s) single lower thunk (A2) with fast decay —
 *                   the bolt sliding home.
 *
 * Pure Node, no deps: additive sine synthesis + exponential envelopes, hand
 * written RIFF/PCM header. Run: node scripts/generate-vault-sounds.mjs
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const SR = 44100
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'sounds')

const note = f => f // hz, readability alias
const D3 = note(146.83)
const F3 = note(174.61)
const A2 = note(110.0)

// One additive voice: partials [ratio, gain], exponential decay, soft attack.
function voice(t, f0, partials, attack, decay) {
  const env = (t < attack ? t / attack : Math.exp(-(t - attack) / decay))
  let s = 0
  for (const [ratio, gain] of partials) s += gain * Math.sin(2 * Math.PI * f0 * ratio * t)
  return env * s
}

function render(durationS, fn) {
  const n = Math.floor(durationS * SR)
  const buf = new Float64Array(n)
  let peak = 0
  for (let i = 0; i < n; i++) {
    const v = fn(i / SR)
    buf[i] = v
    peak = Math.max(peak, Math.abs(v))
  }
  // Normalize to -6 dBFS so it stays gentle under other audio.
  const target = 0.5 // ~ -6 dBFS
  const g = peak > 0 ? target / peak : 1
  const out = Buffer.alloc(44 + n * 2)
  // RIFF header
  out.write('RIFF', 0)
  out.writeUInt32LE(36 + n * 2, 4)
  out.write('WAVE', 8)
  out.write('fmt ', 12)
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20) // PCM
  out.writeUInt16LE(1, 22) // mono
  out.writeUInt32LE(SR, 24)
  out.writeUInt32LE(SR * 2, 28)
  out.writeUInt16LE(2, 32)
  out.writeUInt16LE(16, 34)
  out.write('data', 36)
  out.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, buf[i] * g))
    out.writeInt16LE(Math.round(s * 32767), 44 + i * 2)
  }
  return { out, peak, samples: n }
}

// vault-open: D3+F3 dyad, soft mallet (strong fundamental + gentle 2nd/3rd),
// plus a quiet high metallic partial that decays fast — the "turn".
const open = render(0.7, t => {
  const door =
    voice(t, D3, [[1, 0.6], [2, 0.18], [3, 0.06]], 0.012, 0.45) +
    voice(t, F3, [[1, 0.5], [2, 0.14], [3, 0.05]], 0.03, 0.4)
  const metal = 0.08 * voice(t, D3, [[9.2, 1], [11.7, 0.6]], 0.004, 0.08)
  return door + metal
})

// vault-close: single A2 thunk, quick decay, tiny click transient at onset.
const close = render(0.5, t => {
  const thunk = voice(t, A2, [[1, 0.7], [2, 0.2], [3, 0.05]], 0.006, 0.16)
  const click = 0.12 * voice(t, A2, [[6.1, 1]], 0.001, 0.02)
  return thunk + click
})

writeFileSync(join(OUT, 'vault-open.wav'), open.out)
writeFileSync(join(OUT, 'vault-close.wav'), close.out)
console.log(`vault-open.wav  ${open.samples} samples (${(open.samples / SR).toFixed(2)}s) peak ${open.peak.toFixed(3)}`)
console.log(`vault-close.wav ${close.samples} samples (${(close.samples / SR).toFixed(2)}s) peak ${close.peak.toFixed(3)}`)
