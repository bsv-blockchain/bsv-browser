import { Hash, P2PKH, PrivateKey, Utils } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'
import { buildMainnetFixtureScript } from './fixtures/r1k1MainnetFixture'
import { R1K1_LOCK_LEN, buildVaultLockingScript } from '@/services/vault/r1k1'
import {
  compressScript,
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
