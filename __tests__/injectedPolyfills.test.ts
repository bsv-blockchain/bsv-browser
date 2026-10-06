import vm from 'vm'
import { buildInjectedJavaScript } from '@/utils/webview/injectedPolyfills'

// Runs the injected script the way the WebView does: as standalone source in a
// page-like global, with nothing from the app's module scope in reach.

type Listener = (event: { data: unknown }) => void

function page(options: { nativeFullscreen?: boolean } = {}) {
  const posted: any[] = []
  const logged: string[] = []
  const messageListeners = new Set<Listener>()
  const documentListeners: Record<string, Array<() => void>> = {}
  class Element {}
  if (options.nativeFullscreen) (Element.prototype as any).requestFullscreen = () => Promise.resolve()
  const documentElement = new Element()
  const document = {
    documentElement,
    dispatchEvent: (event: { type: string }) => (documentListeners[event.type] ?? []).forEach(fn => fn()),
    addEventListener: (type: string, fn: () => void) => {
      ;(documentListeners[type] ??= []).push(fn)
    }
  }
  const console = {
    log: (...args: unknown[]) => logged.push(`log ${args.join(' ')}`),
    warn: (...args: unknown[]) => logged.push(`warn ${args.join(' ')}`),
    error: (...args: unknown[]) => logged.push(`error ${args.join(' ')}`),
    info: (...args: unknown[]) => logged.push(`info ${args.join(' ')}`),
    debug: (...args: unknown[]) => logged.push(`debug ${args.join(' ')}`)
  }
  const window: any = {
    document,
    console,
    Element,
    Event: class {
      constructor(public type: string) {}
    },
    Promise,
    JSON,
    Array,
    Object,
    TypeError,
    ReactNativeWebView: { postMessage: (message: string) => posted.push(JSON.parse(message)) },
    addEventListener: (type: string, fn: Listener) => type === 'message' && messageListeners.add(fn),
    removeEventListener: (type: string, fn: Listener) => type === 'message' && messageListeners.delete(fn)
  }
  window.window = window
  const context = vm.createContext(window)
  const deliver = (data: unknown) => Array.from(messageListeners).forEach(fn => fn({ data }))
  return { context, window, posted, logged, deliver, messageListeners }
}

function inject(target: ReturnType<typeof page>, options: { isDev: boolean; forwardConsoleLogs: boolean }) {
  new vm.Script(buildInjectedJavaScript(options)).runInContext(target.context)
}

