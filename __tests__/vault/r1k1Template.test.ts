/**
 * Guards the patch-package fix for @bsv/templates. Hermes has no
 * DecompressionStream/ReadableStream/Blob.prototype.stream, so the template's
 * stock gzip path throws on device. Jest runs on Node where those globals DO
 * exist, so this test removes them before loading the module — without that,
 * the test passes whether or not the patch is applied.
 */
const WEB_STREAM_GLOBALS = ['DecompressionStream', 'CompressionStream', 'ReadableStream', 'TransformStream'] as const

describe('R1K1Wallet under a Hermes-like runtime', () => {
  const saved: Record<string, unknown> = {}

  beforeAll(() => {
    for (const name of WEB_STREAM_GLOBALS) {
      saved[name] = (globalThis as Record<string, unknown>)[name]
      delete (globalThis as Record<string, unknown>)[name]
    }
    jest.resetModules()
  })

  afterAll(() => {
    for (const name of WEB_STREAM_GLOBALS) {
      ;(globalThis as Record<string, unknown>)[name] = saved[name]
    }
  })

  it('locks without any web-stream global present', async () => {
    expect((globalThis as Record<string, unknown>).DecompressionStream).toBeUndefined()

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { R1K1Wallet } = require('@bsv/templates')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Hash } = require('@bsv/sdk')

    const r1Hash = Hash.hash160(new Array(65).fill(1))
    const k1Hash = Hash.hash160(new Array(33).fill(2))
    const script = await new R1K1Wallet().lock(r1Hash, k1Hash)

    expect(script.toUint8Array().length).toBe(959_632)
  })
})
