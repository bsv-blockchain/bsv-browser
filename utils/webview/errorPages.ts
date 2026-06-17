/**
 * Escape a string for safe embedding inside a backtick template literal that is
 * itself injected into a WebView via injectJavaScript. Backslash MUST be escaped
 * first, otherwise a trailing backslash in the input would escape our own added
 * escape char and let the payload break out of the literal. `$` is neutralized
 * so `${...}` cannot trigger interpolation.
 */
export function escapeForTemplateLiteral(input: string): string {
  return input
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$')
}

/**
 * Escape a string for safe embedding inside a single-quoted JS string that is
 * injected into a WebView. Backslash first (see above), then the quote and the
 * line terminators that would otherwise terminate the string.
 */
export function escapeForJsSingleQuote(input: string): string {
  return input
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

const baseStyle = `
<meta name="color-scheme" content="light dark">
<style>
  :root { --bg: #f5f5f0; --text: #1a1a1a; --sub: #666; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1a1a1a; --text: #e8e6e1; --sub: #999; } }
  body { font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: var(--bg); color: var(--text); text-align: center; }
  h1 { font-size: 6rem; margin: 0; }
  .subtitle { font-size: 1.5rem; margin: 8px 0; }
  .detail { color: var(--sub); }
</style>`

function errorPage(code: string, color: string, title: string, detail: string) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${code} ${title}</title>${baseStyle}</head>
<body>
  <div>
    <h1 style="color:${color};">${code}</h1>
    <p class="subtitle">${title}</p>
    <p class="detail">${detail}</p>
  </div>
</body>
</html>`
}

export const errorPages = {
  '402': errorPage('402', '#e67e22', 'Payment Required', 'Content protected, please refresh to pay.'),
  '403': errorPage('403', '#e74c3c', 'Access Forbidden', "You don't have permission to view this page."),
  '404': errorPage('404', 'var(--sub)', 'Page Not Found', 'The requested page could not be found.'),
  '500': errorPage('500', '#e74c3c', 'Server Error', 'Something went wrong on the server.')
} as const

export interface NativeErrorInfo {
  code: string
  color: string
  title: string
  detail: string
}

/** Maps iOS NSURLError codes and Android WebViewClient error constants to user-friendly info. */
const nativeErrors: Record<string, NativeErrorInfo> = {
  // DNS resolution failed
  '-1003': {
    code: 'DNS',
    color: '#999',
    title: 'Server Not Found',
    detail: "The site's address couldn't be resolved. Check the URL and try again."
  },
  '-6': {
    code: 'DNS',
    color: '#999',
    title: 'Server Not Found',
    detail: "The site's address couldn't be resolved. Check the URL and try again."
  },
  // Connection refused / cannot connect
  '-1004': {
    code: ':(',
    color: '#999',
    title: 'Connection Failed',
    detail: 'The server refused the connection. It may be offline or unreachable.'
  },
  '-2': {
    code: ':(',
    color: '#999',
    title: 'Connection Failed',
    detail: 'The server refused the connection. It may be offline or unreachable.'
  },
  // Timed out
  '-1001': {
    code: ':(',
    color: '#999',
    title: 'Connection Timed Out',
    detail: 'The server took too long to respond. Try again later.'
  },
  '-8': {
    code: ':(',
    color: '#999',
    title: 'Connection Timed Out',
    detail: 'The server took too long to respond. Try again later.'
  },
  // TLS / SSL errors
  '-1200': {
    code: 'TLS',
    color: '#e74c3c',
    title: 'Secure Connection Failed',
    detail: 'A TLS error prevented a secure connection to this site.'
  },
  '-1201': {
    code: 'TLS',
    color: '#e74c3c',
    title: 'Certificate Invalid',
    detail: "The server's certificate is not trusted. The connection is not secure."
  },
  '-1202': {
    code: 'TLS',
    color: '#e74c3c',
    title: 'Certificate Invalid',
    detail: "The server's certificate is not trusted. The connection is not secure."
  },
  '-5': {
    code: 'TLS',
    color: '#e74c3c',
    title: 'Secure Connection Failed',
    detail: 'A TLS error prevented a secure connection to this site.'
  },
  // Network lost / not connected
  '-1009': {
    code: ':(',
    color: '#999',
    title: 'No Internet Connection',
    detail: 'You appear to be offline. Check your connection and try again.'
  },
  '-1005': {
    code: ':(',
    color: '#999',
    title: 'Connection Lost',
    detail: 'The network connection was lost. Try again.'
  }
}

const genericNativeError: NativeErrorInfo = {
  code: ':(',
  color: '#999',
  title: 'Page Could Not Be Loaded',
  detail: 'Something went wrong loading this page. Check the URL and try again.'
}

export function getErrorPage(status: number | string): string {
  const key = String(status)
  return errorPages[key as keyof typeof errorPages] || errorPages['404']
}

export function getNativeErrorInfo(code: number | string): NativeErrorInfo {
  const key = String(code)
  return nativeErrors[key] || genericNativeError
}

export const paymentLoadingPage = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Payment Required</title>${baseStyle}
<style>
  .spinner { width: 32px; height: 32px; border: 3px solid var(--sub); border-top-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 16px; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style></head>
<body>
  <div>
    <div class="spinner"></div>
    <p class="subtitle">Payment Required</p>
  </div>
</body>
</html>`

/**
 * Minimal loading splash injected into the active WebView the instant a URL is
 * submitted. Removes the perceived dead-air between the address bar collapsing
 * and the native nav actually drawing the first byte of the new page —
 * particularly noticeable on cold-DNS hosts and slow networks.
 *
 * The page is replaced as soon as the WKWebView completes the real navigation
 * (the real page's HTML overwrites this stub), so users never see the spinner
 * for more than the network/TLS handshake.
 */
export function navigationLoadingPage(targetUrl: string): string {
  let host = ''
  try {
    host = new URL(targetUrl).host
  } catch {
    host = targetUrl
  }
  // Escape host for safe HTML embedding (display only — never reflected as JS).
  const safeHost = host.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  // NOTE: this HTML is re-embedded inside a backtick template literal by
  // injectNavigationSplash (only backticks are escaped there), so the inline
  // script below must never contain a "${" sequence.
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Loading…</title>${baseStyle}
<style>
  body { gap: 16px; flex-direction: column; }
  .spinner { width: 28px; height: 28px; border: 3px solid var(--sub); border-top-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite; opacity: 0.7; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .host { color: var(--sub); font-size: 13px; font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif; letter-spacing: 0.2px; }
  .hint { color: var(--sub); font-size: 12px; opacity: 0.8; min-height: 16px; font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif; }
</style></head>
<body>
  <div class="spinner" id="__nav_spinner"></div>
  <div class="host">${safeHost}</div>
  <div class="hint" id="__nav_hint"></div>
  <script>
    (function () {
      var cancelled = false;
      // Called from the app when the user cancels the navigation (stop button
      // or refocusing the address bar). The native cancel error (-999) is
      // swallowed by the WebView layer, so without this the spinner would
      // spin forever on a stopped provisional load.
      window.__navCancel = function () {
        cancelled = true;
        var sp = document.getElementById('__nav_spinner');
        if (sp) sp.style.display = 'none';
        var h = document.getElementById('__nav_hint');
        if (h) h.textContent = 'Load cancelled';
      };
      setTimeout(function () {
        if (cancelled) return;
        var h = document.getElementById('__nav_hint');
        if (h && !h.textContent) h.textContent = 'Page is still loading\\u2026 tap the address bar to edit or cancel';
      }, 5000);
    })();
  </script>
</body>
</html>`
}
