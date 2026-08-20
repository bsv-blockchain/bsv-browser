/**
 * The append-only template registry.
 *
 * The pinned fingerprint below is the point of this file. Compression writes a
 * version number into every record; expansion looks that number up here. So
 * removing, renumbering or editing an entry orphans every record already written
 * with it — in the database and in every backup chunk on the server — and the
 * failure would surface as `template-unknown` on someone's wallet rather than in
 * CI. Pinning the table means that mutation fails here instead.
 *
 * When you legitimately add a version: append the entry, update the pin in the
 * same commit, and leave every historical entry exactly as it was.
 */
import {
  CURRENT_TEMPLATE_VERSION,
  TEMPLATE_REGISTRY,
  currentEntry,
  entryForVersion,
  registryFingerprint
} from '@/services/vault/templateRegistry'
import { describeCurrentVaultTemplate, describeVaultTemplate } from '@/services/vault/templateCodec'

/**
 * Every field of every shipped entry, pinned.
 *
 * Append when a version is added. NEVER edit an existing segment: doing so is
 * the mutation this pin exists to catch.
 */
const PINNED_FINGERPRINT =
  '2|959632|60|17:20,959609:20|' +
  '41f6fcbbc46fe0eeb64a176fd66709694331b2327b1a63086105529e34a7493b|' +
  'f759656aadfcdbd531531c9806b8bce89f7ed4363c7d3f07578455fb1b96a990'

describe('template registry', () => {
  it('matches the pinned fingerprint of every shipped version', () => {
    expect(registryFingerprint()).toBe(PINNED_FINGERPRINT)
  })

  it('is append-only: versions ascend and none repeats', () => {
    const versions = TEMPLATE_REGISTRY.map(e => e.version)
    expect(versions).toEqual([...versions].sort((a, b) => a - b))
    expect(new Set(versions).size).toBe(versions.length)
  })

  it('writes with the newest version', () => {
    // Compression must never pick an older entry: a record written with an old
    // version would be expanded against old reference bytes, which is correct
    // only by luck.
    expect(CURRENT_TEMPLATE_VERSION).toBe(Math.max(...TEMPLATE_REGISTRY.map(e => e.version)))
    expect(currentEntry().version).toBe(CURRENT_TEMPLATE_VERSION)
  })

  it('resolves a registered version and refuses an unregistered one', () => {
    expect(entryForVersion(CURRENT_TEMPLATE_VERSION)).toBeDefined()
    expect(entryForVersion(999)).toBeUndefined()
    // v1's header carried no integrity check over its payload and no record of
    // it was ever written outside a test, so it is deliberately absent.
    expect(entryForVersion(1)).toBeUndefined()
  })

  it('has a plausible geometry for every entry', () => {
    for (const e of TEMPLATE_REGISTRY) {
      expect(e.rawLength).toBeGreaterThan(e.preimageScriptCodeOffset)
      expect(e.gzipBase64.length).toBeGreaterThan(0)
      expect(e.constantHash).toMatch(/^[0-9a-f]{64}$/)
      expect(e.constantHashScriptCode).toMatch(/^[0-9a-f]{64}$/)
      expect(e.variableRuns.length).toBeGreaterThan(0)
      for (const r of e.variableRuns) {
        expect(r.offset).toBeGreaterThanOrEqual(0)
        expect(r.offset + r.length).toBeLessThanOrEqual(e.rawLength)
      }
    }
  })
})

describe('codec descriptors follow the registry', () => {
  it('describes two regions per registered version', async () => {
    const all = await describeVaultTemplate()
    expect(all.length).toBe(TEMPLATE_REGISTRY.length * 2)
    for (const entry of TEMPLATE_REGISTRY) {
      expect(all.filter(v => v.version === entry.version).map(v => v.region).sort()).toEqual([0x01, 0x02])
    }
  })

  it('describes only the current version when asked for it', async () => {
    const current = await describeCurrentVaultTemplate()
    expect(current.map(v => v.version)).toEqual([CURRENT_TEMPLATE_VERSION, CURRENT_TEMPLATE_VERSION])
    expect(current.map(v => v.region)).toEqual([0x01, 0x02])
  })

  it('derives region 0x02 from region 0x01 rather than declaring it', async () => {
    const [region1, region2] = await describeCurrentVaultTemplate()
    const entry = currentEntry()
    expect(region2.totalLength).toBe(region1.totalLength - entry.preimageScriptCodeOffset)
    // Region 0x02's runs are region 0x01's runs that SURVIVE the cut, shifted by
    // it. The R1 commitment lives at offset 17, inside the 60 bytes unlockR1
    // drops, so it is not part of the scriptCode at all — only the
    // k1PublicKeyHash is. Asserting the survivors (rather than assuming both
    // runs shift) is what makes preimageScriptCodeOffset the single constant to
    // change if that cut ever moves.
    const survivors = region1.variableRuns
      .filter(r => r.offset >= entry.preimageScriptCodeOffset)
      .map(r => r.offset - entry.preimageScriptCodeOffset)
    expect(region2.variableRuns.map(r => r.offset)).toEqual(survivors)
    expect(survivors).toEqual([959549])
  })

  it('hands out fresh run objects, never the registry\'s own', async () => {
    const first = await describeCurrentVaultTemplate()
    first[0].variableRuns[0].offset = -1
    const second = await describeCurrentVaultTemplate()
    expect(second[0].variableRuns[0].offset).toBe(currentEntry().variableRuns[0].offset)
  })
})
