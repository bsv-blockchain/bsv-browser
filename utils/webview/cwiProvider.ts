// Generates the injectable JavaScript that installs window.CWI as a BRC-100 wallet provider.
// Follows the same pattern as buildInjectedJavaScript / getPermissionScript:
// a TypeScript function serialized to a string and immediately invoked in the WebView context.

function cwiProviderScript() {
  // Guard: don't re-inject on SPA-style soft navigations
  if (typeof (window as any).CWI === 'object') return

  // All 28 WalletInterface method names (BRC-100)
  var methods = [
    'createAction', 'signAction', 'abortAction',
    'listActions', 'internalizeAction', 'listOutputs',
    'relinquishOutput', 'getPublicKey',
    'revealCounterpartyKeyLinkage', 'revealSpecificKeyLinkage',
    'encrypt', 'decrypt', 'createHmac', 'verifyHmac',
    'createSignature', 'verifySignature',
    'acquireCertificate', 'listCertificates',
    'proveCertificate', 'relinquishCertificate',
    'discoverByIdentityKey', 'discoverByAttributes',
    'isAuthenticated', 'waitForAuthentication',
    'getHeight', 'getHeaderForHeight',
    'getNetwork', 'getVersion'
  ]

  // Unique ID generator — counter + timestamp + random suffix
  var _idCounter = 0
  function generateId() {
    return '__cwi_' + (++_idCounter) + '_' + Date.now() + '_' +
      Math.random().toString(36).slice(2, 8)
  }

  // Core invoke: sends a CWI message via ReactNativeWebView.postMessage and
  // returns a Promise resolved/rejected by the matching response event.
  // Uses the exact same protocol as the SDK's ReactNativeWebView substrate.
  function invoke(call: string, args: any): Promise<any> {
    return new Promise(function (resolve, reject) {
      var id = generateId()
      var timeoutId: any = null

      var listener = function (e: MessageEvent) {
        var data: any
        try { data = JSON.parse(e.data) } catch (_) { return }
        if (data.type !== 'CWI' || data.id !== id || data.isInvocation === true) return

        // Match found — clean up
        window.removeEventListener('message', listener)
        if (timeoutId !== null) clearTimeout(timeoutId)

        if (data.status === 'error') {
          var err: any = new Error(data.description || 'Wallet error')
          err.code = data.code
          reject(err)
        } else {
          resolve(data.result)
        }
      }

      window.addEventListener('message', listener)

      // 60-second timeout for wallet operations (matches permissionScript pattern)
      timeoutId = setTimeout(function () {
        window.removeEventListener('message', listener)
        reject(new Error('Wallet request timed out'))
      }, 60000)

      // Send to native side
      try {
        ;(window as any).ReactNativeWebView.postMessage(
          JSON.stringify({
            type: 'CWI',
            isInvocation: true,
            id: id,
            call: call,
            args: args
          })
        )
      } catch (err) {
        window.removeEventListener('message', listener)
        if (timeoutId !== null) clearTimeout(timeoutId)
        reject(new Error('Failed to communicate with wallet'))
      }
    })
  }

  // Build the CWI object with all 28 methods
  var cwi: any = {}
  for (var i = 0; i < methods.length; i++) {
    ;(function (methodName) {
      cwi[methodName] = function (args: any, _originator?: string) {
        // originator is intentionally ignored — the native side determines
        // the real origin from the tab URL, which is more secure.
        return invoke(methodName, typeof args !== 'undefined' ? args : {})
      }
    })(methods[i])
  }

  // Install as non-writable, non-configurable, frozen (Brave browser pattern).
  // Prevents malicious pages from overwriting window.CWI or modifying methods.
  Object.defineProperty(window, 'CWI', {
    value: Object.freeze(cwi),
    writable: false,
    configurable: false,
    enumerable: true
  })
}

export function buildCWIProviderScript(): string {
  return `(${cwiProviderScript.toString()})();true;`
}
