import { buildNavigationSplashScript } from '@/utils/webview/errorPages'

// Runs the injected script against a stand-in document and records, in order,
// what it does to the page.
function run(url: string) {
  const steps: string[] = []
  const location = {
    set href(value: string) {
      steps.push(`navigate ${value}`)
    }
  }
  const document = {
    open: () => steps.push('open'),
    write: (html: string) => steps.push(`write ${html.includes('class="spinner"') ? 'splash' : 'other'}`),
    close: () => steps.push('close')
  }
  Function('document', 'window', buildNavigationSplashScript(url))(document, { location })
  return steps
}

describe('address-bar navigation splash', () => {
  // WebKit's document.open() stops a pending navigation. The WebView's own
  // source load can start before this script runs, so a splash that only paints
  // would cancel that load and spin forever; it must navigate itself afterwards.
  it('paints the splash and then navigates to the target from the page', () => {
    expect(run('https://fast.brc.dev/?topic=conformance')).toEqual([
      'open',
      'write splash',
      'close',
      'navigate https://fast.brc.dev/?topic=conformance'
    ])
  })

  it('carries a URL with template, quote and line-separator characters through intact', () => {
    const url = 'https://example.com/?q=${x}`" \\'
    expect(run(url).at(-1)).toBe(`navigate ${url}`)
  })
})
