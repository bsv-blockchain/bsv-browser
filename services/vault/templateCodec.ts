/**
 * Template descriptor and byte-exact recognition for the R1-K1 vault locking
 * script and its sighash preimage's scriptCode.
 *
 * The vault's locking script is 99.996% a fixed template: only a handful of
 * bytes vary between outputs (the R1 commitment and the K1 public-key hash).
 * Storing the whole ~960 KB verbatim per output is what breaks the backup
 * system; this module gives the rest of the codec a byte-exact description
 * of "the constant part" so it can be recompressed to a few dozen bytes and
 * reconstructed exactly.
 *
 * As of region 0x02, this module also describes the R1-K1 sighash preimage's
 * `scriptCode` — the piece that makes SPENDING transactions huge, since
 * `R1K1Wallet.unlockR1` pushes the whole preimage (commitment locking script
 * included) into the unlocking script. Its descriptor is derived from the
 * region-0x01 one, not built independently — see `describeVaultTemplate`.
 *
 * The descriptor is DERIVED from `buildVaultLockingScript`, not transcribed
 * from the plan's pinned constants. Building the same template twice with
 * different throwaway inputs and diffing the two outputs finds exactly the
 * byte ranges that vary; everything else is, by construction, the template's
 * fixed bytes. This means an `@bsv/templates` change that shifts the layout
 * changes the DERIVED descriptor too — callers that additionally assert the
 * derived values against the plan's pinned constants (see
 * templateCodec.test.ts) will see that as a test failure, never a silent
 * drift. A layout change that DOESN'T shift the length or the variable-run
 * offsets — i.e. one that keeps 959,632 bytes but alters some of the fixed
 * bytes in between — would NOT show up in `totalLength`/`variableRuns` at
 * all, which is why `describeVaultTemplate` additionally checks the live
 * template's `constantHash` against a pinned literal at runtime (see
 * `PINNED_CONSTANT_HASH_V1`) and throws rather than silently reconstructing
 * against stale bytes. That check runs on every process, not just CI.
 *
 * SECURITY: nothing secret passes through this module. `describeVaultTemplate`
 * generates its own throwaway keys/salts purely to build sample scripts for
 * diffing; none of that key material is retained or returned.
 */
import { Hash, Utils } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'
import { R1K1_LOCK_LEN, buildVaultLockingScript } from './r1k1'
import { randomBytes } from './random'
import { VaultError } from './types'

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
 * cached in THIS process (e.g. rehydrated from persisted/serialised form, or
 * simply never obtained via `describeVaultTemplate`) makes `matchesTemplate`
 * throw rather than silently answer `false` — see its doc comment for why a
 * cache miss must never look like an ordinary non-match. */
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

/**
 * The version-1/region-0x01 template's `constantHash` (see `constantHashOf`),
 * pinned as a literal — computed once from the CURRENT `@bsv/templates`
 * R1K1Wallet output and hardcoded here deliberately, per the design spec:
 * versions are pinned "by the constant bytes they describe, not by an
 * `@bsv/templates` semver range."
 *
 * This is what makes a same-length constant-byte drift fail loudly instead
 * of silently: `originalLength`/`totalLength` alone cannot catch a library
 * upgrade that keeps 959,632 bytes but changes some of the fixed template
 * bytes (e.g. a reordered OP_CHECKSIG branch) — `expandScript` would splice
 * a real compressed payload into a WRONG reference template and hand back
 * confidently wrong bytes for a real, already-mined, real-money output, with
 * no error at all. Comparing the live template's freshly-computed
 * `constantHash` against this pinned value at `describeVaultTemplate` time
 * closes that gap: any drift in the constant bytes changes the hash, and
 * `describeVaultTemplate` throws `template-unknown` rather than accepting a
 * template it was never verified against.
 *
 * Changing this literal is a deliberate act, not routine maintenance: it
 * must happen together with minting a NEW version number (and, if the
 * variable-run shape also changed, updating the compress/expand code that
 * assumes it) — never as a silent "make the assertion pass again" edit.
 */
