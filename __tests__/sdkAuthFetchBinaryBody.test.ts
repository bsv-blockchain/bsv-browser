/**
 * Guards the @bsv/sdk 2.4.0 fix to AuthFetch.normalizeBodyToNumberArray.
 *
 * On 2.1.9 the method tested `typeof body === 'object'` as its FIRST branch and returned
 * Utils.toArray(JSON.stringify(body)). Arrays, Uint8Array, ArrayBuffer, Blob, FormData and
 * URLSearchParams are all `typeof 'object'`, so every binary branch below it was dead code
 * and a Uint8Array body was serialised as {"0":12,"1":255,...}.
 *
 * The encrypted wallet backup log POSTs raw ciphertext as an octet-stream body. If this
 * regresses on a future SDK bump, every backup blob is silently corrupted on upload — the
 * server would store well-formed JSON that no client can decrypt, and nothing would fail
 * loudly until someone tried to restore. Hence a hard gate rather than a comment.
 */
import { AuthFetch, CompletedProtoWallet, PrivateKey } from '@bsv/sdk'

/** normalizeBodyToNumberArray is private; reach it deliberately rather than reimplement. */
async function normalize (body: unknown): Promise<number[]> {
  const client = new AuthFetch(new CompletedProtoWallet(PrivateKey.fromRandom()))
  return await (
    client as unknown as {
      normalizeBodyToNumberArray: (b: unknown) => Promise<number[]>
    }
  ).normalizeBodyToNumberArray(body)
}

describe('AuthFetch binary body handling', () => {
  it('passes a Uint8Array through as raw bytes', async () => {
    expect(await normalize(new Uint8Array([0, 12, 127, 128, 255]))).toEqual([0, 12, 127, 128, 255])
  })

  it('does not JSON-stringify a Uint8Array', async () => {
    const asText = Buffer.from(await normalize(new Uint8Array([255, 254]))).toString('utf8')
    expect(asText).not.toContain('{"0"')
  })

  it('honours byteOffset and byteLength on a subarray view', async () => {
    // 2.1.9 did `new Uint8Array(body.buffer)`, ignoring both, so a view returned its whole
    // backing buffer. Chunked payloads built on a shared buffer would silently corrupt.
    const backing = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    expect(await normalize(backing.subarray(2, 5))).toEqual([3, 4, 5])
  })

  it('passes a number[] through unchanged', async () => {
    expect(await normalize([1, 2, 3])).toEqual([1, 2, 3])
  })

  it('round-trips arbitrary bytes without loss', async () => {
    const all = Array.from({ length: 256 }, (_, i) => i)
    expect(await normalize(new Uint8Array(all))).toEqual(all)
  })

  it('still encodes a plain object as JSON', async () => {
    const text = Buffer.from(await normalize({ hello: 'world' })).toString('utf8')
    expect(text).toBe('{"hello":"world"}')
  })

  it('still encodes a string as UTF-8', async () => {
    expect(Buffer.from(await normalize('héllo')).toString('utf8')).toBe('héllo')
  })
})
