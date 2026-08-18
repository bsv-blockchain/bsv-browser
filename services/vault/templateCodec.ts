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
 * region-0x01 one, not built independently — see `ensureTemplateCache`.
 *
 * THE REFERENCE TEMPLATE IS VENDORED, NOT REBUILT. Earlier versions of this
 * module rebuilt the ~960 KB template from whatever `@bsv/templates` was
 * installed (diffing several throwaway builds to find the variable-byte
 * runs) and pinned only a SHA-256 of the result. That made a routine
 * dependency bump — package.json pins `@bsv/templates` at `^1.10.0`, so a
 * plain `npm i` can move it — potentially unable to reconstruct EVERY
 * previously-compressed record, forever, the moment the installed library's
 * output drifted from the pinned hash: `describeVaultTemplate` would throw
 * `template-unknown` even though the 40 bytes needed to reconstruct any given
 * record were sitting right there in its own compressed blob. Re-pinning the
 * hash to match the new library would "fix" the throw but silently
 * reconstruct OLD records against the NEW template — wrong bytes, no error.
 *
 * `services/vault/vaultTemplateArtifact.ts` now vendors the reference
 * template itself — gzip-compressed, base64-encoded, committed to this repo
 * — so reconstruction never depends on what `@bsv/templates` happens to be
 * installed. `PINNED_CONSTANT_HASH`/`PINNED_CONSTANT_HASH_SCRIPT_CODE` below
 * are still checked, but now as a CROSS-CHECK on the vendored asset (catching
 * a corrupted commit or a stale `PINNED_VARIABLE_RUNS`), not as the only
 * defence against a moving `@bsv/templates`. A separate test
 * (templateCodec.test.ts) still builds a script with whatever
 * `@bsv/templates` is CURRENTLY installed and checks it still matches the
 * vendored template — so an upstream change is still caught loudly, in CI —
 * it just can no longer make an already-stored record unreadable.
 *
 * SECURITY: nothing secret passes through this module. The vendored
 * reference template's variable-byte positions are zeroed, not populated
 * with real key material; `expandScript` always overwrites them with a
 * compressed record's own payload before returning.
 */
import { Hash, Utils } from '@bsv/sdk'
import { gunzipSync } from 'fflate'
import { R1K1_LOCK_LEN } from './r1k1'
import { VAULT_TEMPLATE_GZIP_BASE64, VAULT_TEMPLATE_RAW_LENGTH } from './vaultTemplateArtifact'
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
 * of everything else. Intentionally holds no script bytes itself — those live
 * in the module-level template cache (see `ensureTemplateCache`) — so this
 * stays a small, serialisable value.
 */
export interface TemplateVersion {
  version: number
  region: TemplateRegion
  totalLength: number
  variableRuns: { offset: number; length: number }[]
  constantHash: string
}

/**
 * The only wire-format version this codec has ever emitted or will ever
 * accept.
 *
 * Version 1 — the original 7-byte header (marker/version/region/
 * originalLength, no checksum) — never shipped: nothing in this codebase has
 * ever called `compressScript`/`compressScriptCode`/`expandScript` outside
 * tests (see docs/vault-script-compression.md's "nothing calls this codec
 * yet"), so no v1 record has ever been persisted anywhere, on any device.
 * There is therefore nothing to migrate. A v1-tagged header is simply an
 * unrecognised version to this build — `expandScript` rejects it with
 * `template-unknown` the exact same way it rejects version 250 or version
 * 999 (see the descriptor lookup in `expandScript`), because `describeVaultTemplate`
 * only ever returns version-2 descriptors. Do not read this as a
 * compatibility gap and do not add "v1 read support" — that would mean
 * teaching this codec to reconstruct a header shape with no integrity check
 * over its payload (see the checksum doc below for exactly why that shape
 * was replaced), for records that provably do not exist.
 */
const TEMPLATE_VERSION = 2

