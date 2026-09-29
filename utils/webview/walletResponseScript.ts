/**
 * Builds JavaScript that returns a native wallet response to the frame that
 * originated the request. Native injection executes in the top document, so a
 * child-frame response must cross back through postMessage.
 */
import { stringifyWalletPayload } from './walletByteJson'

/** stringifyWalletPayload, not JSON.stringify: wallet results carry byte fields that plain JSON mangles. */
export function serializeWalletResponse(message: unknown): string {
  return stringifyWalletPayload(message)
}

export function buildWalletResponseScript(message: unknown, responseOrigin?: string): string {
  return buildSerializedWalletResponseScript(serializeWalletResponse(message), responseOrigin)
}

/**
 * For a response already produced by serializeWalletResponse (so its size could
 * be checked first). The string is embedded as a JavaScript expression, so it
 * must be that function's JSON output and nothing else.
 */
export function buildSerializedWalletResponseScript(messageString: string, responseOrigin?: string): string {
  const responseOriginString = JSON.stringify(responseOrigin ?? null)
  return `
    (function() {
      var data = JSON.stringify(${messageString});
      var responseOrigin = ${responseOriginString};
      if (!responseOrigin || window.location.origin === responseOrigin) {
        window.dispatchEvent(new MessageEvent('message', { data: data }));
      }
      if (responseOrigin) {
        for (var i = 0; i < window.frames.length; i++) {
          try { window.frames[i].postMessage(data, responseOrigin); } catch (_) {}
        }
      }
    })();
  `
}
