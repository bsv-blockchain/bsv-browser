/**
 * HTTP client for the encrypted backup log.
 *
 * Authenticates over BRC-103/104 as the backup pseudonym rather than the wallet's identity
 * key, so the server never learns who the user is. There is deliberately no identity
 * parameter on any request — the server derives the account from the authenticated session
 * and nothing else, which is what makes it impossible to address someone else's log.
 */
import { AuthFetch } from '@bsv/sdk'
import { deriveBackupWallet } from './derive'

export interface LogEntry {
  seq: number
  sha256: string
  prevSha256?: string
  size: number
  createdAt: string
}

export interface DeviceSummary {
  deviceId: string
  generation: number
  headSeq: number
  headSha256: string
  totalBytes: number
  updatedAt: string
}

/** Thrown when the server rejects a request; `code` is the ERR_* envelope code. */
export class BackupHttpError extends Error {
  constructor (readonly status: number, readonly code: string, description: string) {
    super(`${code}: ${description}`)
    this.name = 'BackupHttpError'
  }
}

/** The server's sequence-conflict code. Callers resynchronise rather than retrying. */
export const ERR_SEQ_CONFLICT = 'ERR_SEQ_CONFLICT'

/** The server's oversize code, from a 413 the size guard sends before auth runs. */
export const ERR_BLOB_TOO_LARGE = 'ERR_BLOB_TOO_LARGE'

/**
 * Transport shape.
 *
 * Narrower than RequestInit on purpose: AuthFetch accepts SimplifiedFetchRequestOptions,
 * whose headers must be a plain record rather than the full HeadersInit union.
 */
export interface BackupRequestInit {
  method: string
  headers?: Record<string, string>
  body?: Uint8Array
}

type FetchLike = (url: string, init: BackupRequestInit) => Promise<Response>

/**
 * Ceiling on any single backup request.
 *
 * The monitor awaits its tasks, so a request that never answers holds the task pending
 * indefinitely — observed on device as BackupPush passes running past 100 seconds. A
 * backup is never urgent: giving up and retrying on the next pass is strictly better than
 * occupying the monitor.
 */
export const BACKUP_REQUEST_TIMEOUT_MS = 30_000

export class BackupClient {
  private readonly fetcher: FetchLike

  /**
   * @param baseUrl origin of the backup service. The auth handshake targets the origin
   *   root, so this must not carry a path prefix.
   * @param primaryKey the wallet's m/0'/0' key, from which the pseudonym is derived.
   * @param fetcher injectable transport; defaults to AuthFetch under the backup identity.
   */
  constructor (
    private readonly baseUrl: string,
    primaryKey: number[],
    fetcher?: FetchLike
  ) {
    const transport: FetchLike =
      fetcher ??
      (() => {
        const auth = new AuthFetch(deriveBackupWallet(primaryKey))
        return async (url, init) => await auth.fetch(url, init)
      })()

    // Every request, injected transport included, is bounded. AuthFetch performs its own
    // handshake round-trip before the real call, so "no response" can occur at two points;
    // this covers both.
    this.fetcher = async (url, init) => await withTimeout(asBackupError(transport(url, init)), url)
  }

