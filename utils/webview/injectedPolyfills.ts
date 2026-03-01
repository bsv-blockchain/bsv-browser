// Build the injected JavaScript for the WebView from readable TS code instead of a giant string
// The function below runs inside the WebView context. Do NOT reference any RN variables directly.
function injectedPolyfills(acceptLanguage: string, isAndroid: boolean) {
  console.log('[Polyfill] injectedPolyfills running, before=', !!(window as any).__downloadInterceptInstalled)

  // Console logging bridge: install as early as possible
  if (!(window as any).__consolePatched) {
    const originalLog = console.log
    const originalWarn = console.warn
    const originalError = console.error
    const originalInfo = console.info
    const originalDebug = console.debug

    const send = (method: string, args: any[]) => {
      try {
        ;(window as any).ReactNativeWebView?.postMessage(
          JSON.stringify({ type: 'CONSOLE', method, args })
        )
      } catch {}
    }

    console.log = function (...args: any[]) {
      originalLog.apply(console, args as any)
      send('log', args)
    }

    console.warn = function (...args: any[]) {
      originalWarn.apply(console, args as any)
      send('warn', args)
    }

    console.error = function (...args: any[]) {
      originalError.apply(console, args as any)
      send('error', args)
    }

    console.info = function (...args: any[]) {
      originalInfo.apply(console, args as any)
      send('info', args)
    }

    console.debug = function (...args: any[]) {
      originalDebug.apply(console, args as any)
      send('debug', args)
    }

    ;(window as any).__consolePatched = true
    // Boot message to confirm injection ran
    console.log('[Injected] Console bridge installed')
  }


  // Theme-color extraction — sample meta tag or page background and post to React Native
  ;(function () {
    function getThemeColor(): string | null {
      const meta = document.querySelector('meta[name="theme-color"]') as HTMLMetaElement | null
      if (meta?.content) return meta.content.trim()
      const body = document.body
      const html = document.documentElement
      for (const el of [body, html]) {
        if (!el) continue
        const bg = getComputedStyle(el).backgroundColor
        if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg
      }
      return null
    }
    function sendThemeColor() {
      const color = getThemeColor()
      ;(window as any).ReactNativeWebView?.postMessage(
        JSON.stringify({ type: 'THEME_COLOR', color })
      )
    }
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      setTimeout(sendThemeColor, 50)
    } else {
      window.addEventListener('DOMContentLoaded', () => setTimeout(sendThemeColor, 50))
    }
    const observer = new MutationObserver(() => sendThemeColor())
    observer.observe(document.head || document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['content']
    })
  })()

  // Global active media streams tracker for cleanup on navigation
  ;(function () {
    try {
      const g: any = window as any
      if (!g.__activeMediaStreams) {
        g.__activeMediaStreams = new Set()
      }
      const activeSet: Set<any> = g.__activeMediaStreams

      function registerMockStream(stream: any) {
        try {
          activeSet.add(stream)
        } catch {}
        return stream
      }

      function stopAllActiveStreams() {
        try {
          activeSet.forEach((s: any) => {
            try {
              const tracks = s?.getTracks?.() || []
              tracks.forEach((t: any) => {
                try {
                  t.stop && t.stop()
                } catch {}
              })
            } catch {}
          })
          activeSet.clear()
        } catch {}
      }

      // Attach cleanup on pagehide/unload
      window.addEventListener('pagehide', stopAllActiveStreams)
      window.addEventListener('beforeunload', stopAllActiveStreams)

      // Expose helpers for internal use in this polyfill
      ;(g as any).__registerMockStream = registerMockStream
      ;(g as any).__stopAllMockStreams = stopAllActiveStreams
    } catch {}
  })()

  // File download interception — capture <a download>, blob URLs, and data URLs
  ;(function () {
    if ((window as any).__downloadInterceptInstalled) return
    ;(window as any).__downloadInterceptInstalled = true
    try {
      console.log('[DL] download intercept installing')

      // Track blobs created via URL.createObjectURL so we can read them later
      const blobRegistry = new Map<string, Blob>()
      ;(window as any).__blobRegistry = blobRegistry
      const origCreateObjectURL = URL.createObjectURL
      const origRevokeObjectURL = URL.revokeObjectURL

      URL.createObjectURL = function (obj: Blob | MediaSource) {
        const url = origCreateObjectURL.call(URL, obj)
        if (obj instanceof Blob) {
          blobRegistry.set(url, obj)
          console.log('[DL] createObjectURL registered blob, url=', url, 'size=', (obj as Blob).size)
        }
        return url
      }

      URL.revokeObjectURL = function (url: string) {
        console.log('[DL] revokeObjectURL', url, 'inRegistry=', blobRegistry.has(url))
        // Delay registry removal so async handlers (e.g. onShouldStartLoadWithRequest)
        // can still read the Blob object after the URL is revoked
        setTimeout(function () { blobRegistry.delete(url) }, 10000)
        return origRevokeObjectURL.call(URL, url)
      }

      // Helper: read a Blob as base64 and post to React Native
      function sendBlobAsBase64(blob: Blob, filename: string | null, mimeType: string) {
        console.log('[DL] sendBlobAsBase64 filename=', filename, 'mimeType=', mimeType, 'size=', blob.size)
        const reader = new FileReader()
        reader.onloadend = function () {
          if (typeof reader.result !== 'string') return
          // reader.result is "data:<mime>;base64,<data>" — strip prefix
          const base64 = reader.result.split(',')[1] || ''
          ;(window as any).ReactNativeWebView?.postMessage(
            JSON.stringify({
              type: 'FILE_DOWNLOAD_BLOB',
              base64: base64,
              mimeType: mimeType || 'application/octet-stream',
              filename: filename || null,
            })
          )
        }
        reader.readAsDataURL(blob)
      }

      // Override HTMLAnchorElement.prototype.click to catch detached-element programmatic clicks
      // (e.g. `a.click()` called on an element never appended to the DOM)
      const origAnchorClick = HTMLAnchorElement.prototype.click
      HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
        const href = this.href
        console.log('[DL] anchor.click() intercepted href=', href)
        if (href && href.startsWith('blob:')) {
          const blob = blobRegistry.get(href)
          console.log('[DL] blob: url click, inRegistry=', !!blob)
          if (blob) {
            sendBlobAsBase64(blob, this.getAttribute('download'), blob.type || 'application/octet-stream')
            return
          }
        }
        if (href && href.startsWith('data:')) {
          fetch(href)
            .then(function (r) { return r.blob() })
            .then(function (b) {
              sendBlobAsBase64(b, (this as HTMLAnchorElement).getAttribute('download'), b.type || 'application/octet-stream')
            }.bind(this))
            .catch(function () {})
          return
        }
        return origAnchorClick.call(this)
      }

      // Intercept anchor clicks in the capture phase (for attached elements)
      document.addEventListener(
        'click',
        function (e: MouseEvent) {
          const anchor = (e.target as HTMLElement)?.closest?.('a') as HTMLAnchorElement | null
          if (!anchor) return
          const href = anchor.href
          if (!href) return

          const hasDownload = anchor.hasAttribute('download')
          const downloadAttr = anchor.getAttribute('download') || null

          // blob: URL — intercept regardless of download attribute
          if (href.startsWith('blob:')) {
            e.preventDefault()
            e.stopImmediatePropagation()
            const blob = blobRegistry.get(href)
            if (blob) {
              sendBlobAsBase64(blob, downloadAttr, blob.type || 'application/octet-stream')
            } else {
              fetch(href)
                .then(function (r) { return r.blob() })
                .then(function (b) {
                  sendBlobAsBase64(b, downloadAttr, b.type || 'application/octet-stream')
                })
                .catch(function () {})
            }
            return
          }

          // data: URL — intercept regardless of download attribute
          if (href.startsWith('data:')) {
            e.preventDefault()
            e.stopImmediatePropagation()
            fetch(href)
              .then(function (r) { return r.blob() })
              .then(function (b) {
                sendBlobAsBase64(b, downloadAttr, b.type || 'application/octet-stream')
              })
              .catch(function () {})
            return
          }

          // Regular URL with download attribute — let native side handle it
          if (!hasDownload) return
          e.preventDefault()
          e.stopImmediatePropagation()
          ;(window as any).ReactNativeWebView?.postMessage(
            JSON.stringify({
              type: 'FILE_DOWNLOAD_URL',
              url: href,
              filename: downloadAttr,
            })
          )
        },
        true // capture phase
      )

      // Override window.open for blob/data URL popups
      const origOpen = window.open
      ;(window as any).open = function (url?: string, target?: string, features?: string) {
        if (url && url.startsWith('blob:')) {
          const blob = blobRegistry.get(url)
          if (blob) {
            sendBlobAsBase64(blob, null, blob.type || 'application/octet-stream')
            return null
          }
        }
        if (url && url.startsWith('data:')) {
          fetch(url)
            .then(function (r) { return r.blob() })
            .then(function (b) {
              sendBlobAsBase64(b, null, b.type || 'application/octet-stream')
            })
            .catch(function () {})
          return null
        }
        return origOpen?.call(window, url, target, features) || null
      }
    } catch (e) {
      // Silently fail — download interception is non-critical
    }
  })()

  // Camera access polyfill - provides mock streams to prevent WKWebView camera access.
  // On Android the WebView can access the camera natively via getUserMedia, so we skip
  // this polyfill and let the native path (+ onPermissionRequest) handle it instead.
  if (!isAndroid) ;(function () {
    if (!navigator.mediaDevices) return

    const originalGetUserMedia = navigator.mediaDevices.getUserMedia?.bind(navigator.mediaDevices)

    function createMockMediaStream() {
      const mockTrack = {
        id: 'mock-video-' + Date.now(),
        kind: 'video',
        label: 'React Native Camera',
        enabled: true,
        muted: false,
        readyState: 'live',
        stop() {
          this.readyState = 'ended'
        },
        addEventListener() {},
        removeEventListener() {},
        getSettings: () => ({ width: 640, height: 480, frameRate: 30 })
      }

      return {
        id: 'mock-stream-' + Date.now(),
        active: true,
        getTracks: () => [mockTrack],
        getVideoTracks: () => [mockTrack],
        getAudioTracks: () => [],
        addEventListener() {},
        removeEventListener() {}
      }
    }

    navigator.mediaDevices.getUserMedia = function (constraints) {
      const hasVideo = constraints?.video === true || (typeof constraints?.video === 'object' && constraints.video)

      if (hasVideo) {
        // Notify React Native of camera request
        ;(window as any).ReactNativeWebView?.postMessage(
          JSON.stringify({
            type: 'CAMERA_REQUEST',
            constraints
          })
        )

        // Return mock stream immediately to prevent native camera
        return Promise.resolve(createMockMediaStream())
      }

      // Allow audio-only requests through original implementation
      return originalGetUserMedia ? originalGetUserMedia(constraints) : Promise.reject(new Error('Media not supported'))
    }
  })()

  // Push Notification API polyfill
  ;(function () {
    // Check if Notification API already exists
    if ('Notification' in window) {
      return
    }
    ;(function () {
      const style = document.createElement('style')
      style.innerHTML = '* { -webkit-tap-highlight-color: transparent; }'
      document.head.appendChild(style)
    })()
    // Polyfill Notification constructor
    ;(window as any).Notification = function (this: any, title: string, options: any = {}) {
      this.title = title
      this.body = options.body || ''
      this.icon = options.icon || ''
      this.tag = options.tag || ''
      this.data = options.data || null

      // Send notification to native
      ;(window as any).ReactNativeWebView?.postMessage(
        JSON.stringify({
          type: 'SHOW_NOTIFICATION',
          title: this.title,
          body: this.body,
          icon: this.icon,
          tag: this.tag,
          data: this.data
        })
      )

      return this
    } as any

    // Static methods
    ;(window as any).Notification.requestPermission = function (callback?: (permission: string) => void) {
      return new Promise(resolve => {
        ;(window as any).ReactNativeWebView?.postMessage(
          JSON.stringify({
            type: 'REQUEST_NOTIFICATION_PERMISSION',
            callback: true
          })
        )

        // Listen for response
        const handler = (event: MessageEvent) => {
          try {
            const data = JSON.parse((event as any).data)
            if (data.type === 'NOTIFICATION_PERMISSION_RESPONSE') {
              window.removeEventListener('message', handler)
              const permission = data.permission
              if (callback) callback(permission)
              resolve(permission)
            }
          } catch {}
        }
        window.addEventListener('message', handler)
      })
    }
    ;(window as any).Notification.permission = 'default'

    // ServiceWorker registration polyfill for push
    if (!('serviceWorker' in navigator)) {
      ;(navigator as any).serviceWorker = {
        register: function () {
          return Promise.resolve({
            pushManager: {
              subscribe: function (options: any) {
                return new Promise(resolve => {
                  ;(window as any).ReactNativeWebView?.postMessage(
                    JSON.stringify({
                      type: 'PUSH_SUBSCRIBE',
                      options: options
                    })
                  )

                  const handler = (event: MessageEvent) => {
                    try {
                      const data = JSON.parse((event as any).data)
                      if (data.type === 'PUSH_SUBSCRIPTION_RESPONSE') {
                        window.removeEventListener('message', handler)
                        resolve(data.subscription)
                      }
                    } catch {}
                  }
                  window.addEventListener('message', handler)
                })
              },
              getSubscription: function () {
                return new Promise(resolve => {
                  ;(window as any).ReactNativeWebView?.postMessage(
                    JSON.stringify({
                      type: 'GET_PUSH_SUBSCRIPTION'
                    })
                  )

                  const handler = (event: MessageEvent) => {
                    try {
                      const data = JSON.parse((event as any).data)
                      if (data.type === 'PUSH_SUBSCRIPTION_RESPONSE') {
                        window.removeEventListener('message', handler)
                        resolve(data.subscription)
                      }
                    } catch {}
                  }
                  window.addEventListener('message', handler)
                })
              }
            }
          })
        }
      }
    }

    // Fullscreen API polyfill
    if (!document.documentElement.requestFullscreen) {
      ;(document.documentElement as any).requestFullscreen = function () {
        return new Promise((resolve, reject) => {
          ;(window as any).ReactNativeWebView?.postMessage(
            JSON.stringify({
              type: 'REQUEST_FULLSCREEN'
            })
          )

          const handler = (event: MessageEvent) => {
            try {
              const data = JSON.parse((event as any).data)
              if (data.type === 'FULLSCREEN_RESPONSE') {
                window.removeEventListener('message', handler)
                if (data.success) {
                  resolve(undefined)
                } else {
                  reject(new Error('Fullscreen request denied'))
                }
              }
            } catch {}
          }
          window.addEventListener('message', handler)
        })
      }
    }

    if (!document.exitFullscreen) {
      ;(document as any).exitFullscreen = function () {
        return new Promise(resolve => {
          ;(window as any).ReactNativeWebView?.postMessage(
            JSON.stringify({
              type: 'EXIT_FULLSCREEN'
            })
          )

          const handler = (event: MessageEvent) => {
            try {
              const data = JSON.parse((event as any).data)
              if (data.type === 'FULLSCREEN_RESPONSE') {
                window.removeEventListener('message', handler)
                resolve(undefined)
              }
            } catch {}
          }
          window.addEventListener('message', handler)
        })
      }
    }

    // Define fullscreen properties
    Object.defineProperty(document, 'fullscreenElement', {
      get: function () {
        return (window as any).__fullscreenElement || null
      }
    })

    Object.defineProperty(document as any, 'fullscreen', {
      get: function () {
        return !!(window as any).__fullscreenElement
      }
    })

    // Listen for fullscreen changes from native
    window.addEventListener('message', function (event: MessageEvent) {
      try {
        const data = JSON.parse((event as any).data)
        if (data.type === 'FULLSCREEN_CHANGE') {
          ;(window as any).__fullscreenElement = data.isFullscreen ? document.documentElement : null
          document.dispatchEvent(new Event('fullscreenchange'))
        }
      } catch {}
    })

    // Completely replace getUserMedia to prevent WKWebView camera access
    if (navigator.mediaDevices) {
      // Completely override getUserMedia - never call original for video constraints
      navigator.mediaDevices.getUserMedia = function (constraints: any) {
        console.log('[WebView] getUserMedia intercepted:', constraints)

        // Check if requesting video - if so, handle in React Native
        const hasVideo =
          constraints &&
          (constraints.video === true || (typeof constraints.video === 'object' && constraints.video !== false))

        if (hasVideo) {
          console.log('[WebView] Video requested - handling in React Native')
          // Send request to native - handle camera completely in React Native
          ;(window as any).ReactNativeWebView?.postMessage(
            JSON.stringify({
              type: 'CAMERA_REQUEST',
              constraints: constraints
            })
          )

          return new Promise((resolve, reject) => {
            const handler = (event: MessageEvent) => {
              try {
                const data = JSON.parse((event as any).data)
                if (data.type === 'CAMERA_RESPONSE') {
                  window.removeEventListener('message', handler)
                  if (data.success) {
                    // Create a more complete mock MediaStream
                    const mockVideoTrack: any = {
                      id: 'mock-video-track-' + Date.now(),
                      kind: 'video',
                      label: 'React Native Camera',
                      enabled: true,
                      muted: false,
                      readyState: 'live',
                      stop: () => console.log('[WebView] Mock video track stopped'),
                      addEventListener: () => {},
                      removeEventListener: () => {},
                      dispatchEvent: () => false,
                      getSettings: () => ({ width: 640, height: 480, frameRate: 30 }),
                      getCapabilities: () => ({ width: { min: 320, max: 1920 }, height: { min: 240, max: 1080 } }),
                      getConstraints: () => constraints.video || {}
                    }

                    const mockStream: any = {
                      id: 'mock-stream-' + Date.now(),
                      active: true,
                      getTracks: () => [mockVideoTrack],
                      getVideoTracks: () => [mockVideoTrack],
                      getAudioTracks: () => [],
                      addEventListener: () => {},
                      removeEventListener: () => {},
                      dispatchEvent: () => false,
                      addTrack: () => {},
                      removeTrack: () => {},
                      clone: () => mockStream
                    }
                    console.log('[WebView] Resolving with mock stream:', mockStream)
                    // Register for unified cleanup
                    try {
                      ;(window as any).__registerMockStream?.(mockStream)
                    } catch {}
                    resolve(mockStream)
                  } else {
                    reject(new Error(data.error || 'Camera access denied'))
                  }
                }
              } catch (e) {
                reject(e)
              }
            }
            window.addEventListener('message', handler)

            // Timeout after 10 seconds
            setTimeout(() => {
              window.removeEventListener('message', handler)
              reject(new Error('Camera request timeout'))
            }, 10000)
          })
        } else if (constraints && constraints.audio && !hasVideo) {
          // Handle microphone requests in React Native
          console.log('[WebView] Audio-only requested - handling in React Native')
          ;(window as any).ReactNativeWebView?.postMessage(
            JSON.stringify({
              type: 'MICROPHONE_REQUEST',
              constraints: constraints
            })
          )

          return new Promise((resolve, reject) => {
            const handler = (event: MessageEvent) => {
              try {
                const data = JSON.parse((event as any).data)
                if (data.type === 'MICROPHONE_RESPONSE') {
                  window.removeEventListener('message', handler)
                  if (data.success) {
                    // Create a mock audio-only MediaStream
                    const mockAudioTrack: any = {
                      id: 'mock-audio-track-' + Date.now(),
                      kind: 'audio',
                      label: 'React Native Microphone',
                      enabled: true,
                      muted: false,
                      readyState: 'live',
                      stop: () => console.log('[WebView] Mock audio track stopped'),
                      addEventListener: () => {},
                      removeEventListener: () => {},
                      dispatchEvent: () => false,
                      getSettings: () => ({ sampleRate: 48000, channelCount: 1 }),
                      getCapabilities: () => ({ sampleRate: { min: 8000, max: 48000 } }),
                      getConstraints: () => constraints.audio || {}
                    }

                    const mockStream: any = {
                      id: 'mock-audio-stream-' + Date.now(),
                      active: true,
                      getTracks: () => [mockAudioTrack],
                      getVideoTracks: () => [],
                      getAudioTracks: () => [mockAudioTrack],
                      addEventListener: () => {},
                      removeEventListener: () => {},
                      dispatchEvent: () => false,
                      addTrack: () => {},
                      removeTrack: () => {},
                      clone: () => mockStream
                    }
                    console.log('[WebView] Resolving with mock audio stream:', mockStream)
                    // Register for unified cleanup
                    try {
                      ;(window as any).__registerMockStream?.(mockStream)
                    } catch {}
                    resolve(mockStream)
                  } else {
                    reject(new Error(data.error || 'Microphone access denied'))
                  }
                }
              } catch (e) {
                reject(e)
              }
            }
            window.addEventListener('message', handler)

            // Timeout after 10 seconds
            setTimeout(() => {
              window.removeEventListener('message', handler)
              reject(new Error('Microphone request timeout'))
            }, 10000)
          })
        } else {
          // No media requested
          return Promise.reject(new Error('No media constraints specified'))
        }
      }

      // Also override the deprecated navigator.getUserMedia if it exists
      if ((navigator as any).getUserMedia) {
        ;(navigator as any).getUserMedia = function (constraints: any, success: any, error: any) {
          navigator.mediaDevices.getUserMedia(constraints).then(success).catch(error)
        }
      }
    }

    // Fallback: only patch if early bridge above didn't run
    if (!(window as any).__consolePatched) {
      const originalLog = console.log
      const originalWarn = console.warn
      const originalError = console.error
      const originalInfo = console.info
      const originalDebug = console.debug

      console.log = function (...args: any[]) {
        originalLog.apply(console, args as any)
        ;(window as any).ReactNativeWebView?.postMessage(
          JSON.stringify({
            type: 'CONSOLE',
            method: 'log',
            args: args
          })
        )
      }

      console.warn = function (...args: any[]) {
        originalWarn.apply(console, args as any)
        ;(window as any).ReactNativeWebView?.postMessage(
          JSON.stringify({
            type: 'CONSOLE',
            method: 'warn',
            args: args
          })
        )
      }

      console.error = function (...args: any[]) {
        originalError.apply(console, args as any)
        ;(window as any).ReactNativeWebView?.postMessage(
          JSON.stringify({
            type: 'CONSOLE',
            method: 'error',
            args: args
          })
        )
      }

      console.info = function (...args: any[]) {
        originalInfo.apply(console, args as any)
        ;(window as any).ReactNativeWebView?.postMessage(
          JSON.stringify({
            type: 'CONSOLE',
            method: 'info',
            args: args
          })
        )
      }

      console.debug = function (...args: any[]) {
        originalDebug.apply(console, args as any)
        ;(window as any).ReactNativeWebView?.postMessage(
          JSON.stringify({
            type: 'CONSOLE',
            method: 'debug',
            args: args
          })
        )
      }

      ;(window as any).__consolePatched = true
    }

    // Intercept fetch requests to add Accept-Language header
    const originalFetch = (window as any).fetch
    ;(window as any).fetch = function (input: any, init: any = {}) {
      // Merge headers
      const headers = new Headers(init.headers)
      if (!headers.has('Accept-Language')) {
        headers.set('Accept-Language', acceptLanguage)
      }

      // Update init with new headers
      const newInit = {
        ...init,
        headers: headers
      }

      return originalFetch.call(this, input, newInit)
    }

    // Also intercept XMLHttpRequest for older APIs
    const originalXHROpen = XMLHttpRequest.prototype.open
    const originalXHRSend = XMLHttpRequest.prototype.send

    XMLHttpRequest.prototype.open = function (
      this: any,
      method: any,
      url: any,
      async?: any,
      user?: any,
      password?: any
    ) {
      ;(this as any)._method = method
      ;(this as any)._url = url
      return originalXHROpen.call(this, method, url, async, user, password)
    }

    XMLHttpRequest.prototype.send = function (this: any, data: any) {
      // Add Accept-Language header if not already set
      // Note: getRequestHeader does not exist on standard XHR; this matches the previous behavior
      if (!(this as any).getRequestHeader || !(this as any).getRequestHeader('Accept-Language')) {
        ;(this as any).setRequestHeader('Accept-Language', acceptLanguage)
      }
      return originalXHRSend.call(this, data)
    }
  })()
}

export function buildInjectedJavaScript(acceptLanguage: string, isAndroid: boolean) {
  // Serialize the function and immediately invoke it with the provided arguments
  return `(${injectedPolyfills.toString()})(${JSON.stringify(acceptLanguage)}, ${isAndroid});`
}

