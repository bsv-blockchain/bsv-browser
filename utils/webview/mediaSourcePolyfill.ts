/**
 * Polyfill that aliases ManagedMediaSource → MediaSource on iOS 17.1+ WKWebView.
 * No-op on Android / desktop where MediaSource already exists.
 *
 * ManagedMediaSource requires two things that regular MediaSource does not:
 *   1. The media element must have disableRemotePlayback = true
 *   2. The element should be connected to the DOM for sourceopen to fire
 *
 * Many apps (e.g. those using `new Audio()`) never do either of these,
 * so we intercept src/srcObject assignment to apply them automatically.
 */
export const mediaSourcePolyfill = `(function() {
  if (window.MediaSource) return;
  if (!window.ManagedMediaSource) return;

  window.MediaSource = window.ManagedMediaSource;

  // Track blob URLs that point to a ManagedMediaSource instance.
  var mseBlobURLs = new Set();
  var origCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = function(obj) {
    var url = origCreateObjectURL.call(URL, obj);
    if (obj instanceof ManagedMediaSource) mseBlobURLs.add(url);
    return url;
  };

  // When a media element gets an MSE blob URL as src, ensure
  // disableRemotePlayback is set and the element is in the DOM.
  function patchIfMSE(el, url) {
    if (typeof url !== 'string' || !mseBlobURLs.has(url)) return;
    if (!el.disableRemotePlayback) el.disableRemotePlayback = true;
    if (!el.isConnected) {
      el.style.display = 'none';
      el.style.width = '0';
      el.style.height = '0';
      (document.body || document.documentElement).appendChild(el);
    }
  }

  // Patch .src setter on HTMLMediaElement (covers <audio> and <video>)
  var srcDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
  if (srcDesc && srcDesc.set) {
    Object.defineProperty(HTMLMediaElement.prototype, 'src', {
      get: srcDesc.get,
      set: function(val) {
        patchIfMSE(this, val);
        return srcDesc.set.call(this, val);
      },
      configurable: true,
      enumerable: true
    });
  }
})();true;`
