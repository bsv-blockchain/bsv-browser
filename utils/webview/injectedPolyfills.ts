// Builds the script injected into every page in web3 mode (the WebView's
// `injectedJavaScript`).
//
// Written as a plain string template, not a serialized function. The previous
// version injected `injectedPolyfills.toString()`, but Hermes compiles
// functions to bytecode and returns "function … { [bytecode] }" for them, in
// dev and release alike, so pages received nothing runnable and none of it
// ever ran. cwiProvider.ts moved to a string for the same reason. Keep this
// file to plain ES5 inside the template: nothing here is transpiled.

export interface InjectedJavaScriptOptions {
  /** Development build: forward every console.log, info and debug call. */
  isDev: boolean
  /** Relay page console output to React Native (dev-menu toggle, off by default). */
  forwardConsoleLogs: boolean
}

// Relays page console calls as { type: 'CONSOLE', method, args } messages,
// which app/index.tsx prints with a [WebView] prefix. Outside dev builds only
// one console.log in ten is relayed; warn and error always are.
const CONSOLE_BRIDGE = `
  if (!window.__consolePatched) {
    var post = function (method, args) {
      try {
        window.ReactNativeWebView.postMessage(
          JSON.stringify({ type: 'CONSOLE', method: method, args: Array.prototype.slice.call(args) })
        );
      } catch (e) {}
    };
    var logSampleRate = isDev ? 1 : 10;
    var logSeq = 0;
    var relay = function (method, shouldPost) {
      var original = console[method];
      if (typeof original !== 'function') return;
      console[method] = function () {
        original.apply(console, arguments);
        if (shouldPost()) post(method, arguments);
      };
    };
    relay('log', function () { return ++logSeq % logSampleRate === 0; });
    relay('warn', function () { return true; });
    relay('error', function () { return true; });
    relay('info', function () { return isDev; });
    relay('debug', function () { return isDev; });
    window.__consolePatched = true;
  }
`

// iPhone WebKit has no element Fullscreen API. Where it is missing, route
// requestFullscreen / exitFullscreen to the app (REQUEST_FULLSCREEN /
// EXIT_FULLSCREEN, handled in messageRouter.ts), which hides its chrome and
// answers with FULLSCREEN_RESPONSE and FULLSCREEN_CHANGE. The app always
// shows the whole page, so the requesting element is only what
// document.fullscreenElement reports.
const FULLSCREEN_POLYFILL = `
  if (typeof Element !== 'undefined' && typeof Element.prototype.requestFullscreen !== 'function') {
    var fullscreenElement = null;
    var requestedElement = null;
    var parseMessage = function (event) {
      if (typeof event.data !== 'string') return null;
      try { return JSON.parse(event.data); } catch (e) { return null; }
    };
    var askApp = function (type, onResponse) {
      var listener = function (event) {
        var data = parseMessage(event);
        if (!data || data.type !== 'FULLSCREEN_RESPONSE') return;
        window.removeEventListener('message', listener);
        onResponse(data);
      };
      window.addEventListener('message', listener);
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: type }));
    };
    Element.prototype.requestFullscreen = function () {
      var element = this;
      return new Promise(function (resolve, reject) {
        try {
          askApp('REQUEST_FULLSCREEN', function (data) {
            if (data.success) {
              requestedElement = element;
              resolve();
            } else {
              reject(new TypeError('Fullscreen request denied'));
            }
          });
        } catch (e) {
          reject(e);
        }
      });
    };
    document.exitFullscreen = function () {
      return new Promise(function (resolve, reject) {
        try {
          askApp('EXIT_FULLSCREEN', function () { resolve(); });
        } catch (e) {
          reject(e);
        }
      });
    };
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: function () { return fullscreenElement; }
    });
    Object.defineProperty(document, 'fullscreenEnabled', {
      configurable: true,
      get: function () { return true; }
    });
    window.addEventListener('message', function (event) {
      var data = parseMessage(event);
      if (!data || data.type !== 'FULLSCREEN_CHANGE') return;
      fullscreenElement = data.isFullscreen ? requestedElement || document.documentElement : null;
      if (!data.isFullscreen) requestedElement = null;
      document.dispatchEvent(new Event('fullscreenchange'));
    });
  }
`

export function buildInjectedJavaScript({ isDev, forwardConsoleLogs }: InjectedJavaScriptOptions): string {
  // The trailing `true;` is required by react-native-webview on iOS; without
  // it the injected script is silently discarded.
  return `(function () {
  var isDev = ${isDev ? 'true' : 'false'};
${forwardConsoleLogs ? CONSOLE_BRIDGE : ''}
${FULLSCREEN_POLYFILL}
})();true;`
}