const PINNED_CONSTANT_HASH_V1 = '41f6fcbbc46fe0eeb64a176fd66709694331b2327b1a63086105529e34a7493b'

/**
 * Number of bytes `R1K1Wallet.unlockR1` drops from the FRONT of the locking
 * script before committing the remainder into the sighash preimage's
 * `scriptCode`:
 *
 *   formatPreimage(tx, inputIndex, source, new Script([], lockingBytes.subarray(60), void 0, false))
 *
 * (verified against the `@bsv/templates` source — see R1K1Wallet.js's
 * `unlockR1`). This is the one load-bearing constant region 0x02 is built
 * from: `describeVaultTemplate` derives the ENTIRE region-0x02 descriptor by
 * slicing this many bytes off the region-0x01 samples it already built,
 * rather than hardcoding 959,572 (959,632 − 60) or re-deriving the
 * commitment/k1PublicKeyHash offsets independently. If `@bsv/templates` ever
 * changes how many bytes `unlockR1` drops, this is the one constant to
 * update — everything else in region 0x02 (its length, its variable run, its
 * pinned constant hash) recomputes from it automatically and any drift shows
 * up as a `template-unknown` throw below, not a silent wrong reconstruction.
 */
const PREIMAGE_SCRIPT_CODE_OFFSET = 60

/**
 * The version-1/region-0x02 (preimage scriptCode) template's `constantHash`,
 * pinned the same way as `PINNED_CONSTANT_HASH_V1` above: computed once from
 * the CURRENT `@bsv/templates` output (region-0x01 samples sliced by
 * `PREIMAGE_SCRIPT_CODE_OFFSET`) and hardcoded here deliberately, so a
 * same-length drift in the scriptCode's constant bytes fails loudly instead
 * of silently reconstructing wrong bytes for a real spend. Changing this
 * literal is a deliberate act tied to minting a new version, never a silent
 * "make the assertion pass again" edit — see `PINNED_CONSTANT_HASH_V1`'s
 * fuller doc comment, which this mirrors.
 */
const PINNED_CONSTANT_HASH_V1_SCRIPT_CODE = 'f759656aadfcdbd531531c9806b8bce89f7ed4363c7d3f07578455fb1b96a990'

let cachedDescriptors: TemplateVersion[] | undefined

