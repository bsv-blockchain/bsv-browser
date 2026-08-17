import { PrivateKey } from '@bsv/sdk'
import { BackupClient, BackupHttpError, BACKUP_REQUEST_TIMEOUT_MS, ERR_BLOB_TOO_LARGE, ERR_SEQ_CONFLICT } from '@/utils/backup/client'
import type { BackupRequestInit } from '@/utils/backup/client'

const KEY = new PrivateKey(9).toArray('be', 32)
const DEVICE = 'a'.repeat(32)
const BASE = 'https://backup.example.test'

interface Call { url: string, init: BackupRequestInit }

function clientWith (
  respond: (call: Call) => Response
): { client: BackupClient, calls: Call[] } {
  const calls: Call[] = []
  const client = new BackupClient(BASE, KEY, async (url, init) => {
    const call = { url, init }
    calls.push(call)
    return respond(call)
  })
  return { client, calls }
}

const jsonRes = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('BackupClient', () => {
  it('posts raw octet-stream, never JSON', async () => {
    // The server rejects anything else with 415, and JSON would cost ~4x for a payload
    // that is mostly transaction bytes.
    const { client, calls } = clientWith(() => jsonRes({ status: 'success', seq: 1, sha256: 'ab' }, 201))
    await client.append(DEVICE, 1, 1, undefined, [1, 2, 3])

    expect(calls[0].init.headers).toMatchObject({ 'Content-Type': 'application/octet-stream' })
    expect(calls[0].init.body).toBeInstanceOf(Uint8Array)
    expect(Array.from(calls[0].init.body as Uint8Array)).toEqual([1, 2, 3])
  })

  it('carries seq and generation as query parameters', async () => {
    const { client, calls } = clientWith(() => jsonRes({ status: 'success', seq: 4, sha256: 'cd' }, 201))
    await client.append(DEVICE, 3, 4, 'prevsha', [9])

    expect(calls[0].url).toContain('seq=4')
    expect(calls[0].url).toContain('generation=3')
    expect(calls[0].url).toContain('prevSha256=prevsha')
  })

  it('omits prevSha256 for the first entry in a generation', async () => {
    const { client, calls } = clientWith(() => jsonRes({ status: 'success', seq: 1, sha256: 'x' }, 201))
    await client.append(DEVICE, 1, 1, undefined, [1])

    expect(calls[0].url).not.toContain('prevSha256')
  })

  it('never sends an identity parameter on any route', async () => {
    // The server derives the account from the authenticated session alone. Sending an
    // identity would invite the cross-tenant bug this design exists to avoid — there is
    // deliberately no field for one.
    const { client, calls } = clientWith(() => jsonRes({ status: 'success', devices: [], entries: [] }))
    await client.manifest()
    await client.index(DEVICE, 1)

    for (const call of calls) {
      expect(call.url).not.toMatch(/identity|pseudonym|pubkey|account/i)
      expect(call.init.body).toBeUndefined()
    }
  })

  it('surfaces a sequence conflict with its code', async () => {
    const { client } = clientWith(() =>
      jsonRes({ status: 'error', code: ERR_SEQ_CONFLICT, description: 'expected seq 5, got 9' }, 409))

    await expect(client.append(DEVICE, 1, 9, undefined, [1])).rejects.toThrow(/ERR_SEQ_CONFLICT/)
    await expect(client.append(DEVICE, 1, 9, undefined, [1])).rejects.toBeInstanceOf(BackupHttpError)
  })

  it('exposes the status and code on errors', async () => {
    const { client } = clientWith(() =>
      jsonRes({ status: 'error', code: 'ERR_BLOB_TOO_LARGE', description: 'too big' }, 413))

    await expect(client.append(DEVICE, 1, 1, undefined, [1])).rejects.toMatchObject({
      status: 413, code: 'ERR_BLOB_TOO_LARGE'
    })
  })

  it('returns blob bytes as number[]', async () => {
    const { client } = clientWith(() => new Response(new Uint8Array([9, 8, 7]), { status: 200 }))
    expect(await client.blob(DEVICE, 1, 1)).toEqual([9, 8, 7])
  })

  it('treats a missing blob as an error, not empty bytes', async () => {
    // Silently returning [] would let a restore believe it had finished early.
    const { client } = clientWith(() =>
      jsonRes({ status: 'error', code: 'ERR_BLOB_NOT_FOUND', description: 'no such blob' }, 404))

    await expect(client.blob(DEVICE, 1, 5)).rejects.toMatchObject({ code: 'ERR_BLOB_NOT_FOUND' })
  })

  it('defaults absent collections to empty arrays', async () => {
    const { client } = clientWith(() => jsonRes({ status: 'success' }))
    expect(await client.manifest()).toEqual([])
    expect(await client.index(DEVICE, 1)).toEqual([])
  })

  it('parses a manifest', async () => {
    const { client } = clientWith(() => jsonRes({
      status: 'success',
      devices: [{
        deviceId: DEVICE, generation: 2, headSeq: 7,
        headSha256: 'abc', totalBytes: 1024, updatedAt: '2026-08-15T00:00:00Z'
      }]
    }))

    const [d] = await client.manifest()
    expect(d.deviceId).toBe(DEVICE)
    expect(d.generation).toBe(2)
    expect(d.headSeq).toBe(7)
  })

  it('handles a non-JSON error body without masking the status', async () => {
    const { client } = clientWith(() => new Response('<html>502</html>', { status: 502 }))
    await expect(client.manifest()).rejects.toMatchObject({ status: 502 })
  })
})

