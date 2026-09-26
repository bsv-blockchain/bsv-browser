import { Beef, Transaction } from '@bsv/sdk'
import {
  createArcadeBroadcastService,
  createGorillaPoolBroadcastService,
  createTaalBroadcastService,
  createWocBroadcastService,
  handleArcResponse
} from '@bsv/expo-wallet-toolbox/core/services/arcadeBroadcastProvider'

describe('handleArcResponse', () => {
  const txids = ['abc123']

  it('treats Arcade RECEIVED (HTTP 202) as success', () => {
    const result = handleArcResponse(
      'Arcade',
      { ok: true, status: 202 },
      { txid: txids[0], txStatus: 'RECEIVED' },
      txids
    )
    expect(result.status).toBe('success')
    expect(result.txid).toBe(txids[0])
    expect(result.doubleSpend).toBeUndefined()
    expect(result.serviceError).toBeUndefined()
  })

  it.each([
    'STORED',
    'SENT_TO_NETWORK',
    'ACCEPTED_BY_NETWORK',
    'SEEN_ON_NETWORK',
    'SEEN_MULTIPLE_NODES',
    'MINED',
    'IMMUTABLE'
  ] as const)('treats %s as success when response.ok', txStatus => {
    const result = handleArcResponse('Arcade', { ok: true, status: 200 }, { txid: txids[0], txStatus }, txids)
    expect(result.status).toBe('success')
  })

  it('marks a proven double-spend attempt as doubleSpend, not just error', () => {
    const result = handleArcResponse(
      'Arcade',
      { ok: true, status: 200 },
      { txid: txids[0], txStatus: 'DOUBLE_SPEND_ATTEMPTED' },
      txids
    )
    expect(result.status).toBe('error')
    expect(result.doubleSpend).toBe(true)
  })

  // XR-062: SEEN_IN_ORPHAN_MEMPOOL means the parent hasn't propagated yet — a
  // missing/unpropagated-parent transport condition, not a proven conflict.
  // It used to be lumped in with DOUBLE_SPEND_ATTEMPTED and fed the same
  // terminal rejection cascade (offline/plan.ts applyOutcome), permanently
  // rejecting a valid chained/offline payment and releasing its reservations
  // purely from ordinary propagation timing. It must be retryable
  // (serviceError), never doubleSpend.
  it('XR-062: marks an orphan-mempool status as a retryable serviceError, not doubleSpend', () => {
    const result = handleArcResponse(
      'Arcade',
      { ok: true, status: 200 },
      { txid: txids[0], txStatus: 'SEEN_IN_ORPHAN_MEMPOOL' },
      txids
    )
    expect(result.status).toBe('error')
    expect(result.doubleSpend).not.toBe(true)
    expect(result.serviceError).toBe(true)
  })

  it('marks REJECTED and non-ok HTTP as serviceError', () => {
    const rejected = handleArcResponse(
      'Arcade',
      { ok: true, status: 200 },
      { txid: txids[0], txStatus: 'REJECTED' },
      txids
    )
    expect(rejected.status).toBe('error')
    expect(rejected.serviceError).toBe(true)

    const httpErr = handleArcResponse(
      'Arcade',
      { ok: false, status: 500 },
      { txid: txids[0], txStatus: 'RECEIVED' },
      txids
    )
    expect(httpErr.status).toBe('error')
    expect(httpErr.serviceError).toBe(true)
  })

  it('treats missing txStatus with ok response as success when the txid matches (built-in ARC parity)', () => {
    const result = handleArcResponse('TaalArc', { ok: true, status: 200 }, { txid: txids[0] }, txids)
    expect(result.status).toBe('success')
  })

  // XR-064: a custom (person-configured) ARC endpoint's success predicate was
  // `response.ok && data.txStatus !== 'REJECTED'` — with no txid match and no
  // requirement that txStatus be an explicit accepted value. An on-path
  // attacker on a person-chosen plaintext ARC endpoint (or simply a
  // misbehaving deployment) could return a bare `200 {}` and stop the
  // UntilSuccess chain right there, suppressing the real broadcast/fallback.
  it('XR-064: does NOT treat a bare 2xx body (no txStatus, no txid) as success', () => {
    const result = handleArcResponse('CustomArc', { ok: true, status: 200 }, {}, txids)
    expect(result.status).not.toBe('success')
    expect(result.serviceError).toBe(true)
  })

  it('XR-064: does not accept an unrecognized txStatus when the txid does not match either', () => {
    const result = handleArcResponse(
      'CustomArc',
      { ok: true, status: 200 },
      { txid: 'some-other-txid', txStatus: 'TOTALLY_MADE_UP' },
      txids
    )
    expect(result.status).not.toBe('success')
    expect(result.serviceError).toBe(true)
  })
})