/**
 * Build the current R1-K1 locking-script template (with throwaway inputs)
 * several times, diff the results to find the variable byte runs, and return
 * the resulting descriptor(s). Memoized: the template never changes within a
 * process, and rebuilding a ~960 KB script several times per call would be
 * wasteful for callers (e.g. the compress/expand path) that call this on
 * every backup or restore.
 *
 * Throws `VaultError('template-unknown')` if the live template disagrees
 * with the pinned reference in ANY way this codec was verified against —
 * `totalLength !== R1K1_LOCK_LEN` (an `@bsv/templates` upgrade that changed
 * the script's length; also caught downstream by `originalLength` checks,
 * but checked here too so the failure surfaces at the earliest possible
 * point) or `constantHash !== PINNED_CONSTANT_HASH_V1` (a same-length drift
 * in the constant bytes, which nothing else in this module would ever
 * detect — see `PINNED_CONSTANT_HASH_V1`'s doc comment). This is the check
 * that makes a library upgrade fail loudly on a real device rather than
 * merely fail this repo's CI.
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

  if (totalLength !== R1K1_LOCK_LEN || constantHash !== PINNED_CONSTANT_HASH_V1) {
    throw new VaultError(
      'template-unknown',
      `live R1-K1 template disagrees with the pinned reference (length ${totalLength} vs ${R1K1_LOCK_LEN} expected` +
        `, constantHash ${constantHash} vs ${PINNED_CONSTANT_HASH_V1} expected) — an @bsv/templates upgrade changed ` +
        'the template; this requires a new pinned version, not a silent reconstruction against stale bytes'
    )
  }

  const version = 1
  const region: TemplateRegion = 0x01
  referenceBytesByKey.set(versionKey(version, region), samples[0])

  // Region 0x02: the sighash preimage's scriptCode. DERIVED from the same
  // region-0x01 samples above by dropping their first
  // `PREIMAGE_SCRIPT_CODE_OFFSET` bytes — never built independently and never
  // hardcoded — so the two descriptors can never disagree about where the
  // scriptCode starts or how long it is. Because the R1 commitment's variable
  // run (offset 17, length 20) lies entirely below the offset, it drops out
  // of `scriptCodeSamples` altogether; only the k1PublicKeyHash run survives,
  // shifted down by the same offset. That is why region 0x02's payload ends
  // up 20 bytes (k1PublicKeyHash only), not the 40-byte commitment +
  // k1PublicKeyHash pair region 0x01 carries.
  const scriptCodeSamples = samples.map((s) => s.slice(PREIMAGE_SCRIPT_CODE_OFFSET))
  const scriptCodeLength = scriptCodeSamples[0].length
  const scriptCodeVariableRuns = findVariableRuns(scriptCodeSamples)
  const scriptCodeConstantHash = constantHashOf(scriptCodeSamples[0], scriptCodeVariableRuns)

  if (scriptCodeConstantHash !== PINNED_CONSTANT_HASH_V1_SCRIPT_CODE) {
    throw new VaultError(
      'template-unknown',
      `live R1-K1 preimage scriptCode disagrees with the pinned reference (constantHash ${scriptCodeConstantHash} ` +
        `vs ${PINNED_CONSTANT_HASH_V1_SCRIPT_CODE} expected) — an @bsv/templates upgrade changed the template; ` +
        'this requires a new pinned version, not a silent reconstruction against stale bytes'
    )
  }

  const scriptCodeRegion: TemplateRegion = 0x02
  referenceBytesByKey.set(versionKey(version, scriptCodeRegion), scriptCodeSamples[0])

  cachedDescriptors = [
    { version, region, totalLength, variableRuns, constantHash },
    {
      version,
      region: scriptCodeRegion,
      totalLength: scriptCodeLength,
      variableRuns: scriptCodeVariableRuns,
      constantHash: scriptCodeConstantHash
    }
  ]
  return cachedDescriptors
}

/**
 * True only when `bytes` is exactly `v.totalLength` long AND every byte
 * outside `v.variableRuns` equals the cached reference template's byte at
 * that offset. Compares in place against the cached reference — no masked
 * copy of the candidate, no hashing — and returns on the first differing
 * byte, so a non-matching script (the common case for anything that isn't a
 * vault output) is rejected in O(distance to first mismatch), not O(960 KB).
 *
 * Throws `VaultError('template-invalid')`, rather than returning `false`, if
 * this process never cached reference bytes for `v.version`/`v.region` (i.e.
 * `describeVaultTemplate()` was never awaited here). `TemplateVersion` is a
 * small, serialisable value, so nothing stops a caller from persisting one
 * and rehydrating it in a later process; without this check, doing so would
 * make every real vault script silently and permanently "not match" — no
 * exception, no log — in that process, which is a compression path quietly
 * going dark rather than a corruption risk. A cache miss must never come
 * back looking like an ordinary non-match.
 */
