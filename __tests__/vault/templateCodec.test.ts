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
  releaseTemplateCache,
  TEMPLATE_MARKER,
  TemplateVersion
} from '@/services/vault/templateCodec'

/** 11-byte v2 header: marker(1) + version(1) + region(1) + originalLength(4) +
 * checksum(4). Kept as a local literal (not imported) so tests can't be made
 * to pass by silently changing the implementation's HEADER_LENGTH. */
const HEADER_LENGTH = 11

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

  it('reads totalLength 959632 and the two pinned variable runs from the vendored template', () => {
    // These are the plan's pinned, verbatim constants (Global Constraints:
    // R1K1_LOCK_LEN = 959632; commitment at offsets 17..36; k1PublicKeyHash
    // at offsets 959609..959628). describeVaultTemplate no longer diffs live
    // @bsv/templates builds to find these — it reads the vendored asset
    // (services/vault/vaultTemplateArtifact.ts) and the PINNED_VARIABLE_RUNS
    // literal directly. This assertion is what the separate "installed
    // library still matches the vendored template" test below exists to keep
    // honest: THAT test is what would fail if @bsv/templates ever changed the
    // layout, since this one no longer consults the library at all.
    expect(descriptor.totalLength).toBe(959632)
    expect(descriptor.totalLength).toBe(R1K1_LOCK_LEN)
    expect(descriptor.variableRuns).toEqual([
      { offset: 17, length: 20 },
      { offset: 959609, length: 20 }
    ])
    expect(descriptor.constantHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('constantHash matches the pinned reference for the vendored template', () => {
    // Pinned literal, computed once from a genuine @bsv/templates sample
    // before the template was vendored — mirrors PINNED_CONSTANT_HASH in
    // templateCodec.ts (kept as a separately-recorded literal here, not an
    // import, so this test can't be made to pass by silently changing the
    // implementation's pinned value).
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
    // number this codec has never supported reproduces that cold-call
    // condition without needing to reset module state.
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

describe('vault template codec: the vendored template still matches the installed library', () => {
  // The one test decision 2 requires: the vendored asset is now the SOLE
  // source of the reference template at runtime (describeVaultTemplate no
  // longer builds or diffs anything via @bsv/templates), so nothing else in
  // this file would notice if the currently-installed @bsv/templates drifted
  // from what was vendored. This test builds a script with whatever
  // @bsv/templates is installed RIGHT NOW, masks the same two variable runs
  // by hand (not via any codec helper — this must stay independent of the
  // implementation it's cross-checking), and hashes the result. A future
  // @bsv/templates upgrade that changes the template fails THIS test, loudly,
  // in CI — it can no longer make an already-stored compressed record
  // unreadable, because reconstruction never consults the installed library.
  it('a freshly built locking script, masked, hashes to the pinned constant', async () => {
    const scriptBytes = (await buildVaultLockingScript(fixture())).toBinary()
    expect(scriptBytes.length).toBe(959632)

    const masked = scriptBytes.slice()
    for (let i = 17; i < 17 + 20; i++) masked[i] = 0
    for (let i = 959609; i < 959609 + 20; i++) masked[i] = 0

    expect(Utils.toHex(Hash.sha256(masked))).toBe('41f6fcbbc46fe0eeb64a176fd66709694331b2327b1a63086105529e34a7493b')
  })

  it('the same masked bytes, sliced 60 bytes in for the preimage scriptCode, hash to the pinned scriptCode constant', async () => {
    const scriptBytes = (await buildVaultLockingScript(fixture())).toBinary()
    const masked = scriptBytes.slice()
    for (let i = 17; i < 17 + 20; i++) masked[i] = 0
    for (let i = 959609; i < 959609 + 20; i++) masked[i] = 0

    const scriptCode = masked.slice(60)
    expect(scriptCode.length).toBe(959572)
    expect(Utils.toHex(Hash.sha256(scriptCode))).toBe(
      'f759656aadfcdbd531531c9806b8bce89f7ed4363c7d3f07578455fb1b96a990'
    )
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

  it('produces a 51-byte compressed script starting with the 0xff marker', async () => {
    const compressed = await compressScript(scriptBytes)
    expect(compressed[0]).toBe(TEMPLATE_MARKER)
    expect(compressed.length).toBe(51) // 11-byte v2 header + 40-byte payload (commitment 20 + k1PublicKeyHash 20)
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
    // A 51-byte, marker-led, well-formed-looking v2 header (version 2, region
    // 0x01, originalLength 959632 — the real R1K1_LOCK_LEN, plus 4 arbitrary
    // checksum bytes) whose 40-byte payload is not a real commitment/
    // k1PublicKeyHash pair at all. Before the Fix 1 guard, compressForRegion's
    // pass-through returned this verbatim (it matches no known template,
    // since it's only 51 bytes long): isCompressed() would then report true,
    // and a caller following this module's own documented
    // isCompressed(b) ? expandScript(b) : b pattern would inflate it into a
    // fabricated 959632-byte vault script whose commitment and
    // k1PublicKeyHash are both 0xaa x20 — violating
    // expand(compress(x)) === x for this constructible x.
    const markerLeading = [
      TEMPLATE_MARKER,
      0x02,
      0x01,
      0x00,
      0x0e,
      0xa4,
      0x90, // originalLength = 959632, big-endian
      0xde,
      0xad,
      0xbe,
      0xef, // arbitrary checksum bytes
      ...Array(40).fill(0xaa)
    ]
    expect(markerLeading.length).toBe(51)
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
    const bogus = [TEMPLATE_MARKER, 250, 0x01, 0, 0, 0, 0, 0, 0, 0, 0]
    expect(bogus.length).toBe(HEADER_LENGTH)

    let caught: unknown
    try {
      await expandScript(bogus)
    } catch (e) {
      caught = e
    }
    expect(caught).toMatchObject({ code: 'template-unknown' })
  })

  it('expandScript throws template-unknown for an unrecognised region', async () => {
    // version 2 (this codec's only supported version) paired with a region
    // byte no descriptor uses — isolates "unrecognised region" from
    // "unrecognised version" (a bogus version alone would already explain
    // the throw without this test proving anything about region handling).
    const bogus = [TEMPLATE_MARKER, 2, 0x7f, 0, 0, 0, 0, 0, 0, 0, 0]
    expect(bogus.length).toBe(HEADER_LENGTH)

    let caught: unknown
    try {
      await expandScript(bogus)
    } catch (e) {
      caught = e
    }
    expect(caught).toMatchObject({ code: 'template-unknown' })
  })

  it('expandScript throws rather than returning short bytes for a truncated header', async () => {
    const truncated = [TEMPLATE_MARKER, 2, 0x01, 0, 0, 0, 0, 0] // 8 bytes; a full v2 header needs 11

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
    // Header fields (version/region/originalLength/checksum) are left intact
    // and correctly name a known version; only the payload itself is one
    // byte short. This is the guard that stands between a corrupt blob and
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

  it('expandScript throws template-invalid when the checksum disagrees with the reconstructed bytes', async () => {
    // The v2 header's whole reason for existing: flip one payload byte
    // (still the right LENGTH, so the length/originalLength guards above
    // don't fire) and confirm the corruption is still caught — by the
    // checksum, computed over the FULL reconstructed bytes, not by any
    // header field. Before v2, this exact mutation would have round-tripped
    // into a structurally perfect but WRONG 959632-byte script with no error
    // at all (wrong txid, broken merkle proof, unrecoverable deposit record).
    const compressed = await compressScript(scriptBytes)
    const tampered = compressed.slice()
    tampered[HEADER_LENGTH] ^= 0xff // first payload byte (start of the commitment run)

    let caught: unknown
    try {
      await expandScript(tampered)
    } catch (e) {
      caught = e
    }
    expect(caught).toMatchObject({ code: 'template-invalid' })
    expect((caught as Error).message).toMatch(/checksum/i)
  })

  it('expandScript still throws template-invalid on a checksum mismatch even when the corrupted bytes still happen to have the right length and originalLength', async () => {
    // Belt-and-braces: corrupt a CONSTANT byte (outside every variable run,
    // so matchesTemplate-style recognition plays no role here — expandScript
    // never calls matchesTemplate) by tampering with the header's own
    // checksum field instead of the payload, proving the checksum is checked
    // against the RECONSTRUCTION, not merely echoed back.
    const compressed = await compressScript(scriptBytes)
    const tampered = compressed.slice()
    tampered[7] ^= 0xff // first checksum byte

    let caught: unknown
    try {
      await expandScript(tampered)
    } catch (e) {
      caught = e
    }
    expect(caught).toMatchObject({ code: 'template-invalid' })
    expect((caught as Error).message).toMatch(/checksum/i)
  })
})

describe('vault template codec: region 0x02 (preimage scriptCode)', () => {
  // Building the ~960 KB locking script is not free — build once for this
  // whole block.
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

  it('scriptCode constantHash matches the pinned reference for the vendored template', () => {
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
    const payload = compressed.slice(HEADER_LENGTH)
    expect(payload.length).toBe(20)
    expect(Utils.toHex(payload)).toBe(MAINNET_K1_PUBLIC_KEY_HASH_HEX)
  })

  it('produces a 31-byte compressed scriptCode starting with the 0xff marker (11-byte v2 header + 20-byte payload)', async () => {
    const compressed = await compressScriptCode(scriptCodeBytes)
    expect(compressed[0]).toBe(TEMPLATE_MARKER)
    expect(compressed.length).toBe(31)
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

describe('vault template codec: vendored-asset corruption is caught', () => {
  // The failure mode this guards against, now that the reference template is
  // vendored rather than rebuilt: a corrupted or hand-edited
  // vaultTemplateArtifact.ts whose inflated bytes disagree with
  // PINNED_CONSTANT_HASH. This used to be caught by re-diffing live
  // @bsv/templates builds on every describeVaultTemplate() call; now it's
  // caught by ensureTemplateCache's masked-hash cross-check against the
  // vendored asset it just inflated (see templateCodec.ts). Runs inside
  // jest.isolateModulesAsync so the mocked corruption gets its own, separate
  // templateCodec module instance (own module-level template cache),
  // untouched by whatever the other describe blocks in this file already
  // cached.
  it('describeVaultTemplate throws template-invalid when the vendored asset is corrupted', async () => {
    // Build a real reference template the same way vaultTemplateArtifact.ts
    // was generated, flip one constant byte (well outside both variable
    // runs), and re-gzip — reproducing a corrupted commit of that file
    // without needing to touch the real one on disk.
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- this file otherwise only imports fflate transitively; a plain require avoids a dynamic-import that this Jest/Babel setup doesn't support
    const { gzipSync } = require('fflate')
    const real = (await buildVaultLockingScript(fixture())).toBinary()
    const masked = real.slice()
    for (let i = 17; i < 17 + 20; i++) masked[i] = 0
    for (let i = 959609; i < 959609 + 20; i++) masked[i] = 0
    masked[0] ^= 0xff // corrupt a constant byte, same idea as the old drift test
    const corruptedGzip = gzipSync(Uint8Array.from(masked), { level: 9 })
    const corruptedBase64 = Buffer.from(corruptedGzip).toString('base64')

    let freshDescribe: (() => Promise<unknown>) | undefined

    await jest.isolateModulesAsync(async () => {
      jest.doMock('@/services/vault/vaultTemplateArtifact', () => ({
        VAULT_TEMPLATE_GZIP_BASE64: corruptedBase64,
        VAULT_TEMPLATE_RAW_LENGTH: 959_632
      }))
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
    expect(caught).toMatchObject({ code: 'template-invalid' })
  })
})

describe('vault template codec: template cache release', () => {
  it('releaseTemplateCache lets describeVaultTemplate/compress/expand keep working, transparently re-inflating the vendored asset', async () => {
    // Prove the cache is genuinely gone and genuinely comes back: populate
    // it, release it, then exercise every exported entry point afterwards —
    // each one must re-populate on demand rather than depending on state left
    // over from before the release.
    await describeVaultTemplate()
    releaseTemplateCache()

    const descriptors = await describeVaultTemplate()
    expect(descriptors).toHaveLength(2)
    expect(descriptors[0].totalLength).toBe(959632)

    const scriptBytes = (await buildVaultLockingScript(fixture())).toBinary()
    releaseTemplateCache()
    const compressed = await compressScript(scriptBytes)
    expect(compressed.length).toBe(51)

    releaseTemplateCache()
    const expanded = await expandScript(compressed)
    expect(expanded).toEqual(scriptBytes)

    // Leave the cache populated for whatever test runs next in this file —
    // this test's job is to prove release-then-reuse works, not to leave
    // global module state released for later tests that don't expect it.
    await describeVaultTemplate()
  })

  it('matchesTemplate throws template-invalid, not a stale true/false, right after a release with no intervening describeVaultTemplate call', async () => {
    const [descriptor] = await describeVaultTemplate()
    const scriptBytes = (await buildVaultLockingScript(fixture())).toBinary()
    expect(matchesTemplate(scriptBytes, descriptor)).toBe(true)

    releaseTemplateCache()

    let caught: unknown
    try {
      matchesTemplate(scriptBytes, descriptor)
    } catch (e) {
      caught = e
    }
    expect(caught).toMatchObject({ code: 'template-invalid' })

    // Restore populated state for subsequent tests in this file.
    await describeVaultTemplate()
  })
})
