import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { normalizeWalletByteFields, stringifyWalletPayload } from '../utils/webview/walletByteJson'

const mangled = (bytes: number[]) => JSON.parse(JSON.stringify(new Uint8Array(bytes)))

describe('WebView wallet byte JSON compatibility', () => {
  it('keeps both directions of the CWI bridge on the compatibility boundary', () => {
    // Outbound now flows through buildWalletResponseScript (the master refactor
    // that replaced getInjectableJSMessage); inbound stays at the parse site.
    const index = readFileSync(resolve(process.cwd(), 'app/index.tsx'), 'utf8')
    const response = readFileSync(resolve(process.cwd(), 'utils/webview/walletResponseScript.ts'), 'utf8')

    expect(response).toContain('const messageString = stringifyWalletPayload(message)')
    expect(index).toContain('msg = normalizeWalletByteFields(JSON.parse(eventData))')
  })

  it('keeps valid number arrays on the identity fast path', () => {
    const tx = [1, 2, 3]
    const payload = { tx }

    expect(normalizeWalletByteFields(payload)).toBe(payload)
    expect(payload.tx).toBe(tx)
  })

  it('serializes nested typed arrays and subclasses as portable arrays', () => {
    class ForeignBytes extends Uint8Array {}
    const json = stringifyWalletPayload({
      signableTransaction: { tx: new ForeignBytes([1, 2, 3]) },
      encrypted: new Uint8Array([4, 5])
    })

    expect(JSON.parse(json)).toEqual({
      signableTransaction: { tx: [1, 2, 3] },
      encrypted: [4, 5]
    })
  })

  it('repairs historical numeric-key arguments recursively', () => {
    const payload = {
      inputBEEF: mangled([1, 2]),
      nested: { transaction: mangled([3, 4]) }
    }

    expect(normalizeWalletByteFields(payload)).toEqual({
      inputBEEF: [1, 2],
      nested: { transaction: [3, 4] }
    })
  })

  it('repairs historical numeric-key wallet results while serializing', () => {
    expect(JSON.parse(stringifyWalletPayload({ tx: mangled([5, 6]) }))).toEqual({
      tx: [5, 6]
    })
  })

  it('preserves unrelated numeric records and ambiguous empty containers', () => {
    const unrelated = mangled([9, 8])
    const payload = {
      unrelated,
      data: {},
      payload: { transaction: mangled([1, 2, 3]) }
    }

    expect(normalizeWalletByteFields(payload)).toEqual({
      unrelated,
      data: {},
      payload: { transaction: [1, 2, 3] }
    })
  })

  it('leaves malformed byte records intact so validation fails instead of truncating', () => {
    const malformed = { 0: 1, 2: 3 }
    const outOfRange = { 0: 256 }
    const payload = { tx: malformed, signature: outOfRange }

    normalizeWalletByteFields(payload)
    expect(payload.tx).toBe(malformed)
    expect(payload.signature).toBe(outOfRange)
  })

  it('does not mistake other binary views for empty byte arrays', () => {
    const view = new DataView(new ArrayBuffer(4))
    const buffer = new ArrayBuffer(4)
    const payload = { tx: view, signature: buffer }

    normalizeWalletByteFields(payload)
    expect(payload.tx).toBe(view)
    expect(payload.signature).toBe(buffer)
  })
})
