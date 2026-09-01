/**
 * Returns the BRC-100 originator for the frame that posted a WebView message.
 * React Native WebView reports the source-frame URL on supported iOS and
 * Android WebMessageListener implementations. Never trust an originator sent
 * in page-controlled JSON.
 *
 * When the native frame URL is missing (`about:blank`, empty, `data:`), fall
 * back to the tab URL. A verifiable embedded-frame URL still wins so an iframe
 * keeps its own origin instead of inheriting the parent page.
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

export function resolveWalletFrameIdentity(frameUrl: unknown, fallbackUrl?: unknown): WalletFrameIdentity | undefined {
  return walletFrameIdentityFromUrl(frameUrl) ?? walletFrameIdentityFromUrl(fallbackUrl)
}
