import type { MutableRefObject } from 'react'
import type { PermissionType, PermissionState } from '@/utils/permissionsManager'
import { Platform } from 'react-native'
import { setDomainPermission } from '@/utils/permissionsManager'

type ActiveTabLike = {
  id: string | number
  url: string
  webviewRef?: { current?: { injectJavaScript: (js: string) => void } | null }
}

export type WebViewMessage = {
  type?: string
  constraints?: any
  [key: string]: any
}

export type MessageRouterCtx = {
  getActiveTab: () => ActiveTabLike | null | undefined
  domainForUrl: (u: string) => string
  getPermissionState: (domain: string, permission: PermissionType) => Promise<PermissionState>
  setPendingDomain: (d: string) => void
  setPendingPermission: (p: PermissionType) => void
  setPendingCallback: (cb: (granted: boolean) => void) => void
  setPermissionModalVisible: (v: boolean) => void
  activeCameraStreams: MutableRefObject<Set<string>>
  setIsFullscreen: (v: boolean) => void
}

function injectIntoActiveTab(ctx: MessageRouterCtx, js: string) {
  const tab = ctx.getActiveTab()
  tab?.webviewRef?.current?.injectJavaScript(js)
}

export function createWebViewMessageRouter(ctx: MessageRouterCtx) {
  const handleFullscreenEnter = async () => {
    ctx.setIsFullscreen(true)
    injectIntoActiveTab(
      ctx,
      `
      window.dispatchEvent(new MessageEvent('message', {
        data: JSON.stringify({ type: 'FULLSCREEN_RESPONSE', success: true })
      }));
      window.dispatchEvent(new MessageEvent('message', {
        data: JSON.stringify({ type: 'FULLSCREEN_CHANGE', isFullscreen: true })
      }));
    `
    )
    return true
  }

  const handleFullscreenExit = async () => {
    ctx.setIsFullscreen(false)
    injectIntoActiveTab(
      ctx,
      `
      window.dispatchEvent(new MessageEvent('message', {
        data: JSON.stringify({ type: 'FULLSCREEN_RESPONSE', success: true })
      }));
      window.dispatchEvent(new MessageEvent('message', {
        data: JSON.stringify({ type: 'FULLSCREEN_CHANGE', isFullscreen: false })
      }));
    `
    )
    return true
  }

  const handlePermissionRequest = async (
    messageType: 'CAMERA_REQUEST' | 'MICROPHONE_REQUEST',
    permission: PermissionType,
    responseType: 'CAMERA_RESPONSE' | 'MICROPHONE_RESPONSE'
  ) => {
    const tab = ctx.getActiveTab()
    if (!tab) return true

    const domain = ctx.domainForUrl(tab.url)

    if (messageType === 'CAMERA_REQUEST') {
      // Track active camera stream per tab
      ctx.activeCameraStreams.current.add(String(tab.id))
    }

    const currentState = await ctx.getPermissionState(domain, permission)

    if (currentState === 'allow') {
      injectIntoActiveTab(
        ctx,
        `
        window.dispatchEvent(new MessageEvent('message', {
          data: JSON.stringify({ type: '${responseType}', success: true })
        }));
        // Clear pending and denied arrays for this permission (compat with permissionScript)
        (function(){ try{
          var P = '${permission}';
          if (!Array.isArray(window.__metanetPendingPermissions)) window.__metanetPendingPermissions = [];
          if (!Array.isArray(window.__metanetDeniedPermissions)) window.__metanetDeniedPermissions = [];
          var pend = window.__metanetPendingPermissions;
          var deny = window.__metanetDeniedPermissions;
          var rm = function(arr){ var i = arr.indexOf(P); if (i >= 0) arr.splice(i,1); };
          rm(pend); rm(deny);
        }catch(e){} })();
      `
      )
      injectIntoActiveTab(
        ctx,
        `
        (function(){ try{ const evt = new CustomEvent('permissionchange', { detail: { permission: '${permission}', state: 'granted' } }); document.dispatchEvent(evt); }catch(e){} })();
      `
      )
      return true
    }

    if (currentState === 'deny') {
      injectIntoActiveTab(
        ctx,
        `
        window.dispatchEvent(new MessageEvent('message', {
          data: JSON.stringify({ type: '${responseType}', success: false, error: '${permission === 'CAMERA' ? 'Camera' : 'Microphone'} permission denied' })
        }));
        // Update pending/denied arrays (compat with permissionScript)
        (function(){ try{
          var P = '${permission}';
          if (!Array.isArray(window.__metanetPendingPermissions)) window.__metanetPendingPermissions = [];
          if (!Array.isArray(window.__metanetDeniedPermissions)) window.__metanetDeniedPermissions = [];
          var pend = window.__metanetPendingPermissions;
          var deny = window.__metanetDeniedPermissions;
          console.log(pend)
          console.log(deny)
          var rm = function(arr){ var i = arr.indexOf(P); if (i >= 0) arr.splice(i,1); };
          rm(pend);
          if (deny.indexOf(P) === -1) deny.push(P);
        }catch(e){} })();
      `
      )
      injectIntoActiveTab(
        ctx,
        `
        (function(){ try{ const evt = new CustomEvent('permissionchange', { detail: { permission: '${permission}', state: 'denied' } }); document.dispatchEvent(evt); }catch(e){} })();
      `
      )
      return true
    }

    // iOS: never show in-app PermissionModal for camera/microphone. Auto-allow when state is 'ask'.
    if (Platform.OS === 'ios') {
      try {
        await setDomainPermission(domain, permission, 'allow')
      } catch (e) {}
      injectIntoActiveTab(
        ctx,
        `
        window.dispatchEvent(new MessageEvent('message', {
          data: JSON.stringify({ type: '${responseType}', success: true })
        }));
        // Clear pending and denied arrays for this permission (compat with permissionScript)
        (function(){ try{
          var P = '${permission}';
          if (!Array.isArray(window.__metanetPendingPermissions)) window.__metanetPendingPermissions = [];
          if (!Array.isArray(window.__metanetDeniedPermissions)) window.__metanetDeniedPermissions = [];
          var pend = window.__metanetPendingPermissions;
          var deny = window.__metanetDeniedPermissions;
          var rm = function(arr){ var i = arr.indexOf(P); if (i >= 0) arr.splice(i,1); };
          rm(pend); rm(deny);
        }catch(e){} })();
        (function(){ try{ const evt = new CustomEvent('permissionchange', { detail: { permission: '${permission}', state: 'granted' } }); document.dispatchEvent(evt); }catch(e){} })();
      `
      )
      return true
    }

    // Prompt via PermissionModal, resolve later via pending callback
    ctx.setPendingDomain(domain)
    ctx.setPendingPermission(permission)
    ctx.setPendingCallback((granted: boolean) => {
      const currentTab = ctx.getActiveTab()
      if (!currentTab) return
      const currentDomain = ctx.domainForUrl(currentTab.url)
      if (currentDomain !== domain) return

      const successJs = `
        window.dispatchEvent(new MessageEvent('message', {
          data: JSON.stringify({ type: '${responseType}', success: true })
        }));
      `
      const failJs = `
        window.dispatchEvent(new MessageEvent('message', {
          data: JSON.stringify({ type: '${responseType}', success: false, error: '${permission === 'CAMERA' ? 'Camera' : 'Microphone'} permission denied' })
        }));
      `
      const permissionChangeJs = `
        (function(){ try{ const evt = new CustomEvent('permissionchange', { detail: { permission: '${permission}', state: '${granted ? 'granted' : 'denied'}' } }); document.dispatchEvent(evt); }catch(e){} })();
      `
      const syncArraysJs = `
        (function(){ try{
          var P = '${permission}';
          if (!Array.isArray(window.__metanetPendingPermissions)) window.__metanetPendingPermissions = [];
          if (!Array.isArray(window.__metanetDeniedPermissions)) window.__metanetDeniedPermissions = [];
          var pend = window.__metanetPendingPermissions;
          var deny = window.__metanetDeniedPermissions;

          console.log(pend)
          console.log(deny)

          var rm = function(arr){ var i = arr.indexOf(P); if (i >= 0) arr.splice(i,1); };
          rm(pend);
          var granted = ${granted ? 'true' : 'false'};
          if (granted === true) { rm(deny); } else { if (deny.indexOf(P) === -1) deny.push(P); }
        }catch(e){} })();
      `
      currentTab.webviewRef?.current?.injectJavaScript(
        (granted ? successJs : failJs) + permissionChangeJs + syncArraysJs
      )
    })
    ctx.setPermissionModalVisible(true)
    return true
  }

  const handleLocationRequest = async () => {
    const tab = ctx.getActiveTab()
    if (!tab) return true
    const domain = ctx.domainForUrl(tab.url)

    const permission: PermissionType = 'ACCESS_FINE_LOCATION'
    const currentState = await ctx.getPermissionState(domain, permission)

    if (currentState === 'allow') {
      injectIntoActiveTab(
        ctx,
        `
        // Clear pending and denied arrays for this permission (compat with permissionScript)
        (function(){ try{
          var P = '${permission}';
          if (!Array.isArray(window.__metanetPendingPermissions)) window.__metanetPendingPermissions = [];
          if (!Array.isArray(window.__metanetDeniedPermissions)) window.__metanetDeniedPermissions = [];
          var pend = window.__metanetPendingPermissions;
          var deny = window.__metanetDeniedPermissions;
          var rm = function(arr){ var i = arr.indexOf(P); if (i >= 0) arr.splice(i,1); };
          rm(pend); rm(deny);
        }catch(e){} })();
        (function(){ try{ const evt = new CustomEvent('permissionchange', { detail: { permission: '${permission}', state: 'granted' } }); document.dispatchEvent(evt); }catch(e){} })();
      `
      )
      return true
    }

    if (currentState === 'deny') {
      injectIntoActiveTab(
        ctx,
        `
        // Update pending/denied arrays (compat with permissionScript)
        (function(){ try{
          var P = '${permission}';
          if (!Array.isArray(window.__metanetPendingPermissions)) window.__metanetPendingPermissions = [];
          if (!Array.isArray(window.__metanetDeniedPermissions)) window.__metanetDeniedPermissions = [];
          var pend = window.__metanetPendingPermissions;
          var deny = window.__metanetDeniedPermissions;
          var rm = function(arr){ var i = arr.indexOf(P); if (i >= 0) arr.splice(i,1); };
          rm(pend);
          if (deny.indexOf(P) === -1) deny.push(P);
        }catch(e){} })();
        (function(){ try{ const evt = new CustomEvent('permissionchange', { detail: { permission: '${permission}', state: 'denied' } }); document.dispatchEvent(evt); }catch(e){} })();
      `
      )
      return true
    }

    // iOS: never show in-app PermissionModal for location.
    // Auto-allow at the domain level and signal 'granted' so the page's wrapper calls the original geolocation,
    // which triggers the OS location prompt. This avoids react-native-permissions.
    if (Platform.OS === 'ios') {
      try { await setDomainPermission(domain, permission, 'allow') } catch(e) {}
      injectIntoActiveTab(
        ctx,
        `
        (function(){ try{
          var P = '${permission}';
          if (!Array.isArray(window.__metanetPendingPermissions)) window.__metanetPendingPermissions = [];
          if (!Array.isArray(window.__metanetDeniedPermissions)) window.__metanetDeniedPermissions = [];
          var pend = window.__metanetPendingPermissions;
          var deny = window.__metanetDeniedPermissions;
          var rm = function(arr){ var i = arr.indexOf(P); if (i >= 0) arr.splice(i,1); };
          rm(pend); rm(deny);
        }catch(e){} })();
        (function(){ try{ const evt = new CustomEvent('permissionchange', { detail: { permission: '${permission}', state: 'granted' } }); document.dispatchEvent(evt); }catch(e){} })();
      `
      )
      return true
    }

    // Prompt via PermissionModal, resolve later via pending callback
    ctx.setPendingDomain(domain)
    ctx.setPendingPermission(permission)
    ctx.setPendingCallback((granted: boolean) => {
      const currentTab = ctx.getActiveTab()
      if (!currentTab) return
      const currentDomain = ctx.domainForUrl(currentTab.url)
      if (currentDomain !== domain) return

      const permissionChangeJs = `
        (function(){ try{ const evt = new CustomEvent('permissionchange', { detail: { permission: '${permission}', state: '${granted ? 'granted' : 'denied'}' } }); document.dispatchEvent(evt); }catch(e){} })();
      `
      const syncArraysJs = `
        (function(){ try{
          var P = '${permission}';
          if (!Array.isArray(window.__metanetPendingPermissions)) window.__metanetPendingPermissions = [];
          if (!Array.isArray(window.__metanetDeniedPermissions)) window.__metanetDeniedPermissions = [];
          var pend = window.__metanetPendingPermissions;
          var deny = window.__metanetDeniedPermissions;
          var rm = function(arr){ var i = arr.indexOf(P); if (i >= 0) arr.splice(i,1); };
          rm(pend);
          var granted = ${granted ? 'true' : 'false'};
          if (granted === true) { rm(deny); } else { if (deny.indexOf(P) === -1) deny.push(P); }
        }catch(e){} })();
      `
      currentTab.webviewRef?.current?.injectJavaScript(permissionChangeJs + syncArraysJs)
    })
    ctx.setPermissionModalVisible(true)
    return true
  }

  return async function route(msg: WebViewMessage): Promise<boolean> {
    switch (msg.type) {
      case 'REQUEST_FULLSCREEN':
        return handleFullscreenEnter()
      case 'EXIT_FULLSCREEN':
        return handleFullscreenExit()
      case 'REQUEST_CAMERA':
      case 'CAMERA_REQUEST':
        return handlePermissionRequest('CAMERA_REQUEST', 'CAMERA', 'CAMERA_RESPONSE')
      case 'MICROPHONE_REQUEST':
      case 'REQUEST_MICROPHONE':
        return handlePermissionRequest('MICROPHONE_REQUEST', 'RECORD_AUDIO', 'MICROPHONE_RESPONSE')
      case 'REQUEST_LOCATION':
        return handleLocationRequest()
      default:
        return false
    }
  }
}