/** Number of bytes `R1K1Wallet.unlockR1` drops from the FRONT of the locking
 * script before committing the remainder into the sighash preimage's
 * `scriptCode`:
 *
 *   formatPreimage(tx, inputIndex, source, new Script([], lockingBytes.subarray(60), void 0, false))
 *
 * (verified against the `@bsv/templates` source — see R1K1Wallet.js's
 * `unlockR1`). This is the one load-bearing constant region 0x02 is built
 * from: `ensureTemplateCache` derives the ENTIRE region-0x02 reference by
 * slicing this many bytes off the front of the vendored region-0x01
 * reference, rather than hardcoding 959,572 (959,632 − 60) or re-deriving the
 * k1PublicKeyHash offset independently. If `@bsv/templates` ever changes how
 * many bytes `unlockR1` drops, this is the one constant to update —
 * everything else in region 0x02 (its length, its variable run, its pinned
 * constant hash) recomputes from it automatically. */
const PREIMAGE_SCRIPT_CODE_OFFSET = 60

/**
 * The region-0x01 (R1-K1 locking script) template's `constantHash` (see
 * `constantHashOf`): SHA-256 of the vendored reference template
 * (`vaultTemplateArtifact.ts`) with `PINNED_VARIABLE_RUNS` masked to zero
 * first — which is a no-op, since the vendored asset was built with those
 * exact positions already zeroed (see that file's doc comment), so this
 * reduces to SHA-256 of the asset as committed.
 *
 * That masking-then-hashing (rather than a bare `sha256(vendored)` call) is
 * what makes this a genuine CROSS-CHECK and not a tautology: this literal was
 * originally computed — before the template was vendored — from a REAL
 * per-instance sample built by `@bsv/templates`, with its (non-zero, genuinely
 * random) commitment/k1PublicKeyHash bytes masked out by `PINNED_VARIABLE_RUNS`.
 * If the vendored asset were corrupted, or `PINNED_VARIABLE_RUNS` no longer
 * named the positions the asset was actually zeroed at, masking would zero
 * the WRONG bytes (leaving some real template bytes in the hash, or leaving
 * some non-zero corruption unmasked) and the hash computed here would
 * disagree with this independently-sourced literal. `ensureTemplateCache`
 * throws `VaultError('template-invalid')` rather than proceeding if that ever
 * happens — this is a same-process, every-process check, not a CI-only one.
 *
 * Changing this literal is a deliberate act, not routine maintenance: it must
 * happen together with minting a NEW version number and regenerating
 * `vaultTemplateArtifact.ts` — never as a silent "make the assertion pass
 * again" edit.
 */
const PINNED_CONSTANT_HASH = '41f6fcbbc46fe0eeb64a176fd66709694331b2327b1a63086105529e34a7493b'

/**
 * The region-0x01 template's variable-run geometry — the plan's Global
 * Constraints (R1 commitment at offset 17, length 20; k1PublicKeyHash at
 * offset 959609, length 20) — and, since the template is now vendored rather
 * than diffed from throwaway samples on every process start, the ONLY source
 * of this geometry at runtime. `ensureTemplateCache` cross-checks it against
 * the vendored bytes via `PINNED_CONSTANT_HASH` above (masking the wrong
 * positions would produce the wrong hash), rather than merely trusting this
 * literal — see that constant's doc comment for exactly how.
 */
const PINNED_VARIABLE_RUNS: { offset: number; length: number }[] = [
  { offset: 17, length: 20 },
  { offset: 959609, length: 20 }
]

/**
 * The region-0x02 (preimage scriptCode) template's `constantHash`, pinned the
 * same way as `PINNED_CONSTANT_HASH` above and cross-checked the same way:
 * SHA-256 of the vendored region-0x02 reference (region-0x01's vendored bytes
 * sliced at `PREIMAGE_SCRIPT_CODE_OFFSET`) with its variable run masked —
 * again a no-op against the vendored asset, but a genuine check against this
 * independently-sourced literal.
 *
 * This does NOT give independent coverage against a corrupted vendored asset
 * the way `PINNED_CONSTANT_HASH` does: region 0x02's bytes are a slice of the
 * SAME vendored buffer region 0x01's check above already verified, and that
 * check always runs first in `ensureTemplateCache` and throws before this one
 * is ever reached. What this guard actually catches is a maintainer
 * hand-editing `PREIMAGE_SCRIPT_CODE_OFFSET` itself to the wrong value —
 * without updating this literal to match — which would shift which slice of
 * the already-verified bytes becomes "scriptCode" and change this hash
 * without touching region 0x01's. Changing this literal (together with
 * `PREIMAGE_SCRIPT_CODE_OFFSET`, deliberately, as one act) is tied to minting
 * a new version, never a silent "make the assertion pass again" edit.
 */
