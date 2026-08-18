import { Hash, P2PKH, PrivateKey, Utils } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'
import { R1K1_LOCK_LEN, buildVaultLockingScript } from '@/services/vault/r1k1'
import { describeVaultTemplate, matchesTemplate, TemplateVersion } from '@/services/vault/templateCodec'

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
})
