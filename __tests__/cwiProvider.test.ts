import { buildCWIProviderScript } from '@/utils/webview/cwiProvider'

type Listener = (event: { data: string; source?: unknown }) => void

function installProvider(overrides: Record<string, any> = {}) {
  const listeners = new Set<Listener>()
  const postMessage = jest.fn()
  const win: Record<string, any> = {
    ReactNativeWebView: { postMessage },
    addEventListener: (type: string, listener: Listener) => {
      if (type === 'message') listeners.add(listener)
    },
    removeEventListener: (type: string, listener: Listener) => {
      if (type === 'message') listeners.delete(listener)
    },
    ...overrides
  }
  win.parent = overrides.parent ?? win
  Function('window', buildCWIProviderScript())(win)
  return { win, listeners, postMessage }
}

function reply(listeners: Set<Listener>, id: string, source: unknown) {
  const data = JSON.stringify({ type: 'CWI', id, isInvocation: false, status: 'success', result: { version: '1.0.0' } })
  for (const listener of Array.from(listeners)) listener({ data, source })
}

describe('window.CWI provider', () => {
  it('ignores a response from a foreign browsing context and still resolves the genuine one', async () => {
    const { win, listeners, postMessage } = installProvider()
    const pending = win.CWI.getVersion({})
    const { id } = JSON.parse(postMessage.mock.calls[0][0])
    reply(listeners, id, { name: 'hostile-frame' })
    expect(listeners.size).toBe(1)
    reply(listeners, id, null)
    await expect(pending).resolves.toEqual({ version: '1.0.0' })
    expect(listeners.size).toBe(0)
  })

  it('accepts a response relayed by the parent frame', async () => {
    const parent = { name: 'top' }
    const { win, listeners, postMessage } = installProvider({ parent })
    const pending = win.CWI.getVersion({})
    const { id } = JSON.parse(postMessage.mock.calls[0][0])
    reply(listeners, id, parent)
    await expect(pending).resolves.toEqual({ version: '1.0.0' })
  })

  it('accepts a response posted by this window', async () => {
    const { win, listeners, postMessage } = installProvider()
    const pending = win.CWI.getVersion({})
    const { id } = JSON.parse(postMessage.mock.calls[0][0])
    reply(listeners, id, win)
    await expect(pending).resolves.toEqual({ version: '1.0.0' })
  })

  it('uses cryptographically random request ids when crypto is available', async () => {
    const getRandomValues = jest.fn((bytes: Uint8Array) => {
      bytes.fill(7)
      return bytes
    })
    const { win, listeners, postMessage } = installProvider({ crypto: { getRandomValues } })
    const pending = win.CWI.getVersion({})
    expect(getRandomValues).toHaveBeenCalledTimes(1)
    const { id } = JSON.parse(postMessage.mock.calls[0][0])
    expect(id).toBe(Buffer.alloc(16, 7).toString('base64'))
    // Settle the call so its 60 s timeout does not outlive the test.
    reply(listeners, id, null)
    await expect(pending).resolves.toEqual({ version: '1.0.0' })
  })

  it('surfaces the toolbox error name as err.code when the host sends one', async () => {
    const { win, listeners, postMessage } = installProvider()
    const pending = win.CWI.createAction({})
    const { id } = JSON.parse(postMessage.mock.calls[0][0])
    const data = JSON.stringify({
      type: 'CWI',
      id,
      isInvocation: false,
      status: 'error',
      code: 7,
      name: 'WERR_INSUFFICIENT_FUNDS',
      description: 'Insufficient funds.'
    })
    for (const listener of Array.from(listeners)) listener({ data, source: null })
    await expect(pending).rejects.toMatchObject({ code: 'WERR_INSUFFICIENT_FUNDS', message: 'Insufficient funds.' })
  })

  it('keeps the numeric code when the host sends no error name', async () => {
    const { win, listeners, postMessage } = installProvider()
    const pending = win.CWI.createAction({})
    const { id } = JSON.parse(postMessage.mock.calls[0][0])
    const data = JSON.stringify({ type: 'CWI', id, isInvocation: false, status: 'error', code: 1, description: 'nope' })
    for (const listener of Array.from(listeners)) listener({ data, source: null })
    await expect(pending).rejects.toMatchObject({ code: 1, message: 'nope' })
  })
})