const PINNED_CONSTANT_HASH_SCRIPT_CODE = 'f759656aadfcdbd531531c9806b8bce89f7ed4363c7d3f07578455fb1b96a990'

/** Shift a set of runs by subtracting `offset` from each, dropping any run
 * that falls entirely below zero and clipping one that straddles it — the
 * same transformation `region1.subarray(offset)` applies to the bytes those
 * runs describe. Used to derive the region-0x02 pinned run geometry from
 * `PINNED_VARIABLE_RUNS` above, the same way `ensureTemplateCache` derives the
 * region-0x02 REFERENCE BYTES from the region-0x01 vendored bytes: never
 * built or hardcoded independently, so the two can never drift out of sync. */
function shiftRuns(
  runs: { offset: number; length: number }[],
  offset: number
): { offset: number; length: number }[] {
  const shifted: { offset: number; length: number }[] = []
  for (const r of runs) {
    const start = r.offset - offset
    const end = r.offset + r.length - offset
    if (end <= 0) continue
    const clippedStart = Math.max(start, 0)
    shifted.push({ offset: clippedStart, length: end - clippedStart })
  }
  return shifted
}

/** SHA-256 (hex) of `bytes` with every variable run zeroed out first, so the
 * hash fingerprints only the constant template and is identical regardless of
 * which real commitment/hash values occupy the variable runs. Copies `bytes`
 * first (`Uint8Array.slice`, not `subarray`) so masking never mutates a
 * shared reference. */
function constantHashOf(bytes: Uint8Array, runs: { offset: number; length: number }[]): string {
  const masked = bytes.slice()
  for (const r of runs) {
    for (let i = r.offset; i < r.offset + r.length; i++) masked[i] = 0
  }
  return Utils.toHex(Hash.sha256(masked))
}

/**
 * The in-memory reference-template cache: the vendored template, inflated
 * once and held as a `Uint8Array` until `releaseTemplateCache` clears it.
 *
 * `region2` is a `subarray` VIEW over `region1`'s buffer (offset
 * `PREIMAGE_SCRIPT_CODE_OFFSET`), not a copy — it costs nothing beyond a
 * pointer/offset/length triple. Holding both regions as `Uint8Array` rather
 * than `number[]` is itself the bulk of the memory fix this cache exists for:
 * a `number[]` of ~960,000 JS numbers costs roughly 8 bytes per element
 * (~7.5 MB) even though every element fits in a single byte; a `Uint8Array`
 * of the same length costs 1 byte per element (~960 KB) — and the previous
 * implementation held TWO such `number[]` copies (one per region) totalling
 * 15.5–16.4 MB retained for the lifetime of the process, more than the 7.2 MB
 * database this feature exists to shrink.
 */
interface TemplateCacheEntry {
  region1: Uint8Array
  region2: Uint8Array
}

let templateCache: TemplateCacheEntry | undefined

/**
 * Populate (or reuse) `templateCache`: base64-decode and gunzip the vendored
 * asset, verify its length and both regions' masked-constant hashes against
 * the pinned literals above, and cache the inflated bytes for reuse across
 * calls in this process — until `releaseTemplateCache` clears it, at which
 * point the NEXT call re-inflates and re-verifies from scratch. Inflating an
 * 8 KB gzip payload into ~960 KB, plus two SHA-256 passes over that much
 * data, is comfortably sub-frame-budget — nowhere near the 114–200 ms the old
 * sample-diffing implementation cost per cold call (four full `@bsv/templates`
 * builds plus hashing), and nothing here calls `@bsv/templates` at all.
 *
 * Throws `VaultError('template-invalid')` if the vendored asset disagrees
 * with what this codec was verified against in ANY way — wrong inflated
 * length, or a masked hash that disagrees with `PINNED_CONSTANT_HASH`/
 * `PINNED_CONSTANT_HASH_SCRIPT_CODE`. This indicates a corrupted or
 * mismatched build of THIS repo (not a moving `@bsv/templates`, which this
 * function never consults), so there is no separate "unknown template"
 * classification here the way there is for an unrecognised wire-format
 * version in `expandScript` — a broken vendored asset is always a build
 * problem, never a legitimately-different-but-unsupported one.
 */
