/**
 * Template descriptor and byte-exact recognition for the R1-K1 vault locking
 * script (and, in later tasks, its preimage scriptCode).
 *
 * The vault's locking script is 99.996% a fixed template: only a handful of
 * bytes vary between outputs (the R1 commitment and the K1 public-key hash).
 * Storing the whole ~960 KB verbatim per output is what breaks the backup
 * system; this module gives the rest of the codec a byte-exact description
 * of "the constant part" so it can be recompressed to a few dozen bytes and
 * reconstructed exactly.
 *
 * The descriptor is DERIVED from `buildVaultLockingScript`, not transcribed
 * from the plan's pinned constants. Building the same template twice with
 * different throwaway inputs and diffing the two outputs finds exactly the
 * byte ranges that vary; everything else is, by construction, the template's
 * fixed bytes. This means an `@bsv/templates` change that shifts the layout
 * changes the DERIVED descriptor too — callers that additionally assert the
 * derived values against the plan's pinned constants (see
 * templateCodec.test.ts) will see that as a test failure, never a silent
 * drift.
 *
 * SECURITY: nothing secret passes through this module. `describeVaultTemplate`
 * generates its own throwaway keys/salts purely to build sample scripts for
 * diffing; none of that key material is retained or returned.
 */
import { Hash, Utils } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'
import { buildVaultLockingScript } from './r1k1'
import { randomBytes } from './random'

/** Marker byte for a compressed script. OP_INVALIDOPCODE (0xff) — NEVER
 * OP_NOP7/0xb6 or any other NOP-like opcode. If a compressed blob ever escapes
 * onto the wire in place of a real script, it must fail to execute rather
 * than be interpreted as some other spendable script. */
export const TEMPLATE_MARKER = 0xff

/** 0x01 = R1K1 locking script, 0x02 = R1K1 preimage scriptCode. */
export type TemplateRegion = 0x01 | 0x02

/**
 * A byte-exact description of one template version: its total length, the
 * byte ranges that vary between instances, and a fingerprint (`constantHash`)
 * of everything else. Intentionally holds no script bytes itself — those are
 * cached separately (see `describeVaultTemplate`) — so this stays a small,
 * serialisable value.
 */
export interface TemplateVersion {
  version: number
  region: TemplateRegion
  totalLength: number
  variableRuns: { offset: number; length: number }[]
  constantHash: string
}

/** How many independently-random sample builds to diff when deriving
 * variable-byte runs. Each sample's variable bytes come from an independent
 * hash160/random draw, so the chance that every sample happens to agree at a
 * given variable byte position is astronomically small once more than one or
 * two samples are compared; a handful of samples makes it negligible without
 * meaningfully slowing this down (building the template is fast — well under
 * a second for all samples combined). */
const DIFF_SAMPLE_COUNT = 4

/** Cache of the raw constant reference bytes for a version, keyed by
 * `${version}:${region}`. `matchesTemplate` compares candidate bytes directly
 * against this in place (no masked copy, no hash-then-compare) so a mismatch
 * anywhere outside the variable runs is caught on the first differing byte
 * without touching the rest of the ~960 KB script. Populated as a side effect
 * of `describeVaultTemplate`; a `TemplateVersion` whose reference was never
 * cached (e.g. a hand-built object rather than one this module produced)
 * fails closed rather than matching. */
const referenceBytesByKey = new Map<string, number[]>()

function versionKey(version: number, region: TemplateRegion): string {
  return `${version}:${region}`
}

/** One random-but-valid input triple for `buildVaultLockingScript`. Only used
 * to build throwaway sample scripts for diffing; the keys are discarded
 * immediately after. */
function throwawayInputs(): { r1PublicKey: string; salt: string; k1PublicKeyHash: number[] } {
  const r1PublicKey = Utils.toHex(Array.from(p256.getPublicKey(p256.utils.randomSecretKey(), true)))
  const salt = Utils.toHex(randomBytes(32))
  const k1PublicKeyHash = randomBytes(20)
  return { r1PublicKey, salt, k1PublicKeyHash }
}

/** Merge the byte offsets where the samples disagree into contiguous runs. */
function findVariableRuns(samples: number[][]): { offset: number; length: number }[] {
  const length = samples[0].length
  const runs: { offset: number; length: number }[] = []
  let runStart = -1
  for (let i = 0; i < length; i++) {
    const first = samples[0][i]
    const varies = samples.some((s) => s[i] !== first)
    if (varies) {
      if (runStart === -1) runStart = i
    } else if (runStart !== -1) {
      runs.push({ offset: runStart, length: i - runStart })
      runStart = -1
    }
  }
  if (runStart !== -1) runs.push({ offset: runStart, length: length - runStart })
  return runs
}

/** SHA-256 (hex) of `bytes` with every variable run zeroed out first, so the
 * hash fingerprints only the constant template and is identical regardless of
 * which real commitment/hash values occupy the variable runs. */
function constantHashOf(bytes: number[], runs: { offset: number; length: number }[]): string {
  const masked = bytes.slice()
  for (const r of runs) {
    for (let i = r.offset; i < r.offset + r.length; i++) masked[i] = 0
  }
  return Utils.toHex(Hash.sha256(masked))
}

let cachedDescriptors: TemplateVersion[] | undefined

/**
 * Build the current R1-K1 locking-script template (with throwaway inputs)
 * several times, diff the results to find the variable byte runs, and return
 * the resulting descriptor(s). Memoized: the template never changes within a
 * process, and rebuilding a ~960 KB script several times per call would be
 * wasteful for callers (e.g. the compress/expand path) that call this on
 * every backup or restore.
 */
export async function describeVaultTemplate(): Promise<TemplateVersion[]> {
  if (cachedDescriptors) return cachedDescriptors

  const samples: number[][] = []
  for (let i = 0; i < DIFF_SAMPLE_COUNT; i++) {
    const script = await buildVaultLockingScript(throwawayInputs())
    samples.push(script.toBinary())
  }

  const totalLength = samples[0].length
  const variableRuns = findVariableRuns(samples)
  const constantHash = constantHashOf(samples[0], variableRuns)

  const version = 1
  const region: TemplateRegion = 0x01
  referenceBytesByKey.set(versionKey(version, region), samples[0])

  cachedDescriptors = [{ version, region, totalLength, variableRuns, constantHash }]
  return cachedDescriptors
}

/**
 * True only when `bytes` is exactly `v.totalLength` long AND every byte
 * outside `v.variableRuns` equals the cached reference template's byte at
 * that offset. Compares in place against the cached reference — no masked
 * copy of the candidate, no hashing — and returns on the first differing
 * byte, so a non-matching script (the common case for anything that isn't a
 * vault output) is rejected in O(distance to first mismatch), not O(960 KB).
 */
export function matchesTemplate(bytes: number[], v: TemplateVersion): boolean {
  if (bytes.length !== v.totalLength) return false

  const reference = referenceBytesByKey.get(versionKey(v.version, v.region))
  if (!reference) return false

  const runs = [...v.variableRuns].sort((a, b) => a.offset - b.offset)
  let runIdx = 0
  for (let i = 0; i < bytes.length; i++) {
    while (runIdx < runs.length && i >= runs[runIdx].offset + runs[runIdx].length) runIdx++
    const inRun = runIdx < runs.length && i >= runs[runIdx].offset
    if (inRun) continue
    if (bytes[i] !== reference[i]) return false
  }
  return true
}
