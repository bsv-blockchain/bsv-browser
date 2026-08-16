import { buildWalletDocumentStartScript } from '@/utils/webview/documentStartScript'
import { walletFrameIdentityFromUrl } from '@/utils/webview/walletOrigin'
import { buildWalletResponseScript } from '@/utils/webview/walletResponseScript'

describe('embedded-frame wallet round trip', () => {
  it('returns a native BRC-100 response to the Convo frame', async () => {
    const listeners = new Set<(event: { data: string }) => void>()
    const nativePostMessage = jest.fn()
    const frame: Record<string, any> = {
      top: {},
      webkit: { messageHandlers: { ReactNativeWebView: { postMessage: nativePostMessage } } },
      addEventListener: (type: string, listener: (event: { data: string }) => void) => {
        if (type === 'message') listeners.add(listener)
      },
      removeEventListener: (type: string, listener: (event: { data: string }) => void) => {
        if (type === 'message') listeners.delete(listener)
      }
    }
    Function('window', buildWalletDocumentStartScript(''))(frame)

    const response = frame.CWI.getVersion({})
    const invocation = JSON.parse(nativePostMessage.mock.calls[0][0])
    const identity = walletFrameIdentityFromUrl('https://convo.babbage.systems/app')
    expect(identity?.originator).toBe('convo.babbage.systems')

    const childWindow = {
      postMessage: (data: string, targetOrigin: string) => {
        expect(targetOrigin).toBe(identity?.responseOrigin)
        for (const listener of listeners) listener({ data })
      }
    }
    const topDocument = {
      location: { origin: 'https://babbageos.com' },
      frames: [childWindow]
    }
    Function(
      'window',
      buildWalletResponseScript(
        {
          type: 'CWI',
          id: invocation.id,
          isInvocation: false,
          status: 'ok',
          result: { version: '1.0.0' }
        },
        identity?.responseOrigin
      )
    )(topDocument)

    await expect(response).resolves.toEqual({ version: '1.0.0' })
  })
})