export function matchesTemplate(bytes: number[], v: TemplateVersion): boolean {
  const reference = referenceBytesByKey.get(versionKey(v.version, v.region))
  if (!reference) {
    throw new VaultError(
      'template-invalid',
      `matchesTemplate has no cached reference for version ${v.version} region ${v.region} in this process — ` +
        'describeVaultTemplate() must be awaited before recognition is attempted'
    )
  }

  if (bytes.length !== v.totalLength) return false

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

/*
 * ---------------------------------------------------------------------------
 * Compress / expand
 *
 * On-wire (and on-disk, for backup) layout of a compressed script, exactly
 * (pinned by the plan's Global Constraints):
 *
 *   0xff (1) ‖ version (1) ‖ region (1) ‖ originalLength (4, big-endian) ‖ payload
 *
 * 0xff is OP_INVALIDOPCODE: not a defined opcode anywhere, so a compressed
 * blob that somehow escaped onto the wire in place of a real locking script
 * would fail script evaluation outright rather than being interpreted as
 * some other (spendable, or worse, always-true) script. OP_NOP7 (0xb6) was
 * explicitly rejected for this role: it IS a valid, defined no-op opcode, so
 * a compressed script left in place could still pass evaluation. See the
 * plan's Global Constraints for this decision.
 *
 * The payload is just the bytes of each variable run, concatenated in
 * ascending offset order — for region 0x01 that is commitment(20) ‖
 * k1PublicKeyHash(20), 40 bytes, making a compressed locking script exactly
 * 7 + 40 = 47 bytes; for region 0x02 (the preimage scriptCode) that is
 * k1PublicKeyHash(20) alone — the commitment run doesn't survive the
 * scriptCode's leading 60-byte cut, see `describeVaultTemplate` — making a
 * compressed scriptCode exactly 7 + 20 = 27 bytes. Nothing here hardcodes
 * either shape though: both directions walk `TemplateVersion.variableRuns`,
 * so a version with different/more runs is handled by the same code without
 * change.
 * ---------------------------------------------------------------------------
 */

const HEADER_LENGTH = 7 // marker(1) + version(1) + region(1) + originalLength(4)

function writeUInt32BE(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
}

function readUInt32BE(bytes: number[], offset: number): number {
  return (
    ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
  )
}

/** Sum of every variable run's length — the payload size a version's header
 * must be followed by. */
function payloadLengthOf(v: TemplateVersion): number {
  return v.variableRuns.reduce((sum, r) => sum + r.length, 0)
}

/** True iff `bytes` opens with the compressed-script marker. A quick,
 * length-1 check only — it tells a caller "this looks like a compressed
 * script, route it to `expandScript`", not "this is a well-formed one".
 * `expandScript` still validates the rest of the header and throws on
 * anything malformed; nothing here should be used as a substitute for that. */
export function isCompressed(bytes: number[]): boolean {
  return bytes.length > 0 && bytes[0] === TEMPLATE_MARKER
}

/**
 * Compress a recognised template instance of `region` down to its 7-byte
 * header plus the concatenated variable-run bytes. Bytes that don't match any
 * known version of `region` — including a merely near-miss, per
 * `matchesTemplate`'s exactness — are returned unchanged (a fresh copy, not
 * the header format): this must never turn unrecognised bytes into something
 * that looks compressed.
 *
 * Awaits `describeVaultTemplate()` itself before consulting `matchesTemplate`
 * so the normal path can never hit that function's "no cached reference"
 * throw — this is always called with the descriptors it just (re)populated
 * the cache for, in the same tick. Shared by `compressScript` (region 0x01)
 * and `compressScriptCode` (region 0x02) so the two never fork behaviour.
 */
async function compressForRegion(bytes: number[], region: TemplateRegion): Promise<number[]> {
  const descriptors = await describeVaultTemplate()

  for (const v of descriptors) {
    if (v.region !== region) continue
    if (!matchesTemplate(bytes, v)) continue

    const runs = [...v.variableRuns].sort((a, b) => a.offset - b.offset)
    const payload: number[] = []
    for (const r of runs) {
      for (let i = r.offset; i < r.offset + r.length; i++) payload.push(bytes[i])
    }

    return [TEMPLATE_MARKER, v.version, v.region, ...writeUInt32BE(v.totalLength), ...payload]
  }

  return bytes.slice()
}

/**
 * Compress a recognised region-0x01 (R1-K1 locking script) template
 * instance. See `compressForRegion` for the shared behaviour and exactness
 * guarantees.
 */
export async function compressScript(bytes: number[]): Promise<number[]> {
  return compressForRegion(bytes, 0x01)
}

/**
 * Compress a recognised region-0x02 (R1-K1 sighash preimage `scriptCode`)
 * template instance — the piece that makes a SPENDING transaction huge,
 * since `R1K1Wallet.unlockR1` pushes the whole preimage into the unlocking
 * script. See `compressForRegion` for the shared behaviour and exactness
 * guarantees; `expandScript` reverses this the same way it reverses
 * `compressScript`, dispatching on the header's region byte.
 */
export async function compressScriptCode(bytes: number[]): Promise<number[]> {
  return compressForRegion(bytes, 0x02)
}

/**
 * Reverse of both `compressScript` (region 0x01) and `compressScriptCode`
 * (region 0x02) — one expander for every region, dispatching purely on the
 * header's region byte: detects the `0xff` header, resolves it against a
 * known template version, and rebuilds the exact original bytes by splicing
 * the header's payload back into a copy of that version's cached reference
 * template.
 *
 * Fails closed in every direction — never returns bytes that are merely
 * approximately right:
 * - fewer than `HEADER_LENGTH` bytes (can't even read a full header):
 *   throws `template-invalid`.
 * - a version/region this build's codec has no descriptor for (including a
 *   `bytes[0]` that isn't the `0xff` marker at all, since that decodes to no
 *   version this codec issued): throws `template-unknown`.
 * - a well-known version/region whose `originalLength` field disagrees with
 *   that version's actual template length, or whose payload is the wrong
 *   size for that version's variable runs: throws `template-invalid`.
 *
 * Awaits `describeVaultTemplate()` itself, both to resolve the header's
 * version/region and to guarantee the reference bytes it splices from are
 * cached in this process — the normal path can never hit
 * `matchesTemplate`-style "no cached reference" failures.
 */
export async function expandScript(bytes: number[]): Promise<number[]> {
  if (bytes.length < HEADER_LENGTH) {
    throw new VaultError(
      'template-invalid',
      `compressed-script header truncated: got ${bytes.length} bytes, need at least ${HEADER_LENGTH}`
    )
  }
  if (bytes[0] !== TEMPLATE_MARKER) {
    throw new VaultError(
      'template-unknown',
      `expected compressed-script marker 0x${TEMPLATE_MARKER.toString(16)}, got 0x${bytes[0].toString(16)}`
    )
  }

  const version = bytes[1]
  const region = bytes[2]
  const originalLength = readUInt32BE(bytes, 3)

  const descriptors = await describeVaultTemplate()
  const match = descriptors.find((d) => d.version === version && d.region === region)
  if (!match) {
    throw new VaultError('template-unknown', `no known template for version ${version} region ${region}`)
  }

  if (originalLength !== match.totalLength) {
    throw new VaultError(
      'template-invalid',
      `originalLength ${originalLength} disagrees with version ${version} region ${region}'s length ${match.totalLength}`
    )
  }

  const payload = bytes.slice(HEADER_LENGTH)
  const expectedPayloadLength = payloadLengthOf(match)
  if (payload.length !== expectedPayloadLength) {
    throw new VaultError(
      'template-invalid',
      `compressed payload is ${payload.length} bytes, expected ${expectedPayloadLength} for version ${version} region ${region}`
    )
  }

  const reference = referenceBytesByKey.get(versionKey(match.version, match.region))
  if (!reference) {
    // describeVaultTemplate() above just (re)populated this for every
    // descriptor it returned, and `match` came from that same array — this
    // is unreachable in practice. Fail closed rather than reconstruct from
    // nothing if it ever somehow isn't.
    throw new VaultError(
      'template-invalid',
      `no cached reference bytes for version ${version} region ${region}`
    )
  }

  const result = reference.slice()
  let payloadOffset = 0
  const runs = [...match.variableRuns].sort((a, b) => a.offset - b.offset)
  for (const r of runs) {
    for (let i = 0; i < r.length; i++) result[r.offset + i] = payload[payloadOffset + i]
    payloadOffset += r.length
  }

  // Last-line check before handing reconstructed bytes back: unreachable
  // today (result is a copy of `reference`, which is exactly `match.totalLength`
  // long, and `originalLength` was already checked against that same value
  // above) but the cheapest possible guard against ever returning a
  // wrong-length reconstruction if that invariant is ever violated by a
  // future change.
  if (result.length !== originalLength) {
    throw new VaultError(
      'template-invalid',
      `reconstructed ${result.length} bytes but originalLength was ${originalLength} for version ${version} region ${region}`
    )
  }

  return result
}
