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
  '402': errorPage('402', '#e67e22', 'Payment Required', 'This content requires a small BSV payment.'),
  '403': errorPage('403', '#e74c3c', 'Access Forbidden', "You don't have permission to view this page."),
  '404': errorPage('404', 'var(--sub)', 'Page Not Found', 'The requested page could not be found.'),
  '500': errorPage('500', '#e74c3c', 'Server Error', 'Something went wrong on the server.')
} as const

export function getErrorPage(status: number | string): string {
  const key = String(status)
  return errorPages[key as keyof typeof errorPages] || errorPages['404']
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
