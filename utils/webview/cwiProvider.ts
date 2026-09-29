// Generates the injectable JavaScript that installs window.CWI as a BRC-100
// wallet provider.  Written as a plain string template (not a .toString()
// serialized function) to avoid Metro/Hermes bytecode artifacts that break
// when evaluated in the WebView context.

export function buildCWIProviderScript(): string {
  return `(function() {
  if (typeof window.CWI === 'object') return;

  var methods = [
    'createAction','signAction','abortAction','listActions','internalizeAction',
    'listOutputs','relinquishOutput','getPublicKey',
    'revealCounterpartyKeyLinkage','revealSpecificKeyLinkage',
    'encrypt','decrypt','createHmac','verifyHmac',
    'createSignature','verifySignature',
    'acquireCertificate','listCertificates','proveCertificate','relinquishCertificate',
    'discoverByIdentityKey','discoverByAttributes',
    'isAuthenticated','waitForAuthentication',
    'getHeight','getHeaderForHeight','getNetwork','getVersion'
  ];

  var _idCounter = 0;
  function generateId() {
    if (window.crypto && typeof window.crypto.getRandomValues === 'function' && typeof btoa === 'function') {
      var bytes = window.crypto.getRandomValues(new Uint8Array(16));
      var binary = '';
      for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      return btoa(binary);
    }
    return '__cwi_' + (++_idCounter) + '_' + Date.now() + '_' +
      Math.random().toString(36).slice(2, 8);
  }

  function invoke(call, args) {
    return new Promise(function(resolve, reject) {
      var id = generateId();
      var timeoutId = null;

      var listener = function(e) {
        // The host injects replies into this document (no source) or relays
        // them from the parent frame; any other browsing context is not the
        // wallet bridge.
        var from = e.source;
        if (from != null && from !== window && from !== window.parent) return;

        var data;
        try { data = JSON.parse(e.data); } catch(_) { return; }
        if (data.type !== 'CWI' || data.id !== id || data.isInvocation === true) return;

        window.removeEventListener('message', listener);
        if (timeoutId !== null) clearTimeout(timeoutId);

        if (data.status === 'error') {
          var err = new Error(data.description || 'Wallet error');
          err.code = data.code;
          reject(err);
        } else {
          resolve(data.result);
        }
      };

      window.addEventListener('message', listener);

      timeoutId = setTimeout(function() {
        window.removeEventListener('message', listener);
        reject(new Error('Wallet request timed out'));
      }, 60000);

      try {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'CWI', isInvocation: true, id: id, call: call, args: args
        }));
      } catch(err) {
        window.removeEventListener('message', listener);
        if (timeoutId !== null) clearTimeout(timeoutId);
        reject(new Error('Failed to communicate with wallet'));
      }
    });
  }

  var cwi = {};
  for (var i = 0; i < methods.length; i++) {
    (function(methodName) {
      cwi[methodName] = function(args) {
        return invoke(methodName, typeof args !== 'undefined' ? args : {});
      };
    })(methods[i]);
  }

  Object.defineProperty(window, 'CWI', {
    value: Object.freeze(cwi),
    writable: false,
    configurable: false,
    enumerable: true
  });
})();true;`
}
