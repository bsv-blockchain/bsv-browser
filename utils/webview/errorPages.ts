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
  '-1003': { code: 'DNS', color: '#999', title: 'Server Not Found', detail: "The site's address couldn't be resolved. Check the URL and try again." },
  '-6':    { code: 'DNS', color: '#999', title: 'Server Not Found', detail: "The site's address couldn't be resolved. Check the URL and try again." },
  // Connection refused / cannot connect
  '-1004': { code: ':(', color: '#999', title: 'Connection Failed', detail: 'The server refused the connection. It may be offline or unreachable.' },
  '-2':    { code: ':(', color: '#999', title: 'Connection Failed', detail: 'The server refused the connection. It may be offline or unreachable.' },
  // Timed out
  '-1001': { code: ':(', color: '#999', title: 'Connection Timed Out', detail: 'The server took too long to respond. Try again later.' },
  '-8':    { code: ':(', color: '#999', title: 'Connection Timed Out', detail: 'The server took too long to respond. Try again later.' },
  // TLS / SSL errors
  '-1200': { code: 'TLS', color: '#e74c3c', title: 'Secure Connection Failed', detail: 'A TLS error prevented a secure connection to this site.' },
  '-1201': { code: 'TLS', color: '#e74c3c', title: 'Certificate Invalid', detail: "The server's certificate is not trusted. The connection is not secure." },
  '-1202': { code: 'TLS', color: '#e74c3c', title: 'Certificate Invalid', detail: "The server's certificate is not trusted. The connection is not secure." },
  '-5':    { code: 'TLS', color: '#e74c3c', title: 'Secure Connection Failed', detail: 'A TLS error prevented a secure connection to this site.' },
  // Network lost / not connected
  '-1009': { code: ':(', color: '#999', title: 'No Internet Connection', detail: 'You appear to be offline. Check your connection and try again.' },
  '-1005': { code: ':(', color: '#999', title: 'Connection Lost', detail: 'The network connection was lost. Try again.' },
}

const genericNativeError: NativeErrorInfo = { code: ':(', color: '#999', title: 'Page Could Not Be Loaded', detail: 'Something went wrong loading this page. Check the URL and try again.' }

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
