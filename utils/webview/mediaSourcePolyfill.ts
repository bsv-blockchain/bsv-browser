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
 *
 * Additional iOS considerations handled here:
 *   - The .src property descriptor may live on HTMLAudioElement or HTMLVideoElement
 *     prototype rather than HTMLMediaElement in some WebKit builds — we search all three.
 *   - srcObject assignment is also intercepted (modern path for ManagedMediaSource).
 *   - ManagedMediaSource instances are tracked directly so srcObject works without blob URLs.
 *   - startstreaming/endstreaming events are forwarded as custom events on the MediaSource
 *     so apps can pause/resume SourceBuffer appending when the OS suspends media.
 */
export const mediaSourcePolyfill = `(function() {
  if (window.MediaSource) return;
  if (!window.ManagedMediaSource) return;

  window.MediaSource = window.ManagedMediaSource;

  // Track blob URLs that point to a ManagedMediaSource instance.
  var mseBlobURLs = new Set();
  // Track ManagedMediaSource instances directly (for srcObject path).
  var mmsInstances = new WeakSet();

  // Wrap the ManagedMediaSource constructor so we can track all instances.
  var OrigMMS = window.ManagedMediaSource;
  window.ManagedMediaSource = function ManagedMediaSource() {
    var instance = new OrigMMS();
    mmsInstances.add(instance);

    // Forward startstreaming / endstreaming as custom events so apps that
    // listen on MediaSource (not ManagedMediaSource) can react.
    instance.addEventListener('startstreaming', function() {
      instance.dispatchEvent(new Event('ms-startstreaming'));
    });
    instance.addEventListener('endstreaming', function() {
      instance.dispatchEvent(new Event('ms-endstreaming'));
    });

    return instance;
  };
  window.ManagedMediaSource.prototype = OrigMMS.prototype;
  // Preserve static methods (isTypeSupported, etc.)
  Object.getOwnPropertyNames(OrigMMS).forEach(function(key) {
    if (key !== 'prototype' && key !== 'length' && key !== 'name') {
      try { window.ManagedMediaSource[key] = OrigMMS[key]; } catch(e) {}
    }
  });
  // Keep the alias in sync
  window.MediaSource = window.ManagedMediaSource;

  var origCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = function(obj) {
    var url = origCreateObjectURL.call(URL, obj);
    if (obj instanceof OrigMMS) mseBlobURLs.add(url);
    return url;
  };
  // Spoof toString so bot-detection sees native code
  try {
    Object.defineProperty(URL.createObjectURL, 'toString', {
      value: function() { return 'function createObjectURL() { [native code] }'; },
      writable: false, configurable: false
    });
    Object.defineProperty(URL.createObjectURL, 'name', { value: 'createObjectURL', configurable: true });
  } catch(e) {}

  // When a media element gets an MSE blob URL as src or a ManagedMediaSource
  // as srcObject, ensure disableRemotePlayback is set and the element is in the DOM.
  function ensureMSERequirements(el) {
    try { if (!el.disableRemotePlayback) el.disableRemotePlayback = true; } catch(e) {}
    if (!el.isConnected) {
      el.style.display = 'none';
      el.style.width = '0';
      el.style.height = '0';
      (document.body || document.documentElement).appendChild(el);
    }
  }

  function patchIfMSE(el, url) {
    if (typeof url !== 'string' || !mseBlobURLs.has(url)) return;
    ensureMSERequirements(el);
  }

  // Find the .src property descriptor — it may be on HTMLMediaElement,
  // HTMLAudioElement, or HTMLVideoElement depending on the WebKit version.
  function findSrcDescriptor() {
    var protos = [HTMLMediaElement.prototype];
    if (typeof HTMLAudioElement !== 'undefined') protos.push(HTMLAudioElement.prototype);
    if (typeof HTMLVideoElement !== 'undefined') protos.push(HTMLVideoElement.prototype);
    for (var i = 0; i < protos.length; i++) {
      var desc = Object.getOwnPropertyDescriptor(protos[i], 'src');
      if (desc && desc.set) return { proto: protos[i], desc: desc };
    }
    return null;
  }

  // Patch .src setter
  var srcInfo = findSrcDescriptor();
  if (srcInfo) {
    Object.defineProperty(srcInfo.proto, 'src', {
      get: srcInfo.desc.get,
      set: function(val) {
        patchIfMSE(this, val);
        return srcInfo.desc.set.call(this, val);
      },
      configurable: true,
      enumerable: true
    });
  }

  // Patch .srcObject setter — ManagedMediaSource can be assigned directly.
  function findSrcObjectDescriptor() {
    var protos = [HTMLMediaElement.prototype];
    if (typeof HTMLAudioElement !== 'undefined') protos.push(HTMLAudioElement.prototype);
    if (typeof HTMLVideoElement !== 'undefined') protos.push(HTMLVideoElement.prototype);
    for (var i = 0; i < protos.length; i++) {
      var desc = Object.getOwnPropertyDescriptor(protos[i], 'srcObject');
      if (desc && desc.set) return { proto: protos[i], desc: desc };
    }
    return null;
  }

  var srcObjInfo = findSrcObjectDescriptor();
  if (srcObjInfo) {
    Object.defineProperty(srcObjInfo.proto, 'srcObject', {
      get: srcObjInfo.desc.get,
      set: function(val) {
        if (val && (val instanceof OrigMMS || mmsInstances.has(val))) {
          ensureMSERequirements(this);
        }
        return srcObjInfo.desc.set.call(this, val);
      },
      configurable: true,
      enumerable: true
    });
  }

  // Fallback: if we couldn't patch the src descriptor (some older WKWebView builds),
  // use a MutationObserver to catch <audio>/<video> elements with MSE blob src.
  if (!srcInfo && !srcObjInfo) {
    var mo = new MutationObserver(function(mutations) {
      mutations.forEach(function(m) {
        var nodes = m.addedNodes || [];
        for (var i = 0; i < nodes.length; i++) {
          var node = nodes[i];
          if (node.nodeName === 'AUDIO' || node.nodeName === 'VIDEO') {
            if (node.src && mseBlobURLs.has(node.src)) ensureMSERequirements(node);
          }
        }
        if (m.type === 'attributes' && m.attributeName === 'src') {
          var t = m.target;
          if ((t.nodeName === 'AUDIO' || t.nodeName === 'VIDEO') && t.src && mseBlobURLs.has(t.src)) {
            ensureMSERequirements(t);
          }
        }
      });
    });
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
  }
})();true;`
