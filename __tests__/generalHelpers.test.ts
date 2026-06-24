import { buildLocationHrefScript, normalizeUrlForHistory } from '@/utils/generalHelpers'

describe('buildLocationHrefScript', () => {
  // The whole point: whatever the URL, the produced script must be SYNTACTICALLY
  // VALID JS. A malformed injectJavaScript payload kills the iOS WebContent
  // process (onContentProcessDidTerminate), which reads to users as a crash.
  const adversarial = [
    'https://example.com/',
    'https://example.com/?q="quoted"&y=z',
    'https://example.com/back\\slash',
    "https://example.com/?q='single'",
    'https://example.com/path</script>',
    'https://example.com/\nnewline',
    `https://example.com/${String.fromCharCode(0x2028)}line-sep`,
    `https://example.com/${String.fromCharCode(0x2029)}para-sep`,
    'javascript:alert(1)'
  ]

  it('produces parseable JS for every adversarial URL', () => {
    for (const url of adversarial) {
      const script = buildLocationHrefScript(url)
      // Throws a SyntaxError at parse time if the URL broke out of the literal.
      expect(() => new Function(script)).not.toThrow()
    }
  })

  it('never emits a raw U+2028/U+2029 (they break JS string literals on older WebKit)', () => {
    const script = buildLocationHrefScript(`https://x.com/${String.fromCharCode(0x2028, 0x2029)}`)
    expect(script.includes(String.fromCharCode(0x2028))).toBe(false)
    expect(script.includes(String.fromCharCode(0x2029))).toBe(false)
  })

  it('maps the new-tab sentinel to about:blank', () => {
    expect(buildLocationHrefScript('about:blank')).toBe('window.location.href = "about:blank";true;')
  })

  it('round-trips a plain URL as a double-quoted literal', () => {
    expect(buildLocationHrefScript('https://example.com/')).toBe('window.location.href = "https://example.com/";true;')
  })
})

describe('normalizeUrlForHistory', () => {
  it('canonicalizes equivalent root paths', () => {
    expect(normalizeUrlForHistory('https://weather.com/.?from=launch:homescreen')).toBe(
      'https://weather.com/?from=launch:homescreen'
    )
  })

  it('canonicalizes an origin without a trailing slash', () => {
    expect(normalizeUrlForHistory('https://example.com')).toBe('https://example.com/')
  })

  it('removes transient challenge parameters while preserving other parameters', () => {
    expect(normalizeUrlForHistory('https://example.com/?keep=1&__cf_chl_tk=temporary')).toBe(
      'https://example.com/?keep=1'
    )
  })
})
