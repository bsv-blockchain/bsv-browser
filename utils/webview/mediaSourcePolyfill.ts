/**
 * Native function toString spoofing setup.
 * Must run BEFORE any other polyfills to ensure all monkey-patched functions
 * appear native to bot-detection scripts (e.g. Cloudflare Turnstile).
 *
 * Patches Function.prototype.toString to consult a WeakMap of spoofed functions.
 * This covers both `fn.toString()` AND `Function.prototype.toString.call(fn)`,
 * without adding detectable own-properties to the patched functions themselves.
 */
export const nativeSpoofSetup = `(function() {
  if (window.__spoofNative) return;
  var _orig = Function.prototype.toString;
  var _map  = new WeakMap();
  Function.prototype.toString = function() {
    var s = _map.get(this);
    return s !== undefined ? s : _orig.call(this);
  };
  _map.set(Function.prototype.toString, 'function toString() { [native code] }');
  window.__spoofNative = function(fn, name) {
    _map.set(fn, 'function ' + name + '() { [native code] }');
  };
})();`

/**
 * Polyfill that aliases ManagedMediaSource -> MediaSource on iOS 17.1+ WKWebView.
 * No-op on Android / desktop where native MediaSource already exists.
 *
 * ManagedMediaSource requires two things that regular MediaSource does not:
 *   1. The media element must have  disableRemotePlayback = true
 *   2. The element must be connected to the DOM for `sourceopen` to fire
 *
 * Many apps (e.g. those using `new Audio()`) never do either, so we
 * intercept every code-path that sets a media source and apply them
 * automatically.
 *
 * Strategy (defense-in-depth):
 *   A. Wrap `URL.createObjectURL` to track blob URLs that point to a
 *      ManagedMediaSource instance.
 *   B. Wrap the `Audio` constructor so every `new Audio()` instance gets
 *      per-instance `.src` / `.srcObject` setters that detect MSE sources.
 *      The per-instance approach walks the *actual element's* prototype chain
 *      to find the native descriptor, instead of hard-coding a single
 *      prototype name (which fails on some WKWebView builds).
 *   C. Wrap `document.createElement` to catch `<audio>` / `<video>` created
 *      that way.
 *   D. Intercept `HTMLMediaElement.prototype.play` as a safety-net: if none
 *      of the above caught the assignment, we still apply the requirements
 *      right before playback starts.
 *   E. A `MutationObserver` watches the DOM for media elements that appear
 *      via innerHTML, parser-created elements, or framework rendering.
 */
