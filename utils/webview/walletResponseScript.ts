/**
 * Builds JavaScript that returns a native wallet response to the frame that
 * originated the request. Native injection executes in the top document, so a
 * child-frame response must cross back through postMessage.
 */
import { stringifyWalletPayload } from './walletByteJson'

export function buildWalletResponseScript(message: unknown, responseOrigin?: string): string {
  // stringifyWalletPayload, not JSON.stringify: wallet results can carry
  // Uint8Array (and historically numeric-keyed) byte fields, which plain
  // JSON.stringify mangles into {"0":..} records the page cannot use.
  const messageString = stringifyWalletPayload(message)
  const responseOriginString = JSON.stringify(responseOrigin ?? null)
  return `
    (function() {
      var data = JSON.stringify(${messageString});
      var responseOrigin = ${responseOriginString};
      if (!responseOrigin || window.location.origin === responseOrigin) {
        window.dispatchEvent(new MessageEvent('message', { data: data }));
        return;
      }
      for (var i = 0; i < window.frames.length; i++) {
        try { window.frames[i].postMessage(data, responseOrigin); } catch (_) {}
      }
    })();
  `
}
