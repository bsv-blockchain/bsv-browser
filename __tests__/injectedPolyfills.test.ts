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
