export interface PeerPayParams {
  identityKey: string
  sats?: number
}

export function parsePeerPayURI(uri: string): PeerPayParams | null {
  if (!uri.toLowerCase().startsWith('peerpay:')) return null
  const withoutScheme = uri.slice('peerpay:'.length)
  const [keyPart, queryPart] = withoutScheme.split('?')
  const identityKey = keyPart?.trim()
  if (!identityKey || !/^[0-9a-fA-F]{66}$/.test(identityKey)) return null
  let sats: number | undefined
  if (queryPart) {
    const params = new URLSearchParams(queryPart)
    const satsStr = params.get('sats')
    if (satsStr) {
      const parsed = parseInt(satsStr, 10)
      if (!isNaN(parsed) && parsed > 0) sats = parsed
    }
  }
  return { identityKey, sats }
}
