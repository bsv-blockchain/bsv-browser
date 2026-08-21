/**
 * The "never at full size" invariant, pinned.
 *
 * The first mainnet vault wallet wedged its backup log because ONE row —
 * proven_txs.rawTx, 960,075 bytes — could not fit a 1 MiB blob, and the cursor
 * rightly refused to skip it. These tests pin the decisions that keep that from
 * recurring: proven_txs.rawTx is compressed at rest, output scripts compress on
 * write and expand on read, and every hook is idempotent so a backup restore
 * cannot double-wrap.
 */
import { COMPRESS_PROVEN_TX_RAWTX, compressOutputScript, expandStoredScript } from '@/storage/methods/expandStored'
import { isCompressed } from '@/services/vault/templateCodec'
import { buildMainnetFixtureScript } from '../vault/fixtures/r1k1MainnetFixture'

const P2PKH = [0x76, 0xa9, 0x14, ...new Array(20).fill(1), 0x88, 0xac]

let VAULT_LOCK: number[]

beforeAll(async () => {
  VAULT_LOCK = Array.from(await buildMainnetFixtureScript())
})

describe('COMPRESS_PROVEN_TX_RAWTX', () => {
  it('is on — proven_txs.rawTx must never be stored at full size', () => {
    // Deliberate decision 2026-08-20 after the mainnet wedge. Flipping this off
    // keeps old rows readable (expansion is unconditional) but reintroduces a
    // ~960 KB at-rest row per vault deposit. Do not turn it off without reading
    // the flag's doc comment.
    expect(COMPRESS_PROVEN_TX_RAWTX).toBe(true)
  })
})

describe('compressOutputScript', () => {
  it('compresses a genuine R1-K1 locking script and reads back byte-exactly', async () => {
    expect(VAULT_LOCK.length).toBeGreaterThan(950_000)
    const stored = await compressOutputScript(VAULT_LOCK)
    expect(isCompressed(stored!)).toBe(true)
    expect(stored!.length).toBeLessThan(1000)
    expect(await expandStoredScript(stored)).toEqual(VAULT_LOCK)
  })

  it('leaves an ordinary script alone', async () => {
    expect(await compressOutputScript(P2PKH)).toBe(P2PKH)
  })

  it('is idempotent, which is what makes a restore safe', async () => {
    // getSyncChunk emits output scripts in compressed form and processSyncChunk
    // feeds them back through insertOutput; the isCompressed guard must pass a
    // compressed value through untouched.
    const once = await compressOutputScript(VAULT_LOCK)
    const twice = await compressOutputScript(once)
    expect(twice).toBe(once)
    expect(await expandStoredScript(twice)).toEqual(VAULT_LOCK)
  })

  it('leaves a marker-led forgery alone rather than throwing', async () => {
    // outputs.lockingScript can hold page-supplied bytes (internalizeAction), so
    // a 0xff-led value that is not a real compressed record must neither wedge
    // the write nor be mistaken for one — the isCompressed guard skips it and
    // the read side degrades per expandStoredScript's provenance rule.
    const forged = [0xff, 0x01, 0x01, 0xde, 0xad]
    expect(await compressOutputScript(forged)).toBe(forged)
  })

  it('passes undefined and empty through', async () => {
    expect(await compressOutputScript(undefined)).toBeUndefined()
    expect(await compressOutputScript([])).toEqual([])
  })

  it('preserves the caller shape', async () => {
    const asBytes = await compressOutputScript(Uint8Array.from(VAULT_LOCK))
    expect(asBytes).toBeInstanceOf(Uint8Array)
    const asArray = await compressOutputScript(VAULT_LOCK)
    expect(Array.isArray(asArray)).toBe(true)
  })

  it('never grows a blob', async () => {
    const stored = await compressOutputScript(P2PKH)
    expect(stored!.length).toBeLessThanOrEqual(P2PKH.length)
  })
})
