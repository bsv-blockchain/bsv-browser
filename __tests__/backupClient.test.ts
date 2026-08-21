/**
 * The app-side adapter over @bsv/backup-cache-client.
 *
 * The wire protocol itself is tested in the package (go-private-backup-cache/
 * ts-client); these tests pin the two decisions this repo owns — requests
 * authenticate as the backup pseudonym, and every request is time-bounded —
 * plus the seams call sites rely on (number[] bodies, error codes, limits).
 */
import { Hash, PrivateKey, Utils } from '@bsv/sdk'
import {
  BackupClient,
  BackupHttpError,
  BACKUP_REQUEST_TIMEOUT_MS,
  ERR_BLOB_TOO_LARGE,
  ERR_SEQ_CONFLICT
} from '@/utils/backup/client'
import { backupPseudonym } from '@/utils/backup/derive'

const KEY = new PrivateKey(9).toArray('be', 32)
const DEVICE = 'a'.repeat(32)
const BASE = 'https://backup.example.test'
const SERVER_KEY = new PrivateKey(7).toPublicKey().toString()

interface Call { url: string, init: RequestInit | undefined }

const jsonRes = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const limitsRes = (): Response =>
  jsonRes({ maxBlobBytes: 200 * 1024 * 1024, maxBodyBytes: 210 * 1024 * 1024, serverIdentityKey: SERVER_KEY })

/** Fetch stub answering /v1/limits itself and delegating everything else. */
function clientWith (
  respond: (call: Call) => Response
): { client: BackupClient, calls: Call[] } {
  const calls: Call[] = []
  const client = new BackupClient(BASE, KEY, (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/v1/limits')) return limitsRes()
    const call = { url, init }
    calls.push(call)
    return respond(call)
  }) as typeof fetch)
  return { client, calls }
}

/** Decode the X-Bsv-Auth header a call carried. */
function proofOf (call: Call): { action: string, identityKey: string } {
  const header = (call.init?.headers as Record<string, string>)['X-Bsv-Auth']
  return JSON.parse(Utils.toUTF8(Utils.toArray(header, 'base64')))
}

describe('BackupClient identity', () => {
  it('authenticates as the backup pseudonym, never the wallet identity', async () => {
    const { client, calls } = clientWith(() => jsonRes({ seq: 1, sha256: 'ab', size: 3 }, 201))
    await client.append(DEVICE, 1, 1, undefined, [1, 2, 3])

    expect(proofOf(calls[0]).identityKey).toBe(backupPseudonym(KEY))
  })

  it('signs the request URI and the body digest into the action', async () => {
    const { client, calls } = clientWith(() => jsonRes({ seq: 1, sha256: 'ab', size: 3 }, 201))
    await client.append(DEVICE, 3, 4, 'prevsha', [9])

    const digest = Utils.toHex(Hash.sha256([9]))
    expect(proofOf(calls[0]).action).toBe(
      `POST /v1/log/${DEVICE}?seq=4&generation=3&prevSha256=prevsha sha256=${digest}`
    )
  })

  it('never sends an identity parameter on any route', async () => {
    // The server derives the account from the proof's identity key alone.
    const { client, calls } = clientWith(() => jsonRes({ devices: [], entries: [] }))
    await client.manifest()
    await client.index(DEVICE, 1)
    for (const c of calls) expect(c.url).not.toMatch(/identity/i)
  })
})

describe('BackupClient bodies', () => {
  it('accepts the codec number[] and posts raw octet-stream', async () => {
    const { client, calls } = clientWith(() => jsonRes({ seq: 1, sha256: 'ab', size: 3 }, 201))
    await client.append(DEVICE, 1, 1, undefined, [1, 2, 3])

    expect((calls[0].init?.headers as Record<string, string>)['Content-Type']).toBe('application/octet-stream')
    expect(calls[0].init?.body).toBeInstanceOf(Uint8Array)
    expect(Array.from(calls[0].init?.body as Uint8Array)).toEqual([1, 2, 3])
  })

  it('returns blob ciphertext as bytes', async () => {
    const { client } = clientWith(() => new Response(new Uint8Array([9, 8, 7]), { status: 200 }))
    expect(Array.from(await client.blob(DEVICE, 1, 1))).toEqual([9, 8, 7])
  })
})

describe('BackupClient limits', () => {
  it('exposes the server-published cap and caches it across requests', async () => {
    const { client, calls } = clientWith(() => jsonRes({ devices: [] }))
    expect((await client.limits()).maxBlobBytes).toBe(200 * 1024 * 1024)
    await client.manifest()
    await client.manifest()
    // limits() answered from cache: only the two manifests hit the stub.
    expect(calls).toHaveLength(2)
  })
})

describe('BackupClient errors', () => {
  it('surfaces the server error envelope as BackupHttpError', async () => {
    const { client } = clientWith(() =>
      jsonRes({ code: ERR_SEQ_CONFLICT, description: 'expected seq 7' }, 409)
    )
    await expect(client.append(DEVICE, 1, 9, 'x', [1])).rejects.toMatchObject({
      status: 409,
      code: ERR_SEQ_CONFLICT
    })
  })

  it('surfaces the pre-auth 413 directly — no auth-failure masking remains', async () => {
    // The old BRC-103 transport reported the unsigned 413 as "missing auth
    // headers"; the stateless protocol has no signed response envelope, so the
    // real code arrives as itself.
    const { client } = clientWith(() =>
      jsonRes({ code: ERR_BLOB_TOO_LARGE, description: 'blob exceeds cap' }, 413)
    )
    await expect(client.append(DEVICE, 1, 1, undefined, [1])).rejects.toMatchObject({
      status: 413,
      code: ERR_BLOB_TOO_LARGE
    })
  })

  it('falls back to the status text when the error body is not JSON', async () => {
    const { client } = clientWith(() => new Response('<html>502</html>', { status: 502 }))
    await expect(client.manifest()).rejects.toBeInstanceOf(BackupHttpError)
  })
})

describe('BackupClient request timeout', () => {
  it('rejects a request that never answers instead of holding the monitor', async () => {
    jest.useFakeTimers()
    try {
      const never = new Promise<Response>(() => {})
      const client = new BackupClient(BASE, KEY, (async (input: RequestInfo | URL) => {
        if (String(input).endsWith('/v1/limits')) return limitsRes()
        return await never
      }) as typeof fetch)

      const pending = client.manifest()
      const assertion = expect(pending).rejects.toThrow(`timed out after ${BACKUP_REQUEST_TIMEOUT_MS}ms`)
      await jest.advanceTimersByTimeAsync(BACKUP_REQUEST_TIMEOUT_MS + 1)
      await assertion
    } finally {
      jest.useRealTimers()
    }
  })
})
