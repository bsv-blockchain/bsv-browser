import { Hash, PrivateKey, Transaction, P2PKH, Spend, Utils } from '@bsv/sdk'
import { R1K1Wallet } from '@bsv/templates'
import { p256 } from '@noble/curves/nist.js'
import {
  R1K1_LOCK_LEN,
  R1K1_R1_UNLOCK_LEN,
  R1K1_K1_UNLOCK_LEN,
  buildVaultLockingScript,
  compressP256,
  encodeVaultInstructions,
  decodeVaultInstructions
} from '@/services/vault/r1k1'

const derSign = (priv: Uint8Array) => (digest: Uint8Array) =>
  Array.from(p256.Signature.fromBytes(p256.sign(digest, priv, { prehash: false })).toBytes('der'))

function fixture() {
  const r1priv = p256.utils.randomSecretKey()
  const r1PublicKey = Utils.toHex(Array.from(p256.getPublicKey(r1priv, true)))
  const salt = Utils.toHex(Array.from(crypto.getRandomValues(new Uint8Array(32))))
  const k1 = PrivateKey.fromRandom()
  const k1PublicKeyHash = Hash.hash160(k1.toPublicKey().encode(true) as number[])
  return { r1priv, r1PublicKey, salt, k1, k1PublicKeyHash }
}

/** A spendable vault output plus the transaction spending it. */
async function scenario() {
  const f = fixture()
  const lockingScript = await buildVaultLockingScript(f)
  const pkh = Hash.hash160(f.k1.toPublicKey().encode(true) as number[])

  const src = new Transaction()
  src.addInput({
    sourceTXID: '11'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: new P2PKH().lock(pkh),
    sequence: 0xffffffff
  })
  src.addOutput({ satoshis: 500_000, lockingScript })

  const spend = new Transaction()
  spend.addInput({ sourceTransaction: src, sourceOutputIndex: 0, sequence: 0xffffffff })
  spend.addOutput({ satoshis: 400_000, lockingScript: new P2PKH().lock(pkh) })

  return { ...f, lockingScript, src, spend }
}

function validate(s: Awaited<ReturnType<typeof scenario>>, unlockingScript: import('@bsv/sdk').UnlockingScript) {
  return new Spend({
    sourceTXID: s.src.id('hex'),
    sourceOutputIndex: 0,
    sourceSatoshis: 500_000,
    lockingScript: s.lockingScript,
    transactionVersion: s.spend.version,
    otherInputs: [],
    inputIndex: 0,
    unlockingScript,
    outputs: s.spend.outputs,
    inputSequence: 0xffffffff,
    lockTime: s.spend.lockTime
  }).validate()
}

