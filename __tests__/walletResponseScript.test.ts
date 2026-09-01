import { buildWalletResponseScript } from '@/utils/webview/walletResponseScript'

describe('buildWalletResponseScript', () => {
  it('posts a wallet response back to a direct embedded frame', () => {
    const child = { postMessage: jest.fn() }
    const topDocument = {
      location: { origin: 'https://babbageos.com' },
      frames: [child],
      dispatchEvent: jest.fn()
    }
    const message = { type: 'CWI', id: 'request-1', status: 'ok', result: { version: '1.0.0' } }

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
    const message = { type: 'CWI', id: 'request-2', status: 'ok', result: { publicKey: '02ab' } }

    Function('window', buildWalletResponseScript(message, 'https://peerpay.babbage.systems'))(topDocument)

    expect(topDocument.dispatchEvent).toHaveBeenCalledTimes(1)
    const event = topDocument.dispatchEvent.mock.calls[0][0] as MessageEvent
    expect(event.data).toBe(JSON.stringify(message))
    expect(child.postMessage).toHaveBeenCalledWith(JSON.stringify(message), 'https://peerpay.babbage.systems')
  })
})
