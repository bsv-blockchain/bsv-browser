export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  try {
    if (path?.toLowerCase().startsWith('peerpay:')) {
      return `/payments?peerpay=${encodeURIComponent(path)}`
    }

    return path || '/'
  } catch {
    return '/'
  }
}
