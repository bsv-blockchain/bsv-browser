import { buildCWIProviderScript } from './cwiProvider'

/**
 * Only a short, visible-ASCII version string may be embedded into the
 * injected script; spaces and control characters are refused to avoid
 * ambiguous or malformed version strings.
 */
const WALLET_VERSION_PATTERN = /^[\x21-\x7e]{7,30}$/

/**
 * Builds the document-start script installed in every WebView frame.
 *
 * The BRC-100 provider must exist in child frames so embedded apps can talk
 * directly to the native wallet bridge. Browser polyfills and permission hooks
 * remain scoped to the top document; applying them to arbitrary third-party
 * frames would change page behaviour beyond the wallet surface.
 */
export function buildWalletDocumentStartScript(mainFrameScript: string, walletVersion?: string): string {
  const versionLiteral =
    typeof walletVersion === 'string' && WALLET_VERSION_PATTERN.test(walletVersion)
      ? JSON.stringify(walletVersion)
      : 'null'
  return `(function() {
  if (window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === 'function') return;
  var handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.ReactNativeWebView;
  if (!handler || typeof handler.postMessage !== 'function') return;
  window.ReactNativeWebView = {
    postMessage: function(data) {
      var message;
      try { message = JSON.parse(String(data)); } catch (_) { return; }
      if (message.type !== 'CWI' || message.isInvocation !== true) return;
      handler.postMessage(String(data));
    }
  };
})();
(function() {
  // getVersion is static, public information. Answering it here keeps wallet
  // discovery (which @bsv/sdk bounds at one second per probe) independent of
  // how busy the app's JS thread is during page load. Every other call, and
  // anything that is not a small CWI invocation, still crosses the bridge.
  //
  // Only where the host's replies can actually land: the top document, or a
  // same-origin frame directly under it. The host relays child-frame replies
  // from the top document, and the SDK drops a relay whose origin is not the
  // frame's own, so a cross-origin frame that passed discovery here would then
  // wait forever on its first real call. Failing discovery is the honest answer.
  var version = ${versionLiteral};
  if (typeof version !== 'string') return;
  if (window.top !== window) {
    var reachable = false;
    try {
      reachable = window.parent === window.top && window.top.location.origin === window.location.origin;
    } catch (_) {}
    if (!reachable) return;
  }
  var bridge = window.ReactNativeWebView;
  if (!bridge || typeof bridge.postMessage !== 'function') return;
  var wrapped = {
    postMessage: function(data) {
      if (typeof data === 'string' && data.length < 4096 && data.indexOf('{"type":"CWI"') === 0) {
        var message = null;
        try { message = JSON.parse(data); } catch (_) { message = null; }
        if (message && message.isInvocation === true && message.call === 'getVersion' && typeof message.id === 'string') {
          var reply = JSON.stringify({ type: 'CWI', id: message.id, isInvocation: false, status: 'success', result: { version: version } });
          setTimeout(function() { window.dispatchEvent(new MessageEvent('message', { data: reply })); }, 0);
          return;
        }
      }
      return bridge.postMessage(data);
    }
  };
  try { window.ReactNativeWebView = wrapped; } catch (_) {}
})();
${buildCWIProviderScript()}
(function() {
  if (window.top !== window) return;
${mainFrameScript}
})();true;`
}
