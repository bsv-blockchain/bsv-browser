/**
 * The registry's geometry, cross-checked against @bsv/templates.
 *
 * WHY BOTH EXIST. Upstream is the AUTHORITY for the R1-K1 layout: it declares
 * the compiled template length, the k1 slot offset, the artifact digest and the
 * artifact itself. Duplicating those numbers in our registry would be pointless
 * if we simply read them at runtime — but reading them at runtime is exactly
 * what we must not do, because @bsv/templates is a caret dependency and stored
 * records outlive it. If a `^1.10.0` minor bump moved the layout, a codec that
 * derived its geometry from whatever version happened to be installed would
 * silently start reconstructing the WRONG bytes for records already written.
 *
 * So the registry pins, and this test derives-and-compares. Upstream changes the
 * layout, this fails, and the fix is to mint a NEW registry version rather than
 * to edit the existing one — which is precisely the decision that has to be
 * made by a human rather than by a version range.
 *
 * WHAT IS NOT COVERED. `R1_K1_R1_SLOT_OFFSET` is declared in the upstream
 * artifact source but absent from its export list, so the R1 commitment's run
 * offset (17) cannot be derived here. It stays guarded by the registry's own
 * `constantHash`, which masks that exact window and is verified against the
 * vendored bytes on every process start.
 */
import { R1K1Wallet } from '@bsv/templates'
// The package maps this subpath through its `exports` map, which neither
// eslint-plugin-import's resolver nor this project's classic tsconfig resolution
// reads. It resolves at runtime, and types/bsv-templates-artifact.d.ts supplies
// the types.
import {
  R1_K1_K1_SLOT_OFFSET,
  R1_K1_TEMPLATE_BYTE_LENGTH,
  R1_K1_TEMPLATE_SHA256
  // eslint-disable-next-line import/no-unresolved
} from '@bsv/templates/R1K1Wallet.artifact.ts'
import { currentEntry } from '@/services/vault/templateRegistry'

/** Bytes each 1-byte constructor slot becomes once baked (a 21-byte push). */
const slotExpansion = (): number =>
  (R1K1Wallet.lockingScriptByteLength - R1K1Wallet.compiledTemplateByteLength) / 2

describe('registry geometry against @bsv/templates', () => {
  const entry = currentEntry()

  it('agrees with upstream on the baked locking-script length', () => {
    expect(entry.rawLength).toBe(R1K1Wallet.lockingScriptByteLength)
  })

  it('derives the baked length from upstream template plus two expanded slots', () => {
    // 959,592 + 2 x 20 = 959,632. If upstream ever recompiles the template to a
    // different size, this is the first thing that fails.
    expect(R1K1Wallet.compiledTemplateByteLength).toBe(R1_K1_TEMPLATE_BYTE_LENGTH)
    expect(slotExpansion()).toBe(20)
    expect(R1_K1_TEMPLATE_BYTE_LENGTH + 2 * slotExpansion()).toBe(entry.rawLength)
  })

  it('derives the k1PublicKeyHash run offset from upstream slot offset', () => {
    // Upstream's slot offset is into the UNBAKED template and names the slot
    // byte; ours is into the baked script and names where the 20 data bytes
    // start. The difference is one prior slot's expansion plus the push opcode.
    const derived = R1_K1_K1_SLOT_OFFSET + slotExpansion() + 1
    const k1Run = entry.variableRuns[entry.variableRuns.length - 1]
    expect(derived).toBe(k1Run.offset)
    expect(k1Run.length).toBe(slotExpansion())
  })

  it('pins the upstream artifact digest, so an upstream artifact swap is visible', () => {
    // Not compared against our own vendored artifact — ours is BAKED and this
    // digest is of the unbaked template — but pinned so that upstream shipping a
    // different template cannot pass unnoticed.
    expect(R1_K1_TEMPLATE_SHA256).toBe('d5a824bfb1d3ea48ca4e9f70ba987f545d4d171aad689c1264b7339fa6928f2b')
  })

  it('keeps the scriptCode cut in step with what unlockR1 actually drops', () => {
    // R1K1Wallet.unlockR1 commits `lockingBytes.subarray(60)` as the preimage's
    // scriptCode. That 60 is a literal in upstream's source and is not exported,
    // so the registry pins it — and region 0x02's own constantHash, which is
    // computed from the slice this offset produces, is what catches a change.
    expect(entry.preimageScriptCodeOffset).toBe(60)
    expect(entry.rawLength - entry.preimageScriptCodeOffset).toBe(959_572)
  })
})
