export const errorPages = {
  '404': `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>404 Not Found</title><style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f4f4f4;color:#333;text-align:center;}</style></head>
<body>
  <div>
    <h1 style="font-size:6rem;margin:0;color:#666;">404</h1>
    <p style="font-size:1.5rem;">Page not found</p>
    <p>The requested page could not be found.</p>
  </div>
</body>
</html>`,
  '402': `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>402 Payment Required</title><style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f4f4f4;color:#333;text-align:center;}</style></head>
<body>
  <div>
    <h1 style="font-size:6rem;margin:0;color:#e67e22;">402</h1>
    <p style="font-size:1.5rem;">Payment Required</p>
    <p>This content requires a small BSV payment.</p>
    <p>Your browser should handle this automatically.</p>
  </div>
</body>
</html>`,
  '500': `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>500 Server Error</title><style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f4f4f4;color:#333;text-align:center;}</style></head>
<body>
  <div>
    <h1 style="font-size:6rem;margin:0;color:#e74c3c;">500</h1>
    <p style="font-size:1.5rem;">Server Error</p>
    <p>Something went wrong on the server.</p>
  </div>
</body>
</html>`,
  '403': `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>403 Forbidden</title><style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f4f4f4;color:#333;text-align:center;}</style></head>
<body>
  <div>
    <h1 style="font-size:6rem;margin:0;color:#e74c3c;">403</h1>
    <p style="font-size:1.5rem;">Access Forbidden</p>
    <p>You don't have permission to view this page.</p>
  </div>
</body>
</html>`
} as const;

export function getErrorPage(status: number | string): string {
  const key = String(status);
  return errorPages[key as keyof typeof errorPages] || errorPages['404'];
}