describe('ARC-compatible factories post to the path each deployment serves', () => {
  // Arcade serves POST /tx at the root. TAAL and GorillaPool are standard ARC,
  // where POST /tx is a 404 ("no matching operation was found") and the route
  // is POST /v1/tx — probed live 2026-09-24.
  const postOne = async (factory: { service: (beef: Beef, txids: string[]) => Promise<unknown> }) => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ txid: 'ignored', txStatus: 'SEEN_ON_NETWORK' })
    })
    global.fetch = fetchMock as unknown as typeof fetch
    const tx = new Transaction()
    const beef = new Beef()
    beef.mergeTransaction(tx)
    const result = await factory.service(beef, [tx.id('hex')])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    return { url, init, result, ef: new Uint8Array(tx.toEF()) }
  }

  it('Arcade posts EF to /tx at the root', async () => {
    const { url, init, ef } = await postOne(
      createArcadeBroadcastService('https://arcade-v2-us-1.bsvblockchain.tech', 'cb-token')
    )
    expect(url).toBe('https://arcade-v2-us-1.bsvblockchain.tech/tx')
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toBe('application/octet-stream')
    expect(init.headers['X-CallbackToken']).toBe('cb-token')
    expect(Array.from(init.body)).toEqual(Array.from(ef))
  })

  it('TAAL posts EF to /v1/tx with its bearer key', async () => {
    const { url, init, ef } = await postOne(createTaalBroadcastService('https://arc.taal.com', 'taal-key'))
    expect(url).toBe('https://arc.taal.com/v1/tx')
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toBe('application/octet-stream')
    expect(init.headers.Authorization).toBe('Bearer taal-key')
    expect(Array.from(init.body)).toEqual(Array.from(ef))
  })

  it('TAAL testnet posts to /v1/tx', async () => {
    const { url } = await postOne(createTaalBroadcastService('https://arc-test.taal.com'))
    expect(url).toBe('https://arc-test.taal.com/v1/tx')
  })

  it('GorillaPool posts EF to /v1/tx', async () => {
    const { url, init, ef } = await postOne(createGorillaPoolBroadcastService('https://arc.gorillapool.io'))
    expect(url).toBe('https://arc.gorillapool.io/v1/tx')
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toBe('application/octet-stream')
    expect(Array.from(init.body)).toEqual(Array.from(ef))
  })

  it('XR-060: caps the logged response body instead of logging it in full', async () => {
    // A compromised/misbehaving ARC endpoint can return an oversized
    // txStatus/body field; logging it in full is itself unbounded memory/log
    // work on top of the JSON parse. The classification logic is untouched —
    // only what reaches console.log is capped. Kept well under
    // MAX_BROADCAST_BODY_BYTES (the separate XR-060 remainder bound below) so
    // this test still exercises log truncation on a body the size bound lets
    // through.
    const hugeStatus = 'x'.repeat(100_000)
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ txid: 'abc', txStatus: hugeStatus })
    }) as unknown as typeof fetch
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    const tx = new Transaction()
    const beef = new Beef()
    beef.mergeTransaction(tx)
    const { service } = createTaalBroadcastService('https://arc.taal.com', 'key')
    await service(beef, [tx.id('hex')])
    const [, loggedSnippet] = logSpy.mock.calls[0] as [string, string]
    expect(loggedSnippet.length).toBeLessThan(hugeStatus.length)
    logSpy.mockRestore()
  })
})

