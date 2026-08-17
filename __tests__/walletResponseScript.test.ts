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
})
