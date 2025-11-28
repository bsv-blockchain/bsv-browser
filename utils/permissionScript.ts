import { PermissionType } from './permissionsManager'

/**
 * Generates the JavaScript code to be injected into WebView for permission handling
 * @param deniedPermissions List of permissions denied for the current domain
 * @param pendingPermission Currently pending permission (if any)
 * @returns JavaScript code string to be injected
 */
export const getPermissionScript = (
  deniedPermissions: PermissionType[],
  pendingPermission: PermissionType | null
): string => {
  return `
(function() {
  // List of permissions denied for this domain
  const denied = ${JSON.stringify(deniedPermissions)};
  const pending = ${JSON.stringify(pendingPermission)};
  
  window.__metanetDeniedPermissions = Array.isArray(denied) ? denied : (denied ? [denied] : []);
  window.__metanetPendingPermissions = Array.isArray(pending) ? pending : (pending ? [pending] : []);

  // Override console.log to send logs to React Native terminal
  const originalConsoleLog = console.log;
  console.log = function(...args) {
    const message = args.map(arg => 
      typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
    ).join(' ');
    
    // Also call original console.log for any native browser dev tools
    originalConsoleLog.apply(console, args);
  };
  
  console.log('[Metanet] Initializing permission hooks with denied:', denied, 'pending:', pending);

  // Handle camera and microphone access
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.__originalGetUserMedia = originalGetUserMedia;  // save original

    navigator.mediaDevices.getUserMedia = function(constraints) {
      const deniedList = window.__metanetDeniedPermissions || [];
      const pendingList = window.__metanetPendingPermissions || [];

      if (constraints.video && deniedList.includes("CAMERA")) {
        console.log('[Metanet] Camera access denied by site settings');
        return Promise.reject(new DOMException("Camera access denied by site settings", "NotAllowedError"));
      }
      if (constraints.audio && deniedList.includes("RECORD_AUDIO")) {
        console.log('[Metanet] Microphone access denied by site settings');
        return Promise.reject(new DOMException("Microphone access denied by site settings", "NotAllowedError"));
      }

      const camPending = constraints.video && pendingList.includes("CAMERA");
      const micPending = constraints.audio && pendingList.includes("RECORD_AUDIO");
      if (camPending || micPending) {
        console.log('[Metanet] Media permission request pending user decision, delaying response');
        return new Promise((resolve, reject) => {
          const checkInterval = setInterval(() => {
            const stillPending = (constraints.video && window.__metanetPendingPermissions.includes("CAMERA")) 
                              || (constraints.audio && window.__metanetPendingPermissions.includes("RECORD_AUDIO"));
            if (!stillPending) {
              clearInterval(checkInterval);
              clearTimeout(timeoutId);
              console.log('[Metanet] User decided on media permission, continuing request');
              // After decision, check if denied or allowed:
              const cameraNowDenied = constraints.video && window.__metanetDeniedPermissions.includes("CAMERA");
              const micNowDenied    = constraints.audio && window.__metanetDeniedPermissions.includes("RECORD_AUDIO");
              if (cameraNowDenied || micNowDenied) {
                console.log('[Metanet] User denied permission, rejecting request');
                reject(new DOMException("Media access denied by user", "NotAllowedError"));
              } else {
                console.log('[Metanet] User allowed permission, proceeding with request');
                // User allowed - call the original getUserMedia to get the stream
                originalGetUserMedia(constraints).then(resolve).catch(reject);
              }
            }
          }, 100);
          // Safety: if user never responds, time out after 60s
          const timeoutId = setTimeout(() => {
            clearInterval(checkInterval);
            console.warn('[Metanet] Permission request timed out');
            reject(new DOMException("Permission request timed out", "NotAllowedError"));
          }, 60000);
        });
      }

      // Mark as pending and ask React Native to show a prompt:
      if (constraints.video && !deniedList.includes("CAMERA") && !pendingList.includes("CAMERA")) {
        window.__metanetPendingPermissions.push("CAMERA");
        window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'REQUEST_CAMERA' }));
      }
      if (constraints.audio && !deniedList.includes("RECORD_AUDIO") && !pendingList.includes("RECORD_AUDIO")) {
        window.__metanetPendingPermissions.push("RECORD_AUDIO");
        window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'REQUEST_MICROPHONE' }));
      }
      console.log('[Metanet] Media permission requested, waiting for user decision...');
      // Return a Promise that will be resolved/rejected by the polling loop (same as above)
      return new Promise((resolve, reject) => {
        const checkInterval = setInterval(() => {
          const stillPending = (constraints.video && window.__metanetPendingPermissions.includes("CAMERA")) 
                            || (constraints.audio && window.__metanetPendingPermissions.includes("RECORD_AUDIO"));
          if (!stillPending) {
            clearInterval(checkInterval);
            clearTimeout(timeoutId);
            console.log('[Metanet] User decision received, resuming getUserMedia');
            const cameraNowDenied = constraints.video && window.__metanetDeniedPermissions.includes("CAMERA");
            const micNowDenied    = constraints.audio && window.__metanetDeniedPermissions.includes("RECORD_AUDIO");
            if (cameraNowDenied || micNowDenied) {
              reject(new DOMException("Media access denied by user", "NotAllowedError"));
            } else {
              originalGetUserMedia(constraints).then(resolve).catch(reject);
            }
          }
        }, 100);
        const timeoutId = setTimeout(() => {
          clearInterval(checkInterval);
          console.error('[Metanet] Permission request timed out');
          reject(new DOMException("Permission request timed out", "NotAllowedError"));
        }, 60000);
      });
    };
  }
           
  // Handle geolocation access
  if (navigator.geolocation) {
    const originalGetPos = navigator.geolocation.getCurrentPosition.bind(navigator.geolocation);
    const originalWatchPos = navigator.geolocation.watchPosition.bind(navigator.geolocation);
    navigator.geolocation.__originalGetCurrentPosition = originalGetPos;
    navigator.geolocation.__originalWatchPosition = originalWatchPos;

    // If location already denied for this domain, override to error immediately
    if (window.__metanetDeniedPermissions.includes("ACCESS_FINE_LOCATION")) {
      console.log('[Metanet] Location access denied by site settings');
      navigator.geolocation.getCurrentPosition = function(success, error) {
        if (error) error(new Error("Location access denied by site settings"));
      };
      navigator.geolocation.watchPosition = function(success, error) {
        if (error) error(new Error("Location access denied by site settings"));
        return 0;  // return dummy watch ID
      };
    } 
    // If a location request is pending, override to wait until decision
    else if (window.__metanetPendingPermissions.includes("ACCESS_FINE_LOCATION")) {
      console.log('[Metanet] Location permission request pending user decision');
      navigator.geolocation.getCurrentPosition = function(success, error, options) {
        console.log('[Metanet] getCurrentPosition called while permission decision pending');
        const checkInterval = setInterval(() => {
          if (!window.__metanetPendingPermissions.includes("ACCESS_FINE_LOCATION")) {
            clearInterval(checkInterval);
            clearTimeout(timeoutId);
            // Now check decision:
            if (window.__metanetDeniedPermissions.includes("ACCESS_FINE_LOCATION")) {
              console.log('[Metanet] User denied location permission');
              if (error) error(new Error("Location access denied by user"));
            } else {
              console.log('[Metanet] User allowed location permission, proceeding with request');
              originalGetPos(success, error, options);  // call original
            }
          }
        }, 100);
        const timeoutId = setTimeout(() => {
          clearInterval(checkInterval);
          console.warn('[Metanet] Location permission request timed out');
          if (error) error(new Error("Permission request timed out"));
        }, 60000);
      };
      navigator.geolocation.watchPosition = function(success, error, options) {
        console.log('[Metanet] watchPosition called while permission decision pending');
        // We won't start watching until decision; return a dummy ID for now:
        const tempId = -1;
        const checkInterval = setInterval(() => {
          if (!window.__metanetPendingPermissions.includes("ACCESS_FINE_LOCATION")) {
            clearInterval(checkInterval);
            if (window.__metanetDeniedPermissions.includes("ACCESS_FINE_LOCATION")) {
              console.log('[Metanet] User denied location permission');
              if (error) error(new Error("Location access denied by user"));
            } else {
              console.log('[Metanet] User allowed location permission, starting watch');
              navigator.geolocation.__originalWatchPosition.call(navigator.geolocation, success, error, options);
            }
          }
        }, 100);
        return tempId;
      };
    } 
    // If not denied and no pending request yet, we intercept new requests similarly:
    else {
      navigator.geolocation.getCurrentPosition = function(success, error, options) {
        // Mark pending and ask native side:
        window.__metanetPendingPermissions.push("ACCESS_FINE_LOCATION");
        window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'REQUEST_LOCATION' }));
        console.log('[Metanet] Requesting geolocation, awaiting user decision...');
        // Defer the actual call until decision (polling loop similar to above):
        const checkInterval = setInterval(() => {
          if (!window.__metanetPendingPermissions.includes("ACCESS_FINE_LOCATION")) {
            clearInterval(checkInterval);
            clearTimeout(timeoutId);
            if (window.__metanetDeniedPermissions.includes("ACCESS_FINE_LOCATION")) {
              if (error) error(new Error("Location access denied by user"));
            } else {
              originalGetPos(success, error, options);
            }
          }
        }, 100);
        const timeoutId = setTimeout(() => {
          clearInterval(checkInterval);
          if (error) error(new Error("Permission request timed out"));
        }, 60000);
      };
      navigator.geolocation.watchPosition = function(success, error, options) {
        window.__metanetPendingPermissions.push("ACCESS_FINE_LOCATION");
        window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'REQUEST_LOCATION' }));
        console.log('[Metanet] Requesting geolocation (watch), awaiting user decision...');
        let tempId = -1;
        const checkInterval = setInterval(() => {
          if (!window.__metanetPendingPermissions.includes("ACCESS_FINE_LOCATION")) {
            clearInterval(checkInterval);
            if (window.__metanetDeniedPermissions.includes("ACCESS_FINE_LOCATION")) {
              if (error) error(new Error("Location access denied by user"));
            } else {
              // user allowed
              tempId = navigator.geolocation.__originalWatchPosition.call(navigator.geolocation, success, error, options);
            }
          }
        }, 100);
        return tempId;
      };
    }
  }
})();`
}
