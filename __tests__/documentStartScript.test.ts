import { buildWalletDocumentStartScript } from '@/utils/webview/documentStartScript'

function execute(script: string, windowObject: Record<string, any>) {
  Function('window', script)(windowObject)
}

describe('wallet document-start script', () => {
  it('installs CWI in a child frame without applying top-document hooks', () => {
    const nativePostMessage = jest.fn()
    const frame: Record<string, any> = {
      top: {},
      webkit: { messageHandlers: { ReactNativeWebView: { postMessage: nativePostMessage } } }
    }

    execute(buildWalletDocumentStartScript('window.__mainFrameHook = true;'), frame)

    expect(typeof frame.CWI?.getVersion).toBe('function')
    expect(typeof frame.ReactNativeWebView?.postMessage).toBe('function')
    const request = JSON.stringify({ type: 'CWI', isInvocation: true, id: '1', call: 'getVersion', args: {} })
    frame.ReactNativeWebView.postMessage(request)
    expect(nativePostMessage).toHaveBeenCalledWith(request)
    frame.ReactNativeWebView.postMessage(JSON.stringify({ type: 'CAMERA_REQUEST' }))
    expect(nativePostMessage).toHaveBeenCalledTimes(1)
    expect(frame.__mainFrameHook).toBeUndefined()
  })

  it('installs CWI and the browser hooks in the top document', () => {
    const topDocument: Record<string, any> = { ReactNativeWebView: { postMessage: jest.fn() } }
    topDocument.top = topDocument

    execute(buildWalletDocumentStartScript('window.__mainFrameHook = true;'), topDocument)

    expect(typeof topDocument.CWI?.getVersion).toBe('function')
    expect(topDocument.__mainFrameHook).toBe(true)
  })
})