describe('WebView injected script', () => {
  it('runs to completion as standalone source', () => {
    const target = page()
    expect(() => inject(target, { isDev: false, forwardConsoleLogs: true })).not.toThrow()
    expect(() => inject(page(), { isDev: true, forwardConsoleLogs: false })).not.toThrow()
  })

  // The previous version injected a serialized function. Node returns real
  // source from Function.prototype.toString, but Hermes (the app's engine, dev
  // and release) returns "function … { [bytecode] }", so that script never ran.
  // Build the script as Hermes would see it.
  it('still runs when functions stringify the way Hermes bytecode does', () => {
    const toString = Function.prototype.toString
    let script: string
    Function.prototype.toString = function () {
      return `function ${this.name}() { [bytecode] }`
    }
    try {
      script = buildInjectedJavaScript({ isDev: false, forwardConsoleLogs: true })
    } finally {
      Function.prototype.toString = toString
    }
    expect(script).not.toContain('[bytecode]')
    const target = page()
    expect(() => new vm.Script(script).runInContext(target.context)).not.toThrow()
    expect(target.window.__consolePatched).toBe(true)
  })

  it('leaves the page console alone unless forwarding is on', () => {
    const target = page()
    const original = target.window.console.log
    inject(target, { isDev: true, forwardConsoleLogs: false })
    target.window.console.warn('careful')
    expect(target.window.console.log).toBe(original)
    expect(target.window.__consolePatched).toBeUndefined()
    expect(target.posted).toEqual([])
  })

  it('relays console calls when forwarding is on, sampling console.log outside dev builds', () => {
    const target = page()
    inject(target, { isDev: false, forwardConsoleLogs: true })
    for (let i = 1; i <= 10; i++) target.window.console.log('tick', i)
    target.window.console.warn('careful')
    target.window.console.error('broken')
    target.window.console.info('detail')

    expect(target.logged).toHaveLength(13)
    expect(target.posted).toEqual([
      { type: 'CONSOLE', method: 'log', args: ['tick', 10] },
      { type: 'CONSOLE', method: 'warn', args: ['careful'] },
      { type: 'CONSOLE', method: 'error', args: ['broken'] }
    ])
    expect(target.window.__consolePatched).toBe(true)
  })

  it('relays every console call in dev builds', () => {
    const target = page()
    inject(target, { isDev: true, forwardConsoleLogs: true })
    target.window.console.log('one')
    target.window.console.debug('two')
    expect(target.posted.map(m => m.method)).toEqual(['log', 'debug'])
  })

  it('does not wrap the console twice when injected again', () => {
    const target = page()
    inject(target, { isDev: true, forwardConsoleLogs: true })
    inject(target, { isDev: true, forwardConsoleLogs: true })
    target.window.console.warn('once')
    expect(target.posted).toEqual([{ type: 'CONSOLE', method: 'warn', args: ['once'] }])
  })

  it('routes requestFullscreen through the app and reports the requesting element', async () => {
    const target = page()
    inject(target, { isDev: false, forwardConsoleLogs: false })
    const video = new target.window.Element()
    let changes = 0
    target.window.document.addEventListener('fullscreenchange', () => changes++)

    const request = video.requestFullscreen()
    expect(target.posted).toEqual([{ type: 'REQUEST_FULLSCREEN' }])
    // What messageRouter.ts injects when the app enters fullscreen.
    target.deliver(JSON.stringify({ type: 'FULLSCREEN_RESPONSE', success: true }))
    target.deliver(JSON.stringify({ type: 'FULLSCREEN_CHANGE', isFullscreen: true }))
    await expect(request).resolves.toBeUndefined()
    expect(target.window.document.fullscreenElement).toBe(video)
    expect(target.window.document.fullscreenEnabled).toBe(true)
    expect(changes).toBe(1)

    const exit = target.window.document.exitFullscreen()
    expect(target.posted[1]).toEqual({ type: 'EXIT_FULLSCREEN' })
    target.deliver(JSON.stringify({ type: 'FULLSCREEN_RESPONSE', success: true }))
    target.deliver(JSON.stringify({ type: 'FULLSCREEN_CHANGE', isFullscreen: false }))
    await expect(exit).resolves.toBeUndefined()
    expect(target.window.document.fullscreenElement).toBeNull()
    expect(changes).toBe(2)
  })

  it('rejects requestFullscreen when the app declines', async () => {
    const target = page()
    inject(target, { isDev: false, forwardConsoleLogs: false })
    const request = target.window.document.documentElement.requestFullscreen()
    target.deliver(JSON.stringify({ type: 'FULLSCREEN_RESPONSE', success: false }))
    await expect(request).rejects.toThrow('Fullscreen request denied')
    expect(target.messageListeners.size).toBe(1)
  })

  it('ignores page messages that are not JSON strings', () => {
    const target = page()
    inject(target, { isDev: false, forwardConsoleLogs: false })
    expect(() => {
      target.deliver({ type: 'FULLSCREEN_CHANGE', isFullscreen: true })
      target.deliver('not json')
    }).not.toThrow()
    expect(target.window.document.fullscreenElement).toBeNull()
  })

  it('keeps a native Fullscreen API untouched', () => {
    const target = page({ nativeFullscreen: true })
    const native = target.window.Element.prototype.requestFullscreen
    inject(target, { isDev: false, forwardConsoleLogs: false })
    expect(target.window.Element.prototype.requestFullscreen).toBe(native)
    expect(target.window.document.exitFullscreen).toBeUndefined()
  })
})
