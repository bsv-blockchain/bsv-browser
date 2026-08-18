# Plan: vault script template compression

**Spec:** docs/superpowers/specs/2026-08-18-vault-script-template-compression-design.md

## Global Constraints

- Marker byte is `0xff` (OP_INVALIDOPCODE). NEVER `OP_NOP7`/0xb6 — a compressed script must
  fail closed and be unspendable if it ever escapes.
- Header layout, exactly: `0xff` (1) ‖ version (1) ‖ region (1) ‖ originalLength (4, big-endian) ‖ payload.
- Region codes: `0x01` = R1K1 locking script, `0x02` = R1K1 preimage scriptCode.
- Region 0x01 payload: `commitment(20) ‖ k1PublicKeyHash(20)`. Region 0x02 payload: `k1PublicKeyHash(20)`.
- Verified constants, use verbatim: `R1K1_LOCK_LEN` = 959632; commitment at offsets 17..36;
  k1PublicKeyHash at offsets 959609..959628; preimage scriptCode = `lockingScript.subarray(60)`
  and is 959572 bytes.
- `expand(compress(x))` MUST equal `x` byte for byte. Never return approximate bytes; throw
  `VaultError('template-unknown')` when a version cannot be reconstructed.
- Recognition must be exact at every non-variable offset. A near-miss is returned unchanged.
- No changes to `StorageExpoSQLite` or to any broadcast/BEEF path in this plan.
- Existing tests must stay green: the suite is 990 tests / 83 suites at branch point.
- TypeScript strict; `npx tsc --noEmit` clean apart from the pre-existing `funding-app/` errors.

## Task 1: template descriptor and byte-exact recognition

Create `services/vault/templateCodec.ts`.

Export:
- `const TEMPLATE_MARKER = 0xff`
- `type TemplateRegion = 0x01 | 0x02`
- `interface TemplateVersion { version: number; region: TemplateRegion; totalLength: number;
  variableRuns: Array<{ offset: number; length: number }>; constantHash: string }`
- `async function describeVaultTemplate(): Promise<TemplateVersion[]>` — builds the current
  template once via `buildVaultLockingScript` with throwaway inputs and derives the descriptor
  from it, so the pinned constants are checked against the library rather than transcribed.
- `function matchesTemplate(bytes: number[], v: TemplateVersion): boolean` — true only when
  length matches AND every byte outside `variableRuns` equals the template's.

Recognition must not allocate a second copy of a ~960 KB script per call beyond what is
unavoidable; compare in place.

Tests in `__tests__/vault/templateCodec.test.ts`:
- a freshly built locking script matches the descriptor
- flipping ONE byte outside a variable run makes `matchesTemplate` false
- flipping a byte INSIDE a variable run keeps it true
- a P2PKH script (25 bytes) does not match
- descriptor `totalLength` is exactly 959632 and the two runs are `{17,20}` and `{959609,20}`

## Task 2: compress and expand, byte-exact

Extend `services/vault/templateCodec.ts`.

Export:
- `async function compressScript(bytes: number[]): Promise<number[]>` — returns the compressed
  form for a recognised region-0x01 script, else the input unchanged.
- `async function expandScript(bytes: number[]): Promise<number[]>` — detects the `0xff` header,
  validates `originalLength`, rebuilds the exact bytes; throws
  `VaultError('template-unknown')` for an unknown version or region, and
  `VaultError('template-invalid')` when `originalLength` disagrees with what the version
  reconstructs.
- `function isCompressed(bytes: number[]): boolean`

Add `'template-unknown'` to `VaultErrorCode` in `services/vault/types.ts` if absent.

Tests:
- round trip on a freshly built script, asserted with `toEqual` over the full arrays
- round trip on the REAL mainnet script fixture (see Task 4)
- `compressScript` on a non-matching script returns the input unchanged and does not allocate
  a header
- `expandScript` on an unknown version throws `template-unknown`
- `expandScript` on a truncated header throws rather than returning short bytes
- a compressed script's first byte is `0xff` and its length is 47 (7-byte header + 40 payload)

## Task 3: preimage scriptCode region

Extend the codec for region `0x02`.

- `compressScriptCode(bytes)` / handled by the same `expandScript` on the way back.
- The 0x02 descriptor derives from the 0x01 template by dropping the first 60 bytes, and the
  code must derive it that way rather than hardcoding 959572, so the two can never disagree.
- Assert the relationship explicitly: a test that builds a locking script, slices `subarray(60)`,
  and confirms the result is 959572 bytes and matches the 0x02 descriptor. If
  `@bsv/templates` ever changes, THIS test fails and names the reason.

Tests:
- `expand(compress(scriptCode))` byte-exact
- 0x02 payload is 20 bytes, not 40
- the derived 0x02 length equals `R1K1_LOCK_LEN - 60`

## Task 4: real-transaction fixture

Add `__tests__/vault/fixtures/r1k1-mainnet-lockingScript.hex.md` documenting provenance, and
commit the script bytes as a compressed fixture the tests can load.

The script is 959,632 bytes; do NOT commit 1.9 MB of hex. Instead commit the 40 variable bytes
plus a SHA-256 of the full script, and have the fixture helper rebuild the full script from the
current template and assert the SHA-256 matches. That proves the pinned template still
reproduces the real mainnet output without storing megabytes in git.

Real values, from the device database:
- txid `6c947ae3825b7a7ea1c61a27b64b39c5b8b424d460677addb896285222982697`, vout 0
- length 959632
- commitment (offsets 17..36) and k1PublicKeyHash (offsets 959609..959628) are to be read from
  the running fixture, not invented

Tests:
- SHA-256 of the rebuilt script matches the recorded digest
- the recorded digest is stable across two builds

## Task 5: docs

Add a short section to `docs/` (wherever vault docs live; if none, create
`docs/vault-script-compression.md`) covering: what the marker is, why `0xff` and not
`OP_NOP7`, the header layout, the two regions, and the rule that compressed bytes never leave
the device. Include the measured savings table from the spec.
