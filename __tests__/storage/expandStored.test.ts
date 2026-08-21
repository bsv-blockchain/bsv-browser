/**
 * The expansion boundary.
 *
 * Built on real envelopes and real compressed scripts rather than stand-ins,
 * because the whole value of this module is that it can tell three encodings
 * apart by their first byte, and a stand-in would make that trivially true.
 */
import { Hash, Utils } from '@bsv/sdk'
import { compressScriptBytes } from '@/services/vault/templateCodec'
import { compressTransaction } from '@/services/vault/txEnvelope'
import {
  assertExpanded,
  expandStoredRange,
  expandStoredScript,
  expandStoredTx
} from '@/storage/methods/expandStored'
import { buildMainnetFixtureScript } from '../vault/fixtures/r1k1MainnetFixture'

let LOCK: Uint8Array
let TX: Uint8Array
let ENVELOPE: number[]
let SCRIPT_OFFSET: number

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

beforeAll(async () => {
  LOCK = Uint8Array.from(await buildMainnetFixtureScript())
  const p2pkh = Uint8Array.from([0x76, 0xa9, 0x14, ...new Array(20).fill(1), 0x88, 0xac])
  TX = cat([
    [1, 0, 0, 0],
    [1],
    new Uint8Array(32).fill(0xaa),
    [0, 0, 0, 0],
    varint(p2pkh.length),
    p2pkh,
    [0xff, 0xff, 0xff, 0xff],
    [1],
    [0xe0, 0x93, 4, 0, 0, 0, 0, 0],
    varint(LOCK.length),
    LOCK,
    [0, 0, 0, 0]
  ])
  SCRIPT_OFFSET = TX.length - 4 - LOCK.length
  const txid = Utils.toHex(Hash.hash256(Array.from(TX)).reverse())
  ENVELOPE = Array.from(await compressTransaction(TX, txid))
  expect(ENVELOPE[0]).toBe(0xfe)
})

describe('expandStoredTx', () => {
  it('expands an envelope back to the exact transaction', async () => {
    expect(await expandStoredTx(ENVELOPE)).toEqual(Array.from(TX))
  })

  it('passes ordinary rawTx through untouched, so it is safe to call always', async () => {
    const raw = Array.from(TX)
    expect(await expandStoredTx(raw)).toBe(raw)
  })

  it('passes undefined and empty through', async () => {
    expect(await expandStoredTx(undefined)).toBeUndefined()
    expect(await expandStoredTx([])).toEqual([])
  })

  it('THROWS on a corrupt envelope rather than returning wrong bytes', async () => {
    // Transaction blobs are only ever written by this wallet, so a failure here
    // means real corruption — and passing the bytes through is exactly how they
    // would reach a broadcaster or a hasher.
    const corrupt = [...ENVELOPE]
    corrupt[corrupt.length - 1] ^= 0x01
    await expect(expandStoredTx(corrupt)).rejects.toThrow(/txid/)
  })
})

describe('expandStoredRange', () => {
  it('reads a script at its recorded offset out of an envelope', async () => {
    // The silent-fund-eviction path: these offsets are into the UNCOMPRESSED
    // transaction, so slicing the stored envelope would return plausible wrong
    // bytes with no error.
    const range = await expandStoredRange(ENVELOPE, SCRIPT_OFFSET, LOCK.length)
    expect(range).toEqual(Array.from(LOCK))
  })

  it('slices plain bytes exactly as before', async () => {
    const raw = Array.from(TX)
    expect(await expandStoredRange(raw, SCRIPT_OFFSET, 8)).toEqual(Array.from(LOCK.subarray(0, 8)))
  })

  it('agrees with a full expansion followed by a slice', async () => {
    for (const [offset, length] of [
      [0, 4],
      [4, 40],
      [SCRIPT_OFFSET - 2, 10],
      [TX.length - 4, 4]
    ]) {
      expect(await expandStoredRange(ENVELOPE, offset, length)).toEqual(
        Array.from(TX.subarray(offset, offset + length))
      )
    }
  })
})

describe('expandStoredScript', () => {
  it('expands a compressed script', async () => {
    const record = Array.from(await compressScriptBytes(LOCK))
    expect(record[0]).toBe(0xff)
    expect(await expandStoredScript(record)).toEqual(Array.from(LOCK))
  })

  it('passes a real script through', async () => {
    const p2pkh = [0x76, 0xa9, 0x14, ...new Array(20).fill(1), 0x88, 0xac]
    expect(await expandStoredScript(p2pkh)).toBe(p2pkh)
  })

  it('degrades instead of throwing when a marker-led script cannot be expanded', async () => {
    // internalizeAction writes page-supplied output scripts with no
    // scriptLength/scriptOffset fallback, so a 0xff-led value here may be a
    // forgery rather than something this wallet wrote. findOutputs maps over its
    // results with no per-row catch, so throwing would take down listOutputs,
    // the vault screen and the backup sweep for the whole wallet over one row.
    const forged = [0xff, 0x02, 0x01, 0, 0, 0, 0, 1, 2, 3, 4, 9, 9, 9]
    await expect(expandStoredScript(forged)).resolves.toEqual(forged)
  })
})

describe('assertExpanded', () => {
  it('accepts real bytes', () => {
    expect(() => assertExpanded(Array.from(TX), 'rawTx')).not.toThrow()
    expect(() => assertExpanded(undefined, 'rawTx')).not.toThrow()
    expect(() => assertExpanded([], 'rawTx')).not.toThrow()
  })

  it('rejects either marker, naming what was about to be used', () => {
    // A branded type is erased crossing into node_modules, so this runtime check
    // is the only thing that spans the seam.
    expect(() => assertExpanded(ENVELOPE, 'broadcast payload')).toThrow(/broadcast payload/)
    expect(() => assertExpanded(ENVELOPE, 'x')).toThrow(/0xfe/)
    expect(() => assertExpanded([0xff, 2, 1], 'lockingScript')).toThrow(/0xff/)
  })

  it('accepts a Uint8Array as well as an array', () => {
    expect(() => assertExpanded(TX, 'rawTx')).not.toThrow()
    expect(() => assertExpanded(Uint8Array.from(ENVELOPE), 'rawTx')).toThrow()
  })
})
