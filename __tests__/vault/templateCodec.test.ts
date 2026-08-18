import { Hash, P2PKH, PrivateKey, Utils } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'
import {
  buildMainnetFixtureScript,
  MAINNET_K1_PUBLIC_KEY_HASH_HEX,
  MAINNET_SCRIPT_CODE_LENGTH,
  MAINNET_SCRIPT_CODE_SHA256
} from './fixtures/r1k1MainnetFixture'
import { R1K1_LOCK_LEN, buildVaultLockingScript } from '@/services/vault/r1k1'
import {
  compressScript,
  compressScriptCode,
  describeVaultTemplate,
  expandScript,
  isCompressed,
  matchesTemplate,
  TEMPLATE_MARKER,
  TemplateVersion
} from '@/services/vault/templateCodec'

function fixture() {
  const r1PublicKey = Utils.toHex(Array.from(p256.getPublicKey(p256.utils.randomSecretKey(), true)))
  const salt = Utils.toHex(Array.from(crypto.getRandomValues(new Uint8Array(32))))
  const k1PublicKeyHash = Hash.hash160(PrivateKey.fromRandom().toPublicKey().encode(true) as number[])
  return { r1PublicKey, salt, k1PublicKeyHash }
}

describe('vault template codec: descriptor + exact recognition', () => {
  // Building the ~960 KB template (several times over, inside
  // describeVaultTemplate's diffing) is not free — build it once for the
  // whole suite rather than per test.
  let descriptor: TemplateVersion
  let scriptBytes: number[]

  beforeAll(async () => {
    ;[descriptor] = await describeVaultTemplate()
    scriptBytes = (await buildVaultLockingScript(fixture())).toBinary()
  })

  it('matches a freshly built locking script', () => {
    expect(matchesTemplate(scriptBytes, descriptor)).toBe(true)
  })

  it('derives totalLength 959632 and the two pinned variable runs, from the library', () => {
    // These are the plan's pinned, verbatim constants (Global Constraints:
    // R1K1_LOCK_LEN = 959632; commitment at offsets 17..36; k1PublicKeyHash
    // at offsets 959609..959628). describeVaultTemplate derives them by
    // diffing built scripts rather than reading them from here — this
    // assertion is what would fail if @bsv/templates ever changed the
    // layout, instead of the change silently being adopted.
    expect(descriptor.totalLength).toBe(959632)
    expect(descriptor.totalLength).toBe(R1K1_LOCK_LEN)
    expect(descriptor.variableRuns).toEqual([
      { offset: 17, length: 20 },
      { offset: 959609, length: 20 }
    ])
    expect(descriptor.constantHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('constantHash matches the pinned reference recorded for version 1', () => {
    // Pinned literal, computed once from the CURRENT @bsv/templates
    // R1K1Wallet output — mirrors PINNED_CONSTANT_HASH_V1 in
    // templateCodec.ts (kept as a separately-recorded literal here, not an
    // import, so this test can't be made to pass by silently changing the
    // implementation's pinned value). totalLength/variableRuns alone cannot
    // catch an @bsv/templates upgrade that keeps 959,632 bytes but alters a
    // constant byte in between — this is the assertion that closes that
    // gap. describeVaultTemplate() itself would already have thrown
    // 'template-unknown' by the time this runs if the live template ever
    // disagreed with this value (see the next describe block for that
    // throwing behaviour); this test additionally pins the exact expected
    // value so a change shows up here too, by name.
    expect(descriptor.constantHash).toBe('41f6fcbbc46fe0eeb64a176fd66709694331b2327b1a63086105529e34a7493b')
  })

  it('rejects a script with one byte flipped outside a variable run', () => {
    const mutated = scriptBytes.slice()
    mutated[0] ^= 0xff // well outside both runs, and XOR-0xff always flips
    expect(matchesTemplate(mutated, descriptor)).toBe(false)
  })

  it('still matches when a byte inside a variable run is flipped', () => {
    const mutatedCommitment = scriptBytes.slice()
    mutatedCommitment[17] ^= 0xff // first byte of the R1 commitment run
    expect(matchesTemplate(mutatedCommitment, descriptor)).toBe(true)

    const mutatedK1Hash = scriptBytes.slice()
    mutatedK1Hash[959609] ^= 0xff // first byte of the k1PublicKeyHash run
    expect(matchesTemplate(mutatedK1Hash, descriptor)).toBe(true)

    const mutatedLastByte = scriptBytes.slice()
    mutatedLastByte[959628] ^= 0xff // last byte of the k1PublicKeyHash run
    expect(matchesTemplate(mutatedLastByte, descriptor)).toBe(true)
  })

  it('does not match a 25-byte P2PKH script', () => {
    const pkh = Hash.hash160(PrivateKey.fromRandom().toPublicKey().encode(true) as number[])
    const p2pkh = new P2PKH().lock(pkh).toBinary()

    expect(p2pkh.length).toBe(25)
    expect(matchesTemplate(p2pkh, descriptor)).toBe(false)
  })

  it('throws rather than silently answering false for a descriptor this process never cached', () => {
    // Simulates the real footgun: TemplateVersion is documented as "small,
    // serialisable", so nothing stops a caller from persisting one and
    // rehydrating it in a later process that never awaited
    // describeVaultTemplate() for that exact version/region. A version
    // number this process has no cached reference bytes for reproduces that
    // cold-call condition without needing to reset module state.
    const neverCached: TemplateVersion = { ...descriptor, version: 999 }

    let caught: unknown
    try {
      matchesTemplate(scriptBytes, neverCached)
    } catch (e) {
      caught = e
    }
    expect(caught).toMatchObject({ code: 'template-invalid' })
  })
})

describe('vault template codec: compress + expand', () => {
  // Another ~960 KB build, but only once for this whole describe block (not
  // per test) — same pattern as the descriptor/recognition suite above.
  let scriptBytes: number[]

  beforeAll(async () => {
    scriptBytes = (await buildVaultLockingScript(fixture())).toBinary()
  })

  it('round-trips a freshly built locking script byte-for-byte', async () => {
    const compressed = await compressScript(scriptBytes)
    const expanded = await expandScript(compressed)
    expect(expanded).toEqual(scriptBytes)
  })

  it('round-trips the REAL mined mainnet locking script byte-for-byte', async () => {
    // The fixture holds the actual commitment/k1PublicKeyHash mined on-chain
    // for txid 6c947ae3..., vout 0 — this proves compress+expand reproduces a
    // real, already-mined output exactly, not just a freshly-built one.
    const mainnetScript = await buildMainnetFixtureScript()
    const compressed = await compressScript(mainnetScript)
    const expanded = await expandScript(compressed)
    expect(expanded).toEqual(mainnetScript)
  })

  it('produces a 47-byte compressed script starting with the 0xff marker', async () => {
    const compressed = await compressScript(scriptBytes)
    expect(compressed[0]).toBe(TEMPLATE_MARKER)
    expect(compressed[0]).toBe(0xff)
    expect(compressed.length).toBe(47) // 7-byte header + 40-byte payload (commitment 20 + k1PublicKeyHash 20)
    expect(isCompressed(compressed)).toBe(true)
  })

  it('leaves a non-matching script unchanged and does not allocate a header', async () => {
    const pkh = Hash.hash160(PrivateKey.fromRandom().toPublicKey().encode(true) as number[])
    const p2pkh = new P2PKH().lock(pkh).toBinary()

    const compressed = await compressScript(p2pkh)

    expect(compressed).toEqual(p2pkh)
    expect(compressed.length).toBe(25)
    expect(compressed[0]).not.toBe(TEMPLATE_MARKER)
    expect(isCompressed(compressed)).toBe(false)
  })

  it('leaves a same-length near-miss script unchanged — rejected by the byte-compare, not the length check', async () => {
    // scriptBytes is a real 959632-byte vault script, so this exits
    // matchesTemplate's LENGTH check the same way a real script does; only
    // the subsequent byte-by-byte compare against the cached reference can
    // reject it. Both existing "leaves non-matching bytes unchanged" tests
    // above use a 25-byte P2PKH script, which exits at the length check and
    // never exercises this branch.
    const nearMiss = scriptBytes.slice()
    // Flip byte 0 (constant, well outside both variable runs) to a value
    // guaranteed to differ from the original AND to never collide with
    // TEMPLATE_MARKER (0xff) — a marker-led array takes a different branch
    // entirely (see the marker-leading test below).
    nearMiss[0] = nearMiss[0] === 0x00 ? 0x01 : 0x00

    const compressed = await compressScript(nearMiss)

    expect(compressed).toEqual(nearMiss)
    expect(compressed.length).toBe(scriptBytes.length)
    expect(compressed[0]).not.toBe(TEMPLATE_MARKER)
    expect(isCompressed(compressed)).toBe(false)
  })

  it('compressScript throws rather than silently passing through bytes that already begin with the compressed-script marker', async () => {
    // A 47-byte, marker-led, well-formed-looking header (version 1, region
    // 0x01, originalLength 959632 — the real R1K1_LOCK_LEN) whose 40-byte
    // payload is not a real commitment/k1PublicKeyHash pair at all. Before
    // the Fix 1 guard, compressForRegion's pass-through returned this
    // verbatim (it matches no known template, since it's only 47 bytes
    // long): isCompressed() would then report true, and a caller following
    // this module's own documented isCompressed(b) ? expandScript(b) : b
    // pattern would inflate it into a fabricated 959632-byte vault script
    // whose commitment and k1PublicKeyHash are both 0xaa x20 — violating
    // expand(compress(x)) === x for this constructible x.
    const markerLeading = [TEMPLATE_MARKER, 0x01, 0x01, 0x00, 0x0e, 0xa4, 0x90, ...Array(40).fill(0xaa)]
    expect(markerLeading.length).toBe(47)
    expect(isCompressed(markerLeading)).toBe(true)

    let caught: unknown
    try {
      await compressScript(markerLeading)
    } catch (e) {
      caught = e
    }
    expect(caught).toMatchObject({ code: 'template-invalid' })
  })

  it('expandScript throws template-unknown for an unrecognised version', async () => {
    const bogus = [TEMPLATE_MARKER, 250, 0x01, 0, 0, 0, 0]

    let caught: unknown
    try {
      await expandScript(bogus)
    } catch (e) {
      caught = e
    }
    expect(caught).toMatchObject({ code: 'template-unknown' })
  })

  it('expandScript throws template-unknown for an unrecognised region', async () => {
    const bogus = [TEMPLATE_MARKER, 1, 0x7f, 0, 0, 0, 0]

    let caught: unknown
    try {
      await expandScript(bogus)
    } catch (e) {
      caught = e
    }
    expect(caught).toMatchObject({ code: 'template-unknown' })
  })

  it('expandScript throws rather than returning short bytes for a truncated header', async () => {
    const truncated = [TEMPLATE_MARKER, 1, 0x01, 0, 0] // 5 bytes; a full header needs 7

    let caught: unknown
    try {
      await expandScript(truncated)
    } catch (e) {
      caught = e
    }
    expect(caught).toMatchObject({ code: 'template-invalid' })
  })

  it('expandScript reports template-unknown, not template-invalid, for short bytes that never begin with the marker', async () => {
    // The marker check runs BEFORE the length check: a short array that was
    // never meant to be a compressed header (it doesn't even start with
    // 0xff) must be diagnosed as "unrecognised", not misreported as a
    // truncated header of a real one. Covers both a non-empty short array
    // and the empty-array edge case (no byte 0 to even inspect).
    for (const short of [[], [0x01, 0x02, 0x03]]) {
      let caught: unknown
      try {
        await expandScript(short)
      } catch (e) {
        caught = e
      }
      expect(caught).toMatchObject({ code: 'template-unknown' })
    }
  })

  it('expandScript throws template-invalid when the payload length disagrees with the version it names', async () => {
    // Header fields (version/region/originalLength) are left intact and
    // correctly name a known version; only the payload itself is one byte
    // short. This is the guard that stands between a corrupt blob and
    // `undefined` landing in the reconstructed bytes at a variable-run
    // offset (result[r.offset + i] = payload[payloadOffset + i]).
    const compressed = await compressScript(scriptBytes)
    const shortPayload = compressed.slice(0, compressed.length - 1)

    let caught: unknown
    try {
      await expandScript(shortPayload)
    } catch (e) {
      caught = e
    }
    expect(caught).toMatchObject({ code: 'template-invalid' })
  })

  it('expandScript throws template-invalid when originalLength disagrees with the version it names', async () => {
    const compressed = await compressScript(scriptBytes)
    const tampered = compressed.slice()
    tampered[3] ^= 0xff // corrupt the originalLength field's most-significant byte

    let caught: unknown
    try {
      await expandScript(tampered)
    } catch (e) {
      caught = e
    }
    expect(caught).toMatchObject({ code: 'template-invalid' })
  })
})

describe('vault template codec: region 0x02 (preimage scriptCode)', () => {
  // Building the ~960 KB locking script (and diffing it inside
  // describeVaultTemplate) is not free — build once for this whole block.
  let scriptCodeDescriptor: TemplateVersion
  let scriptBytes: number[]
  let scriptCodeBytes: number[]

  beforeAll(async () => {
    const descriptors = await describeVaultTemplate()
    const found = descriptors.find((d) => d.region === 0x02)
    if (!found) throw new Error('describeVaultTemplate did not return a region 0x02 descriptor')
    scriptCodeDescriptor = found

    scriptBytes = (await buildVaultLockingScript(fixture())).toBinary()
    scriptCodeBytes = scriptBytes.slice(60)
  })

  it("derives scriptCode by dropping the locking script's first 60 bytes — R1K1Wallet.unlockR1 builds the preimage as lockingBytes.subarray(60)", () => {
    // This is the test that fails and names the reason if @bsv/templates ever
    // changes that relationship: it re-derives 959572 straight from a
    // freshly built script (via the library's own 60-byte cut) rather than
    // trusting a hardcoded number, and separately confirms the codec's own
    // region-0x02 descriptor was derived the same way.
    expect(scriptCodeBytes.length).toBe(959572)
    expect(scriptCodeBytes.length).toBe(R1K1_LOCK_LEN - 60)
    expect(scriptCodeDescriptor.totalLength).toBe(R1K1_LOCK_LEN - 60)
    expect(matchesTemplate(scriptCodeBytes, scriptCodeDescriptor)).toBe(true)
  })

  it('the 0x02 variable run is k1PublicKeyHash only (20 bytes), not the 40-byte 0x01 payload', () => {
    // The R1 commitment run (offset 17, length 20 in the locking script) sits
    // entirely below the 60-byte cut, so it drops out of the scriptCode
    // altogether; only k1PublicKeyHash (originally at offset 959609) shifts
    // into view, at 959609 - 60 = 959549.
    expect(scriptCodeDescriptor.variableRuns).toEqual([{ offset: 959549, length: 20 }])
  })

  it('scriptCode constantHash matches the pinned reference recorded for version 1 region 0x02', () => {
    // Pinned literal, independently re-declared here (not imported) so a
    // one-sided edit to the implementation's pinned value can't silently
    // pass — mirrors the region-0x01 constantHash test above.
    expect(scriptCodeDescriptor.constantHash).toBe(
      'f759656aadfcdbd531531c9806b8bce89f7ed4363c7d3f07578455fb1b96a990'
    )
  })

  it('round-trips a freshly built scriptCode byte-for-byte', async () => {
    const compressed = await compressScriptCode(scriptCodeBytes)
    const expanded = await expandScript(compressed)
    expect(expanded).toEqual(scriptCodeBytes)
  })

  it('round-trips the REAL mined mainnet scriptCode byte-for-byte, and its compressed payload is k1PublicKeyHash ONLY', async () => {
    // The fixture holds the actual k1PublicKeyHash mined on-chain for txid
    // 6c947ae3..., vout 0 — this proves compress+expand reproduces a real,
    // already-mined scriptCode exactly, not just a freshly-built one.
    const mainnetScript = await buildMainnetFixtureScript()
    const mainnetScriptCode = mainnetScript.slice(60)
    expect(mainnetScriptCode.length).toBe(MAINNET_SCRIPT_CODE_LENGTH)
    expect(Utils.toHex(Hash.sha256(mainnetScriptCode))).toBe(MAINNET_SCRIPT_CODE_SHA256)

    const compressed = await compressScriptCode(mainnetScriptCode)
    const expanded = await expandScript(compressed)
    expect(expanded).toEqual(mainnetScriptCode)

    // Region 0x02's payload is 20 bytes (k1PublicKeyHash), not 40: the R1
    // commitment cannot survive the 60-byte cut, so it is not — and cannot
    // be — part of this payload. The commitment stays recoverable elsewhere:
    // the unlocking script pushes publicKey and salt verbatim, and
    // commitment = hash160(publicKey ‖ salt).
    const payload = compressed.slice(7) // HEADER_LENGTH: marker(1)+version(1)+region(1)+originalLength(4)
    expect(payload.length).toBe(20)
    expect(Utils.toHex(payload)).toBe(MAINNET_K1_PUBLIC_KEY_HASH_HEX)
  })

  it('produces a 27-byte compressed scriptCode starting with the 0xff marker (7-byte header + 20-byte payload)', async () => {
    const compressed = await compressScriptCode(scriptCodeBytes)
    expect(compressed[0]).toBe(TEMPLATE_MARKER)
    expect(compressed.length).toBe(27)
    expect(isCompressed(compressed)).toBe(true)
  })

  it('leaves non-matching bytes unchanged and does not allocate a header', async () => {
    const wrongLength = scriptCodeBytes.slice(0, 1000)
    const compressed = await compressScriptCode(wrongLength)
    expect(compressed).toEqual(wrongLength)
    expect(compressed[0]).not.toBe(TEMPLATE_MARKER)
    expect(isCompressed(compressed)).toBe(false)
  })
})

describe('vault template codec: same-length constant-byte drift is caught', () => {
  // The failure mode this guards against: an @bsv/templates upgrade that
  // keeps R1K1_LOCK_LEN (959632) bytes but alters one of the FIXED bytes in
  // between. totalLength and originalLength checks can't see this — only
  // comparing the live template's constantHash against a pinned reference
  // can. This is exercised end-to-end (a real describeVaultTemplate() call,
  // not a duplicated/extracted comparison helper), against a mocked
  // buildVaultLockingScript that flips one constant byte the SAME way on
  // every sample it builds — so the diffing logic still treats it as
  // constant, not variable, and only its value has drifted.
  //
  // Runs inside jest.isolateModulesAsync so the mocked drift gets its own,
  // separate `templateCodec` module instance (own `cachedDescriptors`,
  // untouched by whatever the other describe blocks in this file already
  // cached) rather than contaminating the real one the rest of this suite
  // relies on.
  it('describeVaultTemplate throws template-unknown when a constant byte drifts at the same length', async () => {
    let freshDescribe: (() => Promise<unknown>) | undefined

    await jest.isolateModulesAsync(async () => {
      jest.doMock('@/services/vault/r1k1', () => {
        const actual = jest.requireActual('@/services/vault/r1k1')
        return {
          ...actual,
          buildVaultLockingScript: async (a: { r1PublicKey: string; salt: string; k1PublicKeyHash: number[] }) => {
            const script = await actual.buildVaultLockingScript(a)
            const bytes: number[] = script.toBinary()
            bytes[0] ^= 0xff // outside both variable runs; same on every sample, so it reads as "constant" — just the wrong constant
            return { toBinary: () => bytes }
          }
        }
      })
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- isolated module registry needs a fresh require, not the file's top-level import
      const mod = require('@/services/vault/templateCodec')
      freshDescribe = mod.describeVaultTemplate
    })

    let caught: unknown
    try {
      await freshDescribe!()
    } catch (e) {
      caught = e
    }
    expect(caught).toMatchObject({ code: 'template-unknown' })
  })
})

describe('vault template codec: coincidental sample agreement cannot narrow a real variable run', () => {
  // Regression test for a subtle false-positive distinct from the drift test
  // above: DIFF_SAMPLE_COUNT (4) throwaway samples are diffed to FIND the
  // variable runs, so a genuinely-variable byte that happens to draw the
  // SAME value on every sample — a real, if individually unlikely,
  // per-process coincidence, not an actual template change — would make
  // findVariableRuns split a real run and report it one byte narrower than
  // it truly is. Without a backstop, that narrower run changes constantHash
  // and makes describeVaultTemplate throw 'template-unknown' — a false
  // diagnosis of an @bsv/templates upgrade when nothing changed, and (since
  // only the success path is memoized) a ~114ms re-pay on every subsequent
  // call until the coincidence stops recurring.
  //
  // describeVaultTemplate masks (unions) the sample-derived runs against
  // PINNED_VARIABLE_RUNS_V1 precisely so a coincidental agreement can only
  // ever widen a run, never split one. This mocks buildVaultLockingScript to
  // force one byte inside the real commitment run (offsets 17..36) to the
  // SAME value on every sample, reproducing that coincidence deterministically
  // rather than waiting on real (im)probability.
  //
  // Runs inside jest.isolateModulesAsync for the same reason as the drift
  // test above: an isolated module instance with its own `cachedDescriptors`.
  it('describeVaultTemplate does not throw, and keeps the full pinned run geometry, when one byte inside a real variable run agrees on every sample', async () => {
    let freshDescribe: (() => Promise<TemplateVersion[]>) | undefined

    await jest.isolateModulesAsync(async () => {
      jest.doMock('@/services/vault/r1k1', () => {
        const actual = jest.requireActual('@/services/vault/r1k1')
        return {
          ...actual,
          buildVaultLockingScript: async (a: { r1PublicKey: string; salt: string; k1PublicKeyHash: number[] }) => {
            const script = await actual.buildVaultLockingScript(a)
            const bytes: number[] = script.toBinary()
            // Offset 25 sits inside the real 17..36 commitment run (a
            // genuine hash160 output, ordinarily different on every sample).
            // Forcing it to a fixed value on every sample simulates the rare
            // coincidence without needing astronomical luck.
            bytes[25] = 0x00
            return { toBinary: () => bytes }
          }
        }
      })
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- isolated module registry needs a fresh require, not the file's top-level import
      const mod = require('@/services/vault/templateCodec')
      freshDescribe = mod.describeVaultTemplate
    })

    const descriptors = await freshDescribe!()
    const region1 = descriptors.find((d) => d.region === 0x01)
    expect(region1).toBeDefined()
    // The full 20-byte commitment run, NOT split around offset 25.
    expect(region1!.variableRuns).toEqual([
      { offset: 17, length: 20 },
      { offset: 959609, length: 20 }
    ])
  })
})