function ensureTemplateCache(): TemplateCacheEntry {
  if (templateCache) return templateCache

  const gzip = Uint8Array.from(Utils.toArray(VAULT_TEMPLATE_GZIP_BASE64, 'base64'))
  const region1 = gunzipSync(gzip)

  if (region1.length !== VAULT_TEMPLATE_RAW_LENGTH || region1.length !== R1K1_LOCK_LEN) {
    throw new VaultError(
      'template-invalid',
      `vendored template inflated to ${region1.length} bytes, expected ${VAULT_TEMPLATE_RAW_LENGTH} ` +
        `(R1K1_LOCK_LEN ${R1K1_LOCK_LEN}) — the committed asset is corrupt or was built for a different version`
    )
  }

  const constantHash = constantHashOf(region1, PINNED_VARIABLE_RUNS)
  if (constantHash !== PINNED_CONSTANT_HASH) {
    throw new VaultError(
      'template-invalid',
      `vendored template's masked constantHash ${constantHash} disagrees with the pinned ${PINNED_CONSTANT_HASH} ` +
        '— the committed asset is corrupt, or PINNED_VARIABLE_RUNS no longer names the positions it was zeroed at'
    )
  }

  const region2 = region1.subarray(PREIMAGE_SCRIPT_CODE_OFFSET)
  const scriptCodeRuns = shiftRuns(PINNED_VARIABLE_RUNS, PREIMAGE_SCRIPT_CODE_OFFSET)
  const scriptCodeConstantHash = constantHashOf(region2, scriptCodeRuns)
  if (scriptCodeConstantHash !== PINNED_CONSTANT_HASH_SCRIPT_CODE) {
    throw new VaultError(
      'template-invalid',
      `vendored scriptCode's masked constantHash ${scriptCodeConstantHash} disagrees with the pinned ` +
        `${PINNED_CONSTANT_HASH_SCRIPT_CODE}`
    )
  }

  templateCache = { region1, region2 }
  return templateCache
}

/**
 * Release the in-memory reference-template cache populated by
 * `ensureTemplateCache` (called, in turn, by `describeVaultTemplate` and thus
 * transitively by `compressScript`/`compressScriptCode`/`expandScript`).
 * Frees the ~960 KB inflated `Uint8Array` — `region2` is a view over the same
 * buffer, so this is the entire cost — held since the first call in this
 * process.
 *
 * This is a memory-management knob only: every exported function in this
 * module keeps working correctly afterwards, transparently re-inflating and
 * re-verifying the vendored asset from `vaultTemplateArtifact.ts` on the next
 * `describeVaultTemplate` call. Nothing is discarded that isn't trivially
 * reconstructible from bytes already committed to this repo.
 *
 * A caller processing a BATCH of vault records — compressing every
 * `lockingScript` in a backup pass, or expanding every stored record on
 * restore — should hold the cache open for the WHOLE batch and call this
 * once at the end, not per record. Calling it between records would turn one
 * inflate-and-verify pass into one per record for no benefit: the cache
 * costs under 1 MB to hold, and the whole point of a per-batch release is to
 * give that megabyte back when there's a long idle stretch until the next
 * batch, not to avoid holding it for the (short) duration of one.
 */
export function releaseTemplateCache(): void {
  templateCache = undefined
}

/** Sum of every variable run's length — the payload size a version's header
 * must be followed by. */
function payloadLengthOf(v: TemplateVersion): number {
  return v.variableRuns.reduce((sum, r) => sum + r.length, 0)
}

/**
 * Look up the cached reference bytes for `version`/`region`, or `undefined`
 * if that exact version/region isn't the one currently cached — either
 * because `ensureTemplateCache` was never called in this process (no
 * `describeVaultTemplate` await yet, or a `releaseTemplateCache` since the
 * last one), or because `version` names something other than this codec's
 * one supported version.
 */