describe('createWocBroadcastService classification', () => {
  // createWocBroadcastService returns { name, service(beef, txids) } —
  // services/arcadeBroadcastProvider.ts:141-155. It reads the LAST tx out of
  // the beef and POSTs its raw hex, so a minimal empty transaction suffices.
  const postOne = async (status: number, body: string) => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      text: async () => body
    }) as unknown as typeof fetch
    const tx = new Transaction()
    const beef = new Beef()
    beef.mergeTransaction(tx)
    const { service } = createWocBroadcastService('main')
    return service(beef, [tx.id('hex')])
  }

  it('keeps "already in the mempool" as success (same-txid idempotent rebroadcast)', async () => {
    const r = await postOne(422, 'unexpected response code 500: 257: txn-already-in-mempool already in the mempool')
    expect(r.txidResults[0].status).toBe('success')
    expect(r.txidResults[0].doubleSpend).toBeUndefined()
  })

  it('classifies "Missing inputs" as a retryable serviceError, never doubleSpend', async () => {
    const r = await postOne(422, 'unexpected response code 500: Missing inputs')
    expect(r.txidResults[0].doubleSpend).toBeUndefined()
    expect(r.txidResults[0].serviceError).toBe(true)
  })

  it('classifies "mempool-conflict" as a retryable serviceError, never doubleSpend', async () => {
    const r = await postOne(422, '258: txn-mempool-conflict')
    expect(r.txidResults[0].doubleSpend).toBeUndefined()
    expect(r.txidResults[0].serviceError).toBe(true)
  })

  it('XR-060: caps the logged response body instead of logging it in full', async () => {
    // Kept well under MAX_BROADCAST_BODY_BYTES (see below) so this still
    // exercises log truncation on a body the size bound lets through.
    const hugeBody = 'z'.repeat(100_000)
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    const r = await postOne(500, hugeBody)
    // Classification still runs over the full body — only the log is capped.
    expect(r.txidResults[0].serviceError).toBe(true)
    const [, loggedSnippet] = logSpy.mock.calls[0] as [string, string]
    expect(loggedSnippet.length).toBeLessThan(hugeBody.length)
    logSpy.mockRestore()
  })
})

/**
 * XR-060 remainder: XR-063's fetchWithBodyDeadline bounds how long a stalled
 * body can hang, but until now nothing bounded how LARGE a body that does
 * arrive can be before it is fully parsed/buffered — a compromised or
 * misbehaving endpoint could still force an unbounded JSON parse or string
 * allocation over a multi-megabyte response, exactly the gap XR-060's
 * original triage flagged and its first pass (commit f7c12255) deliberately
 * left open pending this fix. Mirrors
 * core/identity/handleRegistry/resolver.ts's XR-077/SEC2-027 byte cap: a
 * declared Content-Length over the cap is refused before anything is read,
 * and a streamed body is aborted the instant it crosses the cap — falling
 * back to a post-hoc size check only when the runtime (or a test double)
 * exposes no stream to count from. Either path fails to the ordinary
 * retryable serviceError outcome, never success.
 */
