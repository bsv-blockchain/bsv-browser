import { buildInjectedJavaScript } from '@/utils/webview/injectedPolyfills'

describe('WebView injected polyfills', () => {
  it('keeps normal Web2 pages on native fetch and console implementations', () => {
    const script = buildInjectedJavaScript('en-US', false, false, false, false)

    expect(script).toContain('if (enableWalletFeatures)')
    expect(script).toContain('if (forwardConsoleLogs')
    expect(script).not.toContain('THEME_COLOR')
    expect(script).toContain(', false, false);true;')
  })

  it('enables wallet interception explicitly for Web3 pages', () => {
    const script = buildInjectedJavaScript('en-US', false, false, true, false)
    expect(script).toContain(', true, false);true;')
  })
})

it('builds executable page source when Hermes hides function source', () => {
  const original = Function.prototype.toString
  try {
    Function.prototype.toString = () => 'function () { [bytecode] }'
    const script = buildInjectedJavaScript('en-US', true, false, true, false)
    expect(script).not.toContain('[bytecode]')
    expect(() => new Function(script)).not.toThrow()
  } finally { Function.prototype.toString = original }
})