describe('BackupClient request timeout', () => {
  it('gives up on a request that never answers, instead of hanging the task forever', async () => {
    // A monitor task awaiting a dead socket stays pending indefinitely, holding its slot
    // and never rescheduling. Observed on device as BackupPush passes running past 100s.
    jest.useFakeTimers()
    try {
      const client = new BackupClient(BASE, KEY, async () => await new Promise<Response>(() => {}))
      const pending = client.manifest()
      const assertion = expect(pending).rejects.toThrow(/timed out/i)
      await jest.advanceTimersByTimeAsync(BACKUP_REQUEST_TIMEOUT_MS + 1_000)
      await assertion
    } finally {
      jest.useRealTimers()
    }
  })
})

// AuthFetch never returns a Response for an oversize rejection: the server's size guard
// runs BEFORE the auth middleware and refuses to read the body, so the 413 it sends cannot
// be signed. AuthFetch therefore THROWS, and its message blames missing auth headers even
// though authentication was never the problem. Branch on the status and envelope code it
// carries in `details`, never on that message text.
describe('BackupClient oversize rejection', () => {
  const authFetchStyleError = (): Error =>
    Object.assign(
      new Error(
        'Received HTTP 413 Request Entity Too Large from https://backup.test/v1/log/x ' +
          'without valid BSV authentication (missing headers: x-bsv-auth-version, ' +
          'x-bsv-auth-identity-key, x-bsv-auth-signature)'
      ),
      {
        details: {
          status: 413,
          bodyPreview:
            '{"status":"error","code":"ERR_BLOB_TOO_LARGE","description":"Blob exceeds the ' +
            'maximum permitted size of 104857600 bytes. GET /v1/limits reports the current cap."}'
        }
      }
    )

  it('reports an oversize rejection as such, not as an auth failure', async () => {
    const client = new BackupClient(BASE, KEY, async () => { throw authFetchStyleError() })

    await expect(client.manifest()).rejects.toMatchObject({
      name: 'BackupHttpError',
      status: 413,
      code: ERR_BLOB_TOO_LARGE
    })
  })

  it('leaves unrelated transport failures alone', async () => {
    const client = new BackupClient(BASE, KEY, async () => { throw new Error('socket hang up') })
    await expect(client.manifest()).rejects.toThrow('socket hang up')
  })
})