describe('XR-060 remainder: bounds the broadcast body size itself, not just what gets logged', () => {
  it('Arcade (ARC): an oversized parsed body is rejected as serviceError, never success', async () => {
    // No response.body stream in this mock, so the fallback path applies:
    // the original json() is still called (a real runtime with no stream
    // support is the "floor, not a firewall" case), but its result is
    // rejected once its size is over the cap, before handleArcResponse ever
    // sees it as a would-be RECEIVED/success.
    const hugePayload = { txid: 'abc123', txStatus: 'RECEIVED', junk: 'x'.repeat(3_000_000) }
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => hugePayload
    }) as unknown as typeof fetch
    const tx = new Transaction()
    const beef = new Beef()
    beef.mergeTransaction(tx)
    const { service } = createArcadeBroadcastService('https://arcade-v2-us-1.bsvblockchain.tech', 'cb-token')
    const result = await service(beef, [tx.id('hex')])
    expect(result.status).not.toBe('success')
    expect(result.txidResults[0].serviceError).toBe(true)
    expect(result.txidResults[0].doubleSpend).toBeUndefined()
  })

  // Deliberately does NOT rely on the body ever failing to resolve (that is
  // XR-063's job, already covered below) — this stream resolves fully and
  // quickly, just with far more bytes than any real WoC reply. Pre-fix,
  // nothing stops that from completing and being classified as an ordinary
  // response.ok success; only a byte cap catches it.
  it('WhatsOnChain: a streamed body is aborted the instant it crosses the byte cap, never buffered whole', async () => {
    const chunk = new Uint8Array(256 * 1024).fill(0x7a) // 256 KiB of 'z' per pull
    let pulls = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        controller.enqueue(chunk)
        // Safety valve only, well above the ~4-chunk cap — the fix must stop
        // long before this; the unfixed code relies on it to finish at all.
        if (pulls > 100) controller.close()
      }
    })
    // A stand-in for what a real Response.text() does: drain the same
    // underlying stream and decode it. The unfixed code calls this directly
    // with no cap, so it happily returns the full ~25 MB body.
    const readStreamAsText = async (): Promise<string> => {
      const reader = stream.getReader()
      const parts: Uint8Array[] = []
      let total = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          parts.push(value)
          total += value.byteLength
        }
      }
      const merged = new Uint8Array(total)
      let offset = 0
      for (const part of parts) {
        merged.set(part, offset)
        offset += part.byteLength
      }
      return new TextDecoder().decode(merged)
    }
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: readStreamAsText,
      body: stream
    }) as unknown as typeof fetch
    const tx = new Transaction()
    const beef = new Beef()
    beef.mergeTransaction(tx)
    const { service } = createWocBroadcastService('main')
    const result = await service(beef, [tx.id('hex')])
    expect(result.status).not.toBe('success')
    expect(result.txidResults[0].serviceError).toBe(true)
    // MAX_BROADCAST_BODY_BYTES is 1,000,000; four 256 KiB chunks already
    // crosses it, so a bounded read must stop within a handful of chunks
    // rather than draining all 100+.
    expect(pulls).toBeLessThan(10)
  })

  it('WhatsOnChain: a declared Content-Length over the cap is refused before reading anything', async () => {
    const read = jest.fn()
    const body = { getReader: () => ({ read, cancel: jest.fn() }) }
    // If this were ever reached, it would read as an ordinary small success
    // body — proving the rejection came from the declared length, not from
    // the content itself.
    const textSpy = jest.fn(async () => '')
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: (h: string) => (h.toLowerCase() === 'content-length' ? '99999999' : null) },
      text: textSpy,
      body
    }) as unknown as typeof fetch
    const tx = new Transaction()
    const beef = new Beef()
    beef.mergeTransaction(tx)
    const { service } = createWocBroadcastService('main')
    const result = await service(beef, [tx.id('hex')])
    expect(result.status).not.toBe('success')
    expect(result.txidResults[0].serviceError).toBe(true)
    expect(read).not.toHaveBeenCalled()
    expect(textSpy).not.toHaveBeenCalled()
  })
})

/**
 * XR-063: a broadcast provider that returns headers within the deadline and
 * then stalls its body used to hold the whole `service()` promise open
 * forever — the AbortController's timer was cleared as soon as fetch()
 * resolved, before response.json()/text() ever ran. Since this provider sits
 * first in the UntilSuccess fallback chain, a stall here blocked every later
 * fallback (Taal, GorillaPool, WoC) from ever being tried.
 */