  /**
   * Append a chunk.
   *
   * The body is raw binary. This requires @bsv/sdk 2.4.0: on 2.1.9 AuthFetch tested
   * `typeof body === 'object'` ahead of its binary branches, so a Uint8Array body was
   * JSON-stringified into {"0":12,...}.
   */
  async append (
    deviceId: string,
    generation: number,
    seq: number,
    prevSha256: string | undefined,
    ciphertext: number[]
  ): Promise<{ seq: number, sha256: string }> {
    const q = new URLSearchParams({
      seq: String(seq),
      generation: String(generation)
    })
    if (prevSha256 != null && prevSha256 !== '') q.set('prevSha256', prevSha256)

    const res = await this.fetcher(`${this.baseUrl}/v1/log/${deviceId}?${q.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(ciphertext)
    })
    const body = await this.json(res)
    return { seq: body.seq as number, sha256: body.sha256 as string }
  }

  /** List entry metadata for one generation. */
  async index (deviceId: string, generation: number, from = 1): Promise<LogEntry[]> {
    const q = new URLSearchParams({ generation: String(generation), from: String(from) })
    const res = await this.fetcher(`${this.baseUrl}/v1/log/${deviceId}?${q.toString()}`, {
      method: 'GET'
    })
    const body = await this.json(res)
    return (body.entries ?? []) as LogEntry[]
  }

  /** Fetch one blob's ciphertext. Raw binary on the way back needs no special handling. */
  async blob (deviceId: string, generation: number, seq: number): Promise<number[]> {
    const q = new URLSearchParams({ generation: String(generation) })
    const res = await this.fetcher(`${this.baseUrl}/v1/log/${deviceId}/${seq}?${q.toString()}`, {
      method: 'GET'
    })
    if (!res.ok) await this.throwFor(res)
    return Array.from(new Uint8Array(await res.arrayBuffer()))
  }

  /** Every device and generation belonging to this pseudonym. */
  async manifest (): Promise<DeviceSummary[]> {
    const res = await this.fetcher(`${this.baseUrl}/v1/manifest`, { method: 'GET' })
    const body = await this.json(res)
    return (body.devices ?? []) as DeviceSummary[]
  }

  /** Drop a superseded generation. The server refuses anything within its retained window. */
  async pruneGeneration (deviceId: string, generation: number): Promise<void> {
    const res = await this.fetcher(`${this.baseUrl}/v1/generation/${deviceId}/${generation}`, {
      method: 'DELETE'
    })
    if (!res.ok) await this.throwFor(res)
  }

  private async json (res: Response): Promise<Record<string, unknown>> {
    if (!res.ok) await this.throwFor(res)
    return (await res.json()) as Record<string, unknown>
  }

  private async throwFor (res: Response): Promise<never> {
    let code = 'ERR_UNKNOWN'
    let description = res.statusText
    try {
      const body = (await res.json()) as { code?: string, description?: string }
      code = body.code ?? code
      description = body.description ?? description
    } catch {
      // Non-JSON error body; the status alone has to carry the meaning.
    }
    throw new BackupHttpError(res.status, code, description)
  }
}

/**
 * Reject if a request outlives BACKUP_REQUEST_TIMEOUT_MS.
 *
 * Deliberately a race rather than an AbortController: the transport is injectable and
 * AuthFetch does not thread a signal through to its handshake, so aborting is not
 * reliably available. Losing the race abandons the in-flight promise — acceptable here
 * because the caller retries the whole pass and nothing downstream depends on the
 * abandoned result.
 */
async function withTimeout<T> (p: Promise<T>, url: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Backup request timed out after ${BACKUP_REQUEST_TIMEOUT_MS}ms: ${url}`)),
          BACKUP_REQUEST_TIMEOUT_MS
        )
        ;(timer as { unref?: () => void }).unref?.()
      })
    ])
  } finally {
    if (timer != null) clearTimeout(timer)
  }
}

/**
 * Translate AuthFetch's throw into a BackupHttpError when the server rejected on size.
 *
 * The size guard runs BEFORE the auth middleware and deliberately refuses to read the body,
 * so its 413 cannot be signed — and AuthFetch reports every unsigned response as an
 * authentication failure ("missing headers: x-bsv-auth-version, ..."). That message is
 * misleading and MUST NOT be matched on; the real cause is carried in `details.status` and
 * the ERR_ code in `details.bodyPreview`.
 *
 * Anything else is rethrown untouched: a socket failure is not an HTTP status.
 */
async function asBackupError<T> (p: Promise<T>): Promise<T> {
  try {
    return await p
  } catch (e) {
    const details = (e as { details?: { status?: number, bodyPreview?: string } })?.details
    if (details?.status == null) throw e

    let code = 'ERR_UNKNOWN'
    let description = (e as Error).message
    try {
      const body = JSON.parse(details.bodyPreview ?? '{}') as { code?: string, description?: string }
      if (body.code != null) code = body.code
      if (body.description != null) description = body.description
    } catch {
      // Body preview is truncated or absent; the status alone still beats an auth message.
    }
    throw new BackupHttpError(details.status, code, description)
  }
}
