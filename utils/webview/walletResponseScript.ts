/**
 * Builds JavaScript that returns a native wallet response to the frame that
 * originated the request. Native injection executes in the top document, so a
 * child-frame response must cross back through postMessage.
 */
export function buildWalletResponseScript(message: unknown, responseOrigin?: string): string {
  const messageString = JSON.stringify(message)
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