describe('XR-063: a stalled body converts to a serviceError instead of hanging forever', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  const txOf = () => {
    const tx = new Transaction()
    const beef = new Beef()
    beef.mergeTransaction(tx)
    return { tx, beef }
  }

  it('Arcade (ARC) resolves with a serviceError rather than hanging when .json() never resolves', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => new Promise(() => {})
    }) as unknown as typeof fetch
    const { tx, beef } = txOf()
    const { service } = createArcadeBroadcastService('https://arcade-v2-us-1.bsvblockchain.tech', 'cb-token')

    const pending = service(beef, [tx.id('hex')])
    await jest.advanceTimersByTimeAsync(30_000)
    const result = await pending

    expect(result.status).toBe('error')
    expect(result.txidResults[0].serviceError).toBe(true)
    expect(result.txidResults[0].doubleSpend).toBeUndefined()
  })

  it('WhatsOnChain resolves with a serviceError rather than hanging when .text() never resolves', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => new Promise(() => {})
    }) as unknown as typeof fetch
    const { tx, beef } = txOf()
    const { service } = createWocBroadcastService('main')

    const pending = service(beef, [tx.id('hex')])
    await jest.advanceTimersByTimeAsync(30_000)
    const result = await pending

    expect(result.status).toBe('error')
    expect(result.txidResults[0].serviceError).toBe(true)
  })
})

/**
 * XQ-011: `createWocBroadcastService`'s `chain` argument is
 * `WalletContext.tsx`'s un-normalized `walletChain` — a corrupted/garbage
 * persisted `finalConfig.network` value passes through `toWalletChain`
 * (core/config.tsx) unchanged, since that helper only special-cases the
 * literal `'teratest'` string. Every *other* consumer of that same raw value
 * (`chaintracksUrlFor`, the `backupChain` ternary that actually buckets which
 * local SQLite DB is opened, and `walletDbRegistry`'s registry key) fails
 * safe by collapsing any unrecognized chain string to a teratest/testnet
 * bucket. This one sibling switch did the opposite: its `else` branch
 * resolved an unrecognized chain string to the LIVE mainnet WhatsOnChain
 * broadcast endpoint — a live-network fetch is not itself an I3 fund-loss
 * path (the DB a corrupted build actually opens is bucketed by the
 * separately-normalized `backupChain`, so there are no real UTXOs to
 * broadcast), but resolving an untrusted/corrupted value to the most
 * privileged endpoint, rather than to the least, is the wrong fail-safe
 * direction and worth closing regardless.
 */
describe('XQ-011: createWocBroadcastService fails safe on an unrecognized chain string', () => {
  const txOf = () => {
    const tx = new Transaction()
    const beef = new Beef()
    beef.mergeTransaction(tx)
    return { tx, beef }
  }

  const urlOf = async (chain: string): Promise<string> => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => ''
    }) as unknown as typeof fetch
    const { tx, beef } = txOf()
    const { service } = createWocBroadcastService(chain)
    await service(beef, [tx.id('hex')])
    return (global.fetch as jest.Mock).mock.calls[0][0] as string
  }

  it('main -> the mainnet endpoint (positive control)', async () => {
    expect(await urlOf('main')).toMatch(/^https:\/\/api\.whatsonchain\.com\/v1\/bsv\/main/)
  })

  it('test -> the testnet endpoint (positive control)', async () => {
    expect(await urlOf('test')).toMatch(/^https:\/\/api\.whatsonchain\.com\/v1\/bsv\/test/)
  })

  it('ttn -> the teratest endpoint (positive control)', async () => {
    expect(await urlOf('ttn')).toMatch(/^https:\/\/api\.woc-ttn\.bsvblockchain\.tech\/v1\/bsv\/test/)
  })

  it('an unrecognized/corrupted chain string never resolves to the live mainnet endpoint', async () => {
    const url = await urlOf('garbage-value')
    expect(url).not.toMatch(/^https:\/\/api\.whatsonchain\.com\/v1\/bsv\/main/)
    // Matches every other sibling consumer of the same raw value: fail safe
    // to the teratest/testnet host, not a privileged mainnet one.
    expect(url).toMatch(/^https:\/\/api\.woc-ttn\.bsvblockchain\.tech\/v1\/bsv\/test/)
  })
})
