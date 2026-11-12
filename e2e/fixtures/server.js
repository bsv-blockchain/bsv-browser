/**
 * Loopback site used by the Maestro flows.
 *
 *   node e2e/fixtures/server.js
 *   E2E_FIXTURE_PORT=8787 node e2e/fixtures/server.js
 *
 * Binds every interface so an Android emulator can reach it through
 * `adb reverse tcp:8787 tcp:8787` (the app still uses 127.0.0.1).
 */

const http = require('http')
const { handle } = require('./handler')

const port = Number(process.env.E2E_FIXTURE_PORT || 8787)
const host = process.env.E2E_FIXTURE_HOST || '0.0.0.0'

const server = http.createServer((req, res) => {
  try {
    handle(req, res)
  } catch (error) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(error instanceof Error ? error.message : 'fixture error')
  }
})

server.listen(port, host, () => {
  console.log(`[e2e] fixture http://127.0.0.1:${port}`)
})
