/**
 * Absolute ceiling on a WebView message, checked before JSON.parse.
 *
 * THIS IS A DAMAGE LIMITER, NOT A FIX, and it is important not to mistake it for
 * one. By the time `data.length` is readable from JS, the native side has already
 * built a Java String (2 bytes/char), a folly::dynamic (1 byte/char) and a Hermes
 * string (1 byte/char) — roughly 4 bytes per JSON character, or 7-16x the
 * transaction bytes the message carries. A page posting a 200 MB string can kill
 * the app regardless of what this function returns. Closing that properly needs a
 * react-native-webview patch rejecting by length inside didReceiveScriptMessage
 * and the @JavascriptInterface method, which is a forked-dependency commitment.
 *
 * What it does buy: JSON.parse of a huge string is where the second, larger
 * allocation happens (the parsed arrays), and that one is preventable. A string
 * length check is O(1).
 *
 * The ceiling is tiered because the app posts entire files to itself as base64 in
 * FILE_DOWNLOAD_BLOB, which has no size limit of its own. The prefix sniff is
 * reliable because the app writes that message, with `type` first — a page cannot
 * borrow the allowance for a wallet call, since a CWI message that begins with
 * that prefix would not dispatch as one.
 */

/** Ordinary messages, wallet calls included. 8 M chars ~ 8 MB of JSON. */
export const MESSAGE_CHARS_MAX = 8_000_000

/** The app's own file-download channel, which carries base64 file contents. */
export const DOWNLOAD_BLOB_CHARS_MAX = 32_000_000

const DOWNLOAD_PREFIX = '{"type":"FILE_DOWNLOAD_BLOB"'

/** True when this message must be dropped without parsing it. */
export function messageTooLarge(data: string): boolean {
  if (typeof data !== 'string') return false
  const limit = data.startsWith(DOWNLOAD_PREFIX) ? DOWNLOAD_BLOB_CHARS_MAX : MESSAGE_CHARS_MAX
  return data.length > limit
}

export const WALLET_REQUEST_TOO_LARGE = 'Wallet request exceeds the maximum permitted size'
export const WALLET_RESPONSE_TOO_LARGE = 'Wallet response exceeds the maximum permitted size'

/** How much of an oversized request is inspected for its id. The SDK writes `id` before `args`. */
const REQUEST_ID_SNIFF_CHARS = 512
const CWI_PREFIX = '{"type":"CWI"'
const REQUEST_ID_PATTERN = /"id":"([A-Za-z0-9+/=]{1,64})"/

/**
 * Recovers the request id from a CWI message that is too large to parse, so the
 * page can be told the request was refused instead of waiting forever. Reads a
 * bounded prefix only; never the whole string.
 */
export function sniffWalletRequestId(data: string): string | undefined {
  if (typeof data !== 'string' || !data.startsWith(CWI_PREFIX)) return undefined
  const match = REQUEST_ID_PATTERN.exec(data.slice(0, REQUEST_ID_SNIFF_CHARS))
  return match?.[1]
}

/** Outbound counterpart of messageTooLarge: a wallet response the host must not inject in one shot. */
export function responseTooLarge(serialized: string): boolean {
  return serialized.length > MESSAGE_CHARS_MAX
}
