import { handle, SATS_ABOVE_AUTO_APPROVE, SERVER_IDENTITY } from '../../e2e/fixtures/handler'

function request(path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: Record<string, string>; body: string }>(resolve => {
    const req = { url: path, headers }
    let status = 0
    let responseHeaders: Record<string, string> = {}
    const res = {
      writeHead(code: number, hdrs?: Record<string, string>) {
        status = code
        responseHeaders = hdrs || {}
        return res
      },
      end(body?: string | Buffer) {
        const text = body == null ? '' : Buffer.isBuffer(body) ? body.toString('utf8') : String(body)
        resolve({ status, headers: responseHeaders, body: text })
        return res
      }
    }
    handle(req as never, res as never)
  })
}

describe('e2e fixture handler', () => {
  it('serves the home page and a health check', async () => {
    const health = await request('/health')
    expect(health.status).toBe(200)
    expect(health.body).toBe('ok')

    const home = await request('/')
    expect(home.status).toBe(200)
    expect(home.body).toContain('E2E Home')
    expect(home.body).toContain("e2e('page:'")
  })

  it('answers 402 with a payment challenge and 200 once payment headers arrive', async () => {
    const unpaid = await request('/paid')
    expect(unpaid.status).toBe(402)
    expect(unpaid.headers['x-bsv-sats']).toBe(SATS_ABOVE_AUTO_APPROVE)
    expect(Number(SATS_ABOVE_AUTO_APPROVE)).toBeGreaterThan(100_000)
    expect(unpaid.headers['x-bsv-server']).toBe(SERVER_IDENTITY)

    const paid = await request('/paid', { 'x-bsv-sender': SERVER_IDENTITY, 'x-bsv-beef': 'aaaa' })
    expect(paid.status).toBe(200)
    expect(paid.body).toContain('Paid content')
  })

  it('refuses every arcade broadcast', async () => {
    const arc = await request('/arc/v1/tx')
    expect(arc.status).toBe(403)
    expect(arc.body).toContain('refuses to broadcast')
  })

  it('serves the wallet prompt pages', async () => {
    for (const path of ['/protocol', '/certificate', '/spend', '/camera', '/article', '/deeplink']) {
      const response = await request(path)
      expect(response.status).toBe(200)
      expect(response.body).toContain('function e2e')
    }
  })
})
