/**
 * Returns the BRC-100 originator for the frame that posted a WebView message.
 * React Native WebView reports the source-frame URL on supported iOS and
 * Android WebMessageListener implementations. Never trust an originator sent
 * in page-controlled JSON.
 */
export type WalletFrameIdentity = {
  originator: string
  responseOrigin: string
}

export function walletFrameIdentityFromUrl(frameUrl: unknown): WalletFrameIdentity | undefined {
  if (typeof frameUrl !== 'string' || frameUrl.length === 0) return undefined

  try {
    const parsed = new URL(frameUrl)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined
    if (!parsed.hostname) return undefined
    return { originator: parsed.hostname, responseOrigin: parsed.origin }
  } catch {
    return undefined
  }
}
