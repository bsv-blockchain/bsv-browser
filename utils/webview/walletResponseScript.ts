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
  const messageString = typeof message === 'string' ? message : serializeWalletResponse(message)
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
