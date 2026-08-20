/**
 * Compress-on-write, and the round trip through both hooks.
 *
 * The storage class itself needs expo-sqlite, so these exercise the pure pair
 * the hooks delegate to. That is the whole reason the decision lives in a module
 * rather than inline in the methods.
 */
import { Hash, Utils } from '@bsv/sdk'
import { compressStoredTx, expandStoredTx } from '@/storage/methods/expandStored'
import { isEnvelope } from '@/services/vault/txEnvelope'
import { buildMainnetFixtureScript } from '../vault/fixtures/r1k1MainnetFixture'

const varint = (n: number): number[] =>
  n < 0xfd ? [n] : [0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]

const cat = (parts: (Uint8Array | number[])[]): Uint8Array => {
  const chunks = parts.map(p => (p instanceof Uint8Array ? p : Uint8Array.from(p)))
  const out = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0))
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

const P2PKH = Uint8Array.from([0x76, 0xa9, 0x14, ...new Array(20).fill(1), 0x88, 0xac])

let VAULT_TX: number[]
let VAULT_TXID: string
let PLAIN_TX: number[]
let PLAIN_TXID: string

beforeAll(async () => {
  const lock = Uint8Array.from(await buildMainnetFixtureScript())
  const build = (script: Uint8Array): Uint8Array =>
    cat([
      [1, 0, 0, 0],
      [1],
      new Uint8Array(32).fill(0xaa),
      [0, 0, 0, 0],
      varint(P2PKH.length),
      P2PKH,
      [0xff, 0xff, 0xff, 0xff],
      [1],
      [0xe0, 0x93, 4, 0, 0, 0, 0, 0],
      varint(script.length),
      script,
      [0, 0, 0, 0]
    ])
  const vault = build(lock)
  VAULT_TX = Array.from(vault)
  VAULT_TXID = Utils.toHex(Hash.hash256(VAULT_TX).reverse())
  const plain = build(P2PKH)
  PLAIN_TX = Array.from(plain)
  PLAIN_TXID = Utils.toHex(Hash.hash256(PLAIN_TX).reverse())
})

describe('compressStoredTx', () => {
  it('compresses a vault transaction and reads back byte-exactly', async () => {
    const stored = await compressStoredTx(VAULT_TX, VAULT_TXID)
    expect(isEnvelope(stored)).toBe(true)
    expect(stored!.length).toBeLessThan(1000)
    expect(VAULT_TX.length).toBeGreaterThan(950_000)

    expect(await expandStoredTx(stored)).toEqual(VAULT_TX)
  })

  it('leaves an ordinary transaction alone', async () => {
    const stored = await compressStoredTx(PLAIN_TX, PLAIN_TXID)
    expect(stored).toBe(PLAIN_TX)
    expect(isEnvelope(stored)).toBe(false)
  })

  it('is idempotent, which is what makes a restore safe', async () => {
    // processSyncChunk feeds bytes from a backup straight back through the insert
    // methods, and those bytes are in STORED form because getSyncChunk emits
    // stored form. Without the envelope guard a restore would wrap an envelope in
    // an envelope, and the inner one would never be unwrapped.
    const once = await compressStoredTx(VAULT_TX, VAULT_TXID)
    const twice = await compressStoredTx(once, VAULT_TXID)
    expect(twice).toBe(once)
    expect(await expandStoredTx(twice)).toEqual(VAULT_TX)
  })

  it('stores raw when the txid is unknown, rather than an unverifiable envelope', async () => {
    // Expansion proves itself by hashing and comparing against the recorded
    // txid. An envelope written without one could never be checked, so the
    // uncompressed bytes are the safer store.
    expect(await compressStoredTx(VAULT_TX, undefined)).toBe(VAULT_TX)
    expect(await compressStoredTx(VAULT_TX, 'not-a-txid')).toBe(VAULT_TX)
  })

  it('never grows a blob', async () => {
    const stored = await compressStoredTx(PLAIN_TX, PLAIN_TXID)
    expect(stored!.length).toBeLessThanOrEqual(PLAIN_TX.length)
  })

  it('passes undefined and empty through', async () => {
    expect(await compressStoredTx(undefined, VAULT_TXID)).toBeUndefined()
    expect(await compressStoredTx([], VAULT_TXID)).toEqual([])
  })

  it('preserves the caller shape', async () => {
    // inputBEEF is typed Uint8Array-backed in places and number[] in others;
    // silently swapping one for the other would break a consumer somewhere the
    // types do not reach.
    const asBytes = await compressStoredTx(Uint8Array.from(VAULT_TX), VAULT_TXID)
    expect(asBytes).toBeInstanceOf(Uint8Array)
    const asArray = await compressStoredTx(VAULT_TX, VAULT_TXID)
    expect(Array.isArray(asArray)).toBe(true)
  })

  it('round-trips a transaction whose txid a caller looked up separately', async () => {
    // The update path reads the txid back out of the row when the update did not
    // carry one; this is that shape.
    const stored = await compressStoredTx(VAULT_TX, VAULT_TXID.toUpperCase())
    expect(isEnvelope(stored)).toBe(true)
    expect(await expandStoredTx(stored)).toEqual(VAULT_TX)
  })
})
