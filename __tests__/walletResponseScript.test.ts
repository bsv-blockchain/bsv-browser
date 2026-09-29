import {
  buildSerializedWalletResponseScript,
  buildWalletResponseScript,
  serializeWalletResponse
} from '@/utils/webview/walletResponseScript'

describe('buildWalletResponseScript', () => {
  it('posts a wallet response back to a direct embedded frame', () => {
    const child = { postMessage: jest.fn() }
    const topDocument = {
      location: { origin: 'https://babbageos.com' },
      frames: [child],
      dispatchEvent: jest.fn()
    }
    const message = { type: 'CWI', id: 'request-1', status: 'success', result: { version: '1.0.0' } }

    Function('window', buildWalletResponseScript(message, 'https://convo.babbage.systems'))(topDocument)

    expect(child.postMessage).toHaveBeenCalledWith(JSON.stringify(message), 'https://convo.babbage.systems')
    expect(topDocument.dispatchEvent).not.toHaveBeenCalled()
  })

  it('delivers a same-origin response to the top document and matching child frames', () => {
    const child = { postMessage: jest.fn() }
    const topDocument = {
      location: { origin: 'https://peerpay.babbage.systems' },
      frames: [child],
      dispatchEvent: jest.fn()
    }
    const message = { type: 'CWI', id: 'request-2', status: 'success', result: { publicKey: '02ab' } }

    Function('window', buildWalletResponseScript(message, 'https://peerpay.babbage.systems'))(topDocument)

    expect(topDocument.dispatchEvent).toHaveBeenCalledTimes(1)
    const event = topDocument.dispatchEvent.mock.calls[0][0] as MessageEvent
    expect(event.data).toBe(JSON.stringify(message))
    expect(child.postMessage).toHaveBeenCalledWith(JSON.stringify(message), 'https://peerpay.babbage.systems')
  })

  it('accepts an already-serialized response', () => {
    const child = { postMessage: jest.fn() }
    const topDocument = {
      location: { origin: 'https://babbageos.com' },
      frames: [child],
      dispatchEvent: jest.fn()
    }
    const serialized = serializeWalletResponse({ type: 'CWI', id: 'request-3', status: 'success', result: { ok: true } })

    Function('window', buildSerializedWalletResponseScript(serialized, 'https://convo.babbage.systems'))(topDocument)

    expect(child.postMessage).toHaveBeenCalledWith(serialized, 'https://convo.babbage.systems')
  })

  it('treats a string message as a value to serialize, never as script', () => {
    const child = { postMessage: jest.fn() }
    const topDocument = {
      location: { origin: 'https://babbageos.com' },
      frames: [child],
      dispatchEvent: jest.fn()
    }
    const hostile = 'x); window.__pwned = true; ('

    Function('window', buildWalletResponseScript(hostile, 'https://convo.babbage.systems'))(topDocument)

    expect((topDocument as Record<string, unknown>).__pwned).toBeUndefined()
    expect(child.postMessage).toHaveBeenCalledWith(JSON.stringify(hostile), 'https://convo.babbage.systems')
  })
})