export const mediaSourcePolyfill = `(function() {
  if (window.MediaSource) return;
  if (!window.ManagedMediaSource) return;

  var spoofNative = window.__spoofNative || function(){};
  var OrigMMS = window.ManagedMediaSource;

  // Alias so sites that check for window.MediaSource find it.
  window.MediaSource = window.ManagedMediaSource;

  /* ---- MSE blob-URL tracker ---- */
  var mseBlobURLs = new Set();

  var origCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = function(obj) {
    var url = origCreateObjectURL.call(URL, obj);
    if (obj instanceof OrigMMS) mseBlobURLs.add(url);
    return url;
  };
  spoofNative(URL.createObjectURL, 'createObjectURL');

  /* ---- ManagedMediaSource requirements helper ---- */
  function ensureMSEReqs(el) {
    try { if (!el.disableRemotePlayback) el.disableRemotePlayback = true; } catch(e) {}
    if (!el.isConnected) {
      el.style.display = 'none';
      el.style.width  = '0';
      el.style.height = '0';
      (document.body || document.documentElement).appendChild(el);
    }
  }

  /* ---- Prototype-chain descriptor lookup ---- */
  // Walk *upward* from a real element instance so we find the descriptor
  // regardless of which prototype level defines it.
  function findDesc(obj, prop) {
    var p = Object.getPrototypeOf(obj);
    while (p) {
      var d = Object.getOwnPropertyDescriptor(p, prop);
      if (d && (d.set || d.get)) return d;
      p = Object.getPrototypeOf(p);
    }
    return null;
  }

  /* ---- Per-instance .src / .srcObject patching ---- */
  function patchInstance(el) {
    if (el.__mseP) return;
    el.__mseP = true;

    var sd = findDesc(el, 'src');
    if (sd && sd.set) {
      var sGet = sd.get, sSet = sd.set;
      Object.defineProperty(el, 'src', {
        get: sGet ? function() { return sGet.call(this); } : undefined,
        set: function(v) {
          if (typeof v === 'string' && mseBlobURLs.has(v)) ensureMSEReqs(this);
          return sSet.call(this, v);
        },
        configurable: true, enumerable: true
      });
    }

    var sod = findDesc(el, 'srcObject');
    if (sod && sod.set) {
      var soGet = sod.get, soSet = sod.set;
      Object.defineProperty(el, 'srcObject', {
        get: soGet ? function() { return soGet.call(this); } : undefined,
        set: function(v) {
          if (v instanceof OrigMMS) ensureMSEReqs(this);
          return soSet.call(this, v);
        },
        configurable: true, enumerable: true
      });
    }
  }

  /* ---- A. Wrap Audio constructor ---- */
  var OrigAudio = window.Audio;
  if (OrigAudio) {
    window.Audio = function Audio(src) {
      var el = src !== undefined ? new OrigAudio(src) : new OrigAudio();
      patchInstance(el);
      // Handle new Audio(blobUrl) where src was set by the native constructor
      // before our instance-level setter existed.
      if (src && typeof src === 'string' && mseBlobURLs.has(src)) ensureMSEReqs(el);
      return el;
    };
    window.Audio.prototype = OrigAudio.prototype;
    try { Object.defineProperty(window.Audio, 'length', {value:0, configurable:true}); } catch(e) {}
    spoofNative(window.Audio, 'Audio');
  }

  /* ---- B. Wrap document.createElement ---- */
  var origCE = document.createElement;
  document.createElement = function(tag) {
    var el = origCE.apply(this, arguments);
    if (typeof tag === 'string') {
      var t = tag.toLowerCase();
      if (t === 'audio' || t === 'video') patchInstance(el);
    }
    return el;
  };
  spoofNative(document.createElement, 'createElement');

  /* ---- C. Safety-net: intercept .play() ---- */
  var origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function() {
    var src = this.src || this.currentSrc;
    if (src && mseBlobURLs.has(src)) ensureMSEReqs(this);
    try { if (this.srcObject instanceof OrigMMS) ensureMSEReqs(this); } catch(e) {}
    return origPlay.apply(this, arguments);
  };
  spoofNative(HTMLMediaElement.prototype.play, 'play');

  /* ---- D. MutationObserver fallback ---- */
  function checkNode(n) {
    if (n.nodeType !== 1) return;
    if (n.nodeName === 'AUDIO' || n.nodeName === 'VIDEO') {
      patchInstance(n);
      if (n.src && mseBlobURLs.has(n.src)) ensureMSEReqs(n);
    }
    if (n.querySelectorAll) {
      var me = n.querySelectorAll('audio,video');
      for (var k = 0; k < me.length; k++) {
        patchInstance(me[k]);
        if (me[k].src && mseBlobURLs.has(me[k].src)) ensureMSEReqs(me[k]);
      }
    }
  }

  var mo = new MutationObserver(function(muts) {
    for (var i = 0; i < muts.length; i++) {
      var m = muts[i];
      if (m.type === 'childList') {
        for (var j = 0; j < m.addedNodes.length; j++) checkNode(m.addedNodes[j]);
      } else if (m.type === 'attributes' && m.attributeName === 'src') {
        var t = m.target;
        if ((t.nodeName === 'AUDIO' || t.nodeName === 'VIDEO') && t.src && mseBlobURLs.has(t.src)) {
          ensureMSEReqs(t);
        }
      }
    }
  });
  mo.observe(document.documentElement, {
    childList: true, subtree: true,
    attributes: true, attributeFilter: ['src']
  });
})();true;`