describe('r1k1 script module', () => {
  it('locks to exactly R1K1_LOCK_LEN bytes with both commitments in place', async () => {
    const f = fixture()
    const script = (await buildVaultLockingScript(f)).toUint8Array()

    expect(script.length).toBe(R1K1_LOCK_LEN)
    expect(R1K1_LOCK_LEN).toBe(959_632)

    // R1 commitment: 20-byte push at offset 16, value at 17..37
    expect(script[16]).toBe(20)
    const r1 = Hash.hash160([...Utils.toArray(f.r1PublicKey, 'hex'), ...Utils.toArray(f.salt, 'hex')])
    expect(Array.from(script.subarray(17, 37))).toEqual(r1)

    // K1 commitment: 20-byte push at offset 959608, value at 959609..959629
    expect(script[959_608]).toBe(20)
    expect(Array.from(script.subarray(959_609, 959_629))).toEqual(f.k1PublicKeyHash)
  })

  it('spends via the R1 branch', async () => {
    const s = await scenario()
    const u = new R1K1Wallet().unlockR1({
      publicKey: s.r1PublicKey,
      salt: s.salt,
      sourceSatoshis: 500_000,
      lockingScript: s.lockingScript,
      signDigest: derSign(s.r1priv)
    })
    const script = await u.sign(s.spend, 0)

    expect(validate(s, script)).toBe(true)
    expect(script.toBinary().length).toBe(R1K1_R1_UNLOCK_LEN)
  })

  it('accepts a high-S R1 signature without normalisation', async () => {
    const s = await scenario()
    const N = p256.Point.Fn.ORDER
    const u = new R1K1Wallet().unlockR1({
      publicKey: s.r1PublicKey,
      salt: s.salt,
      sourceSatoshis: 500_000,
      lockingScript: s.lockingScript,
      signDigest: (digest: Uint8Array) => {
        const raw = p256.sign(digest, s.r1priv, { prehash: false }) // noble emits low-S
        const sv = BigInt('0x' + Buffer.from(raw.slice(32)).toString('hex'))
        const high = Buffer.from((N - sv).toString(16).padStart(64, '0'), 'hex')
        return [...Array.from(raw.slice(0, 32)), ...Array.from(high)]
      }
    })
    expect(validate(s, await u.sign(s.spend, 0))).toBe(true)
  })

  it('spends via the K1 branch', async () => {
    const s = await scenario()
    const u = new R1K1Wallet().unlockK1({
      privateKey: s.k1,
      sourceSatoshis: 500_000,
      lockingScript: s.lockingScript
    })
    const script = await u.sign(s.spend, 0)

    expect(validate(s, script)).toBe(true)
    expect(script.toBinary().length).toBeLessThanOrEqual(R1K1_K1_UNLOCK_LEN)
  })

  it('rejects a wrong salt before signing', async () => {
    const s = await scenario()
    const wrongSalt = Utils.toHex(new Array(32).fill(9))
    const u = new R1K1Wallet().unlockR1({
      publicKey: s.r1PublicKey,
      salt: wrongSalt,
      sourceSatoshis: 500_000,
      lockingScript: s.lockingScript,
      signDigest: derSign(s.r1priv)
    })
    await expect(u.sign(s.spend, 0)).rejects.toThrow(/do not match the locking script commitment/)
  })

  it('rejects a wrong K1 key before signing', async () => {
    const s = await scenario()
    const u = new R1K1Wallet().unlockK1({
      privateKey: PrivateKey.fromRandom(),
      sourceSatoshis: 500_000,
      lockingScript: s.lockingScript
    })
    await expect(u.sign(s.spend, 0)).rejects.toThrow(/does not match the locking script commitment/)
  })

  it('compresses a 65-byte uncompressed SEC1 point', () => {
    const priv = p256.utils.randomSecretKey()
    const uncompressed = Utils.toHex(Array.from(p256.getPublicKey(priv, false)))
    const expected = Utils.toHex(Array.from(p256.getPublicKey(priv, true)))

    expect(compressP256(uncompressed)).toBe(expected)
    expect(compressP256(expected)).toBe(expected) // idempotent
    expect(() => compressP256('00'.repeat(64))).toThrow(/uncompressed SEC1/)
  })

  it('round-trips customInstructions and rejects foreign ones', () => {
    const i = {
      v: 2 as const,
      type: 'R1K1' as const,
      keyID: 'bip32/7',
      salt: '0a'.repeat(32),
      r1PublicKey: '02' + 'bb'.repeat(32),
      slot: 0x82
    }
    expect(decodeVaultInstructions(encodeVaultInstructions(i))).toEqual(i)

    expect(decodeVaultInstructions(undefined)).toBeNull()
    expect(decodeVaultInstructions('not json')).toBeNull()
    expect(decodeVaultInstructions(JSON.stringify({ v: 1, keyID: 'bip32/7' }))).toBeNull()
    expect(decodeVaultInstructions(JSON.stringify({ ...i, salt: 'ff' }))).toBeNull()
    expect(decodeVaultInstructions(JSON.stringify({ ...i, keyID: 'vault/7' }))).toBeNull()
  })
})
