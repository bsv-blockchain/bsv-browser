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

  function installBridge(version?: string) {
    const nativePostMessage = jest.fn()
    const dispatched: { data: string }[] = []
    const topDocument: Record<string, any> = {
      ReactNativeWebView: { postMessage: nativePostMessage },
      dispatchEvent: (event: { data: string }) => {
        dispatched.push(event)
        return true
      },
      addEventListener: jest.fn(),
      removeEventListener: jest.fn()
    }
    topDocument.top = topDocument
    execute(buildWalletDocumentStartScript('', version), topDocument)
    return { topDocument, nativePostMessage, dispatched }
  }

  const probe = (id: string) =>
    JSON.stringify({ type: 'CWI', isInvocation: true, id, call: 'getVersion', args: {} })

  it('answers a getVersion probe in the page when the wallet version is known', () => {
    jest.useFakeTimers()
    try {
      const { topDocument, nativePostMessage, dispatched } = installBridge('wallet-brc100-1.0.0')
      topDocument.ReactNativeWebView.postMessage(probe('probe-1'))
      expect(nativePostMessage).not.toHaveBeenCalled()
      jest.runAllTimers()
      expect(dispatched).toHaveLength(1)
      expect(JSON.parse(dispatched[0].data)).toEqual({
        type: 'CWI',
        id: 'probe-1',
        isInvocation: false,
        status: 'success',
        result: { version: 'wallet-brc100-1.0.0' }
      })
    } finally {
      jest.useRealTimers()
    }
  })

  it('forwards every other wallet call and every non-CWI message to the native bridge', () => {
    const { topDocument, nativePostMessage, dispatched } = installBridge('wallet-brc100-1.0.0')
    const createAction = JSON.stringify({ type: 'CWI', isInvocation: true, id: 'a', call: 'createAction', args: {} })
    const response = JSON.stringify({ type: 'CWI', isInvocation: false, id: 'b', call: 'getVersion' })
    const camera = JSON.stringify({ type: 'CAMERA_REQUEST' })
    topDocument.ReactNativeWebView.postMessage(createAction)
    topDocument.ReactNativeWebView.postMessage(response)
    topDocument.ReactNativeWebView.postMessage(camera)
    expect(nativePostMessage.mock.calls.map(call => call[0])).toEqual([createAction, response, camera])
    expect(dispatched).toHaveLength(0)
  })

  it('forwards a getVersion probe to the bridge when the wallet version is unknown', () => {
    const { topDocument, nativePostMessage, dispatched } = installBridge(undefined)
    topDocument.ReactNativeWebView.postMessage(probe('probe-2'))
    expect(nativePostMessage).toHaveBeenCalledWith(probe('probe-2'))
    expect(dispatched).toHaveLength(0)
  })

  it('forwards oversized or malformed CWI strings without parsing them', () => {
    const { topDocument, nativePostMessage } = installBridge('wallet-brc100-1.0.0')
    const huge = '{"type":"CWI","isInvocation":true,"id":"x","call":"getVersion","args":{"pad":"' + 'y'.repeat(5000) + '"}}'
    const broken = '{"type":"CWI",'
    topDocument.ReactNativeWebView.postMessage(huge)
    topDocument.ReactNativeWebView.postMessage(broken)
    topDocument.ReactNativeWebView.postMessage(42 as unknown as string)
    expect(nativePostMessage.mock.calls.map(call => call[0])).toEqual([huge, broken, 42])
  })

  function installFrame(frameOrigin: string, topOrigin: string | null, nested = false) {
    const nativePostMessage = jest.fn()
    const dispatched: { data: string }[] = []
    // A cross-origin top throws on location access, as a real browser does.
    const top: Record<string, any> = {}
    Object.defineProperty(top, 'location', {
      get() {
        if (topOrigin === null) throw new Error('SecurityError')
        return { origin: topOrigin }
      }
    })
    const frame: Record<string, any> = {
      top,
      parent: nested ? {} : top,
      location: { origin: frameOrigin },
      ReactNativeWebView: { postMessage: nativePostMessage },
      dispatchEvent: (event: { data: string }) => {
        dispatched.push(event)
        return true
      },
      addEventListener: jest.fn(),
      removeEventListener: jest.fn()
    }
    execute(buildWalletDocumentStartScript('', 'wallet-brc100-1.0.0'), frame)
    return { frame, nativePostMessage, dispatched }
  }

  it('answers getVersion in a same-origin frame directly under the top document', () => {
    jest.useFakeTimers()
    try {
      const { frame, nativePostMessage, dispatched } = installFrame('https://app.example', 'https://app.example')
      frame.ReactNativeWebView.postMessage(probe('probe-4'))
      jest.runAllTimers()
      expect(nativePostMessage).not.toHaveBeenCalled()
      expect(dispatched).toHaveLength(1)
    } finally {
      jest.useRealTimers()
    }
  })

  it.each([
    ['a cross-origin frame', 'https://convo.babbage.systems', null, false],
    ['a same-origin frame nested below another frame', 'https://app.example', 'https://app.example', true]
  ])('leaves getVersion to the bridge in %s, where host replies cannot land', (_, frameOrigin, topOrigin, nested) => {
    const { frame, nativePostMessage, dispatched } = installFrame(frameOrigin, topOrigin, nested)
    frame.ReactNativeWebView.postMessage(probe('probe-5'))
    expect(nativePostMessage).toHaveBeenCalledWith(probe('probe-5'))
    expect(dispatched).toHaveLength(0)
  })

  it('does not install the interceptor for a version that is not 7-30 printable ASCII characters', () => {
    for (const bad of ['short', 'x'.repeat(31), 'wallet- -1.0.0', 'v1.0.0</script>' + 'x'.repeat(20)]) {
      const { topDocument, nativePostMessage } = installBridge(bad)
      topDocument.ReactNativeWebView.postMessage(probe('probe-3'))
      expect(nativePostMessage).toHaveBeenCalledWith(probe('probe-3'))
    }
  })
})
