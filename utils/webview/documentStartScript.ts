import { buildCWIProviderScript } from './cwiProvider'

/**
 * Builds the document-start script installed in every WebView frame.
 *
 * The BRC-100 provider must exist in child frames so embedded apps can talk
 * directly to the native wallet bridge. Browser polyfills and permission hooks
 * remain scoped to the top document; applying them to arbitrary third-party
 * frames would change page behaviour beyond the wallet surface.
 */
export function buildWalletDocumentStartScript(mainFrameScript: string): string {
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
${buildCWIProviderScript()}
(function() {
  if (window.top !== window) return;
${mainFrameScript}
})();true;`
}