function referenceBytesFor(version: number, region: TemplateRegion): Uint8Array | undefined {
  if (version !== TEMPLATE_VERSION || !templateCache) return undefined
  if (region === 0x01) return templateCache.region1
  if (region === 0x02) return templateCache.region2
  return undefined
}

/**
 * Return this codec's only supported template version's descriptor for both
 * regions (0x01 locking script, 0x02 preimage scriptCode), populating (or
 * reusing) the in-memory reference-template cache as a side effect — see
 * `ensureTemplateCache`.
 *
 * The descriptors themselves are tiny (a couple of numbers, two short run
 * lists, two hash strings) and are rebuilt fresh on every call rather than
 * memoized separately from the byte cache — so a call shortly after
 * `releaseTemplateCache()` correctly reflects a freshly re-verified cache
 * rather than stale metadata from before the release. Async for API
 * stability (a caller can keep `await`ing this) even though, unlike the old
 * sample-diffing implementation, nothing here actually awaits anything.
 */
export async function describeVaultTemplate(): Promise<TemplateVersion[]> {
  const cache = ensureTemplateCache()

  const region1: TemplateVersion = {
    version: TEMPLATE_VERSION,
    region: 0x01,
    totalLength: cache.region1.length,
    variableRuns: PINNED_VARIABLE_RUNS,
    constantHash: PINNED_CONSTANT_HASH
  }
  const region2: TemplateVersion = {
    version: TEMPLATE_VERSION,
    region: 0x02,
    totalLength: cache.region2.length,
    variableRuns: shiftRuns(PINNED_VARIABLE_RUNS, PREIMAGE_SCRIPT_CODE_OFFSET),
    constantHash: PINNED_CONSTANT_HASH_SCRIPT_CODE
  }
  return [region1, region2]
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
 * this process has no cached reference for `v.version`/`v.region` right now
 * (never populated, or released since — see `referenceBytesFor`).
 * `TemplateVersion` is a small, serialisable value, so nothing stops a caller
 * from persisting one and rehydrating it in a later process, or calling this
 * after `releaseTemplateCache()`; without this check, doing so would make
 * every real vault script silently and permanently "not match" — no
 * exception, no log — which is a compression path quietly going dark rather
 * than a corruption risk. A cache miss must never come back looking like an
 * ordinary non-match.
 */
export function matchesTemplate(bytes: number[], v: TemplateVersion): boolean {
  const reference = referenceBytesFor(v.version, v.region)
  if (!reference) {
    throw new VaultError(
      'template-invalid',
      `matchesTemplate has no cached reference for version ${v.version} region ${v.region} in this process — ` +
        'describeVaultTemplate() must be awaited (and the cache must not have been released since) before ' +
        'recognition is attempted'
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
 * On-wire (and on-disk, for backup) layout of a compressed script, exactly:
 *
 *   0xff (1) ‖ version (1) ‖ region (1) ‖ originalLength (4, big-endian) ‖
 *     checksum (4) ‖ payload
 *
 * 0xff is OP_INVALIDOPCODE: not a defined opcode anywhere, so a compressed
 * blob that somehow escaped onto the wire in place of a real locking script
 * would fail script evaluation outright rather than being interpreted as
 * some other (spendable, or worse, always-true) script. OP_NOP7 (0xb6) was
 * explicitly rejected for this role: it IS a valid, defined no-op opcode, so
 * a compressed script left in place could still pass evaluation. Note that
 * this guarantee is about SPENDING, not mining — a compressed script can
 * still be mined into a real on-chain output (output scripts are never
 * executed at creation), which is why `compressForRegion` below refuses
 * (rather than passes through) bytes that already look marker-led but match
 * no known template. See the plan's Global Constraints for the 0xff
 * decision.
 *
 * `checksum` is the first 4 bytes of SHA-256 of the ORIGINAL (uncompressed)
 * bytes — added in version 2. Version 1 shipped without it: the 7-byte
 * header (marker/version/region/originalLength) was fully cross-checked, but
 * the 40 payload bytes carried no integrity check of their own, so a single
 * bit flip in a stored/transmitted compressed blob would silently splice a
 * WRONG (but structurally perfect — right length, plausible-looking
 * commitment/k1PublicKeyHash bytes) reconstruction: wrong txid, a merkle
 * proof that no longer verifies, and an unrecoverable deposit record, with
 * `expandScript` never noticing because nothing it checked could see a
 * corruption confined to the payload. `checksum` covers the RECONSTRUCTED
 * bytes, not just the payload, so corruption anywhere — including in the
 * ~960 KB of constant template the payload doesn't even carry — is caught.
 * `expandScript` verifies it only AFTER splicing the payload into the
 * reference template, comparing against the FULL reconstructed result: it
 * must reconstruct, hash, compare, and only then return, never the reverse.
 * See `TEMPLATE_VERSION`'s doc comment above for why there is no v1 read
 * path to preserve.
 *
 * The payload is just the bytes of each variable run, concatenated in
 * ascending offset order — for region 0x01 that is commitment(20) ‖
 * k1PublicKeyHash(20), 40 bytes, making a compressed locking script exactly
 * 11 + 40 = 51 bytes; for region 0x02 (the preimage scriptCode) that is
 * k1PublicKeyHash(20) alone — the commitment run doesn't survive the
 * scriptCode's leading 60-byte cut, see `ensureTemplateCache` — making a
 * compressed scriptCode exactly 11 + 20 = 31 bytes. Nothing here hardcodes
 * either shape though: both directions walk `TemplateVersion.variableRuns`,
 * so a version with different/more runs is handled by the same code without
 * change.
 * ---------------------------------------------------------------------------
 */

const HEADER_LENGTH = 11 // marker(1) + version(1) + region(1) + originalLength(4) + checksum(4)

function writeUInt32BE(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
}

function readUInt32BE(bytes: number[], offset: number): number {
  return (
    ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
  )
}

/** First 4 bytes of SHA-256 of `bytes` — the v2 header's integrity check,
 * computed over the FULL original/reconstructed bytes (see the wire-format
 * doc above), never over the payload alone. */
function checksumOf(bytes: number[] | Uint8Array): number[] {
  return Hash.sha256(bytes).slice(0, 4)
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
 * Compress a recognised template instance of `region` down to its 11-byte
 * header plus the concatenated variable-run bytes. Bytes that don't match any
 * known version of `region` — including a merely near-miss, per
 * `matchesTemplate`'s exactness — are returned unchanged (a fresh copy, not
 * the header format): this must never turn unrecognised bytes into something
 * that looks compressed.
 *
 * The one exception: bytes that already begin with `TEMPLATE_MARKER` (0xff)
 * but don't match any known version are refused with a thrown
 * `VaultError('template-invalid')` rather than passed through. Passing them
 * through unchanged would make `isCompressed` report `true` for bytes that
 * are not a legitimately compressed header — and a storage layer following
 * this module's own documented `isCompressed(b) ? expandScript(b) : b`
 * pattern would then hand them to `expandScript`, which resolves a
 * marker-led header purely from its version/region/length fields and splices
 * the trailing bytes into the cached reference template regardless of
 * whether they were ever produced by `compressForRegion`. Since output
 * scripts are not executed at creation, a counterparty could mint a real
 * on-chain output whose locking script is exactly such attacker-chosen bytes;
 * silently "compressing" (i.e. passing through) that input would let it
 * later inflate into a fabricated ~960 KB script that disagrees with the
 * chain. Throwing here is what keeps `expand(compress(x)) === x` true for
 * every constructible `x`, not just for legitimate template instances.
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

    const checksum = checksumOf(bytes)
    return [TEMPLATE_MARKER, v.version, v.region, ...writeUInt32BE(v.totalLength), ...checksum, ...payload]
  }

  if (bytes.length > 0 && bytes[0] === TEMPLATE_MARKER) {
    throw new VaultError(
      'template-invalid',
      `cannot compress region ${region} bytes that already begin with the compressed-script ` +
        `marker 0x${TEMPLATE_MARKER.toString(16)} but match no known template version — passing ` +
        'them through unchanged would make isCompressed() report a false positive for bytes that ' +
        'are not actually a compressed header'
    )
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
 * known template version, rebuilds the exact original bytes by splicing the
 * header's payload back into a copy of that version's cached reference
 * template, and ONLY THEN verifies the header's checksum against the fully
 * reconstructed result.
 *
 * Fails closed in every direction — never returns bytes that are merely
 * approximately right:
 * - `bytes[0]` isn't the `0xff` marker at all (including an empty array,
 *   which has no byte 0 to be the marker): decodes to no version this codec
 *   ever issued, so this is simply not a compressed script — throws
 *   `template-unknown`. Checked FIRST, before the length check below, so a
 *   short array that was never meant to be a compressed header in the first
 *   place is diagnosed as "unrecognised", not misreported as a truncated
 *   header of a real one.
 * - marker-led but fewer than `HEADER_LENGTH` bytes (can't even read a full
 *   header): throws `template-invalid`.
 * - a marker-led version/region this build's codec has no descriptor for
 *   (including version 1 — see `TEMPLATE_VERSION`'s doc comment for why that
 *   is correct, not a migration gap): throws `template-unknown`.
 * - a well-known version/region whose `originalLength` field disagrees with
 *   that version's actual template length, or whose payload is the wrong
 *   size for that version's variable runs: throws `template-invalid`.
 * - a well-known version/region whose reconstructed bytes hash to something
 *   other than the header's `checksum` field: throws `template-invalid`. This
 *   is the check version 1 never had — see the wire-format doc above.
 *
 * Awaits `describeVaultTemplate()` itself, both to resolve the header's
 * version/region and to guarantee the reference bytes it splices from are
 * cached in this process — the normal path can never hit
 * `matchesTemplate`-style "no cached reference" failures.
 */
export async function expandScript(bytes: number[]): Promise<number[]> {
  if (bytes.length === 0 || bytes[0] !== TEMPLATE_MARKER) {
    throw new VaultError(
      'template-unknown',
      `expected compressed-script marker 0x${TEMPLATE_MARKER.toString(16)}, got ` +
        (bytes.length === 0 ? 'an empty array' : `0x${bytes[0].toString(16)}`)
    )
  }
  if (bytes.length < HEADER_LENGTH) {
    throw new VaultError(
      'template-invalid',
      `compressed-script header truncated: got ${bytes.length} bytes, need at least ${HEADER_LENGTH}`
    )
  }

  const version = bytes[1]
  const region = bytes[2]
  const originalLength = readUInt32BE(bytes, 3)
  const checksum = bytes.slice(7, HEADER_LENGTH)

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

  const reference = referenceBytesFor(match.version, match.region)
  if (!reference) {
    // describeVaultTemplate() above just (re)populated the cache `match` was
    // built from — this is unreachable in practice. Fail closed rather than
    // reconstruct from nothing if it ever somehow isn't.
    throw new VaultError(
      'template-invalid',
      `no cached reference bytes for version ${version} region ${region}`
    )
  }

  const result = Array.from(reference)
  let payloadOffset = 0
  const runs = [...match.variableRuns].sort((a, b) => a.offset - b.offset)
  for (const r of runs) {
    for (let i = 0; i < r.length; i++) result[r.offset + i] = payload[payloadOffset + i]
    payloadOffset += r.length
  }

  // Last-line check before the checksum: unreachable today (result is a copy
  // of `reference`, which is exactly `match.totalLength` long, and
  // `originalLength` was already checked against that same value above) but
  // the cheapest possible guard against ever hashing/returning a wrong-length
  // reconstruction if that invariant is ever violated by a future change.
  if (result.length !== originalLength) {
    throw new VaultError(
      'template-invalid',
      `reconstructed ${result.length} bytes but originalLength was ${originalLength} for version ${version} region ${region}`
    )
  }

  // Verify the checksum AFTER full reconstruction, against the reconstructed
  // bytes — never the payload alone, never the header — so corruption
  // anywhere (including in the constant bytes the payload doesn't even
  // carry) is caught before anything is returned. Reconstruct, hash,
  // compare, THEN return — never the other order.
  const actualChecksum = checksumOf(result)
  if (Utils.toHex(actualChecksum) !== Utils.toHex(checksum)) {
    throw new VaultError(
      'template-invalid',
      `checksum mismatch for version ${version} region ${region}: header says ${Utils.toHex(checksum)}, ` +
        `reconstructed bytes hash to ${Utils.toHex(actualChecksum)} — refusing to return a possibly-corrupt reconstruction`
    )
  }

  return result
}
