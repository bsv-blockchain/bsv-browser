import { useCallback, useEffect, useState } from 'react'
import {
  PermissionType,
  PermissionState,
  getDomainPermissions,
  setDomainPermission,
  checkPermissionForDomain
} from '@/utils/permissionsManager'
import type { Tab } from '@/shared/types/browser'

export function usePermissions(
  activeTab: Tab | null | undefined,
  domainForUrl: (u: string) => string
) {
  const [permissionModalVisible, setPermissionModalVisible] = useState(false)
  const [pendingPermission, setPendingPermission] = useState<PermissionType | null>(null)
  const [pendingDomain, setPendingDomain] = useState<string | null>(null)
  const [pendingCallback, setPendingCallback] = useState<((granted: boolean) => void) | null>(null)
  const [permissionsDeniedForCurrentDomain, setPermissionsDeniedForCurrentDomain] = useState<PermissionType[]>([])

  const updateDeniedPermissionsForDomain = useCallback(
    async (urlString: string) => {
      try {
        const domain = domainForUrl(urlString)
        if (!domain) {
          setPermissionsDeniedForCurrentDomain([])
          return
        }
        const domainPerms = await getDomainPermissions(domain)
        const denied = Object.entries(domainPerms)
          .filter(([, state]) => state === 'deny')
          .map(([perm]) => perm as PermissionType)
        setPermissionsDeniedForCurrentDomain(denied)
      } catch (e) {
        console.warn('Failed updating denied permissions cache', e)
      }
    },
    [domainForUrl]
  )

  useEffect(() => {
    if (activeTab?.url) {
      updateDeniedPermissionsForDomain(activeTab.url)
    }
  }, [activeTab, updateDeniedPermissionsForDomain])

  const onDecision = useCallback(
    async (granted: boolean) => {
      setPermissionModalVisible(false)
      if (!pendingDomain || !pendingPermission) return

      try {
        await setDomainPermission(pendingDomain, pendingPermission, granted ? 'allow' : 'deny')
        try {
          const osBacked: PermissionType[] = ['ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION'] as any
          if (granted && osBacked.includes(pendingPermission)) {
            await checkPermissionForDomain(pendingDomain, pendingPermission)
          }
        } catch {}

        await updateDeniedPermissionsForDomain(activeTab?.url || '')

        if (activeTab?.url && domainForUrl(activeTab.url) === pendingDomain && activeTab.webviewRef?.current) {
          const updatedDenied = granted
            ? permissionsDeniedForCurrentDomain.filter(p => p !== pendingPermission)
            : [...new Set([...permissionsDeniedForCurrentDomain, pendingPermission])]

          const js = `
            (function () {
              try {
                if (!Array.isArray(window.__metanetDeniedPermissions)) window.__metanetDeniedPermissions = [];
                if (!Array.isArray(window.__metanetPendingPermissions)) window.__metanetPendingPermissions = [];
                window.__metanetDeniedPermissions = ${JSON.stringify(updatedDenied)};
                window.__metanetPendingPermissions = window.__metanetPendingPermissions.filter(p => p !== '${pendingPermission}');
                const evt = new CustomEvent('permissionchange', {
                  detail: { permission: '${pendingPermission}', state: '${granted ? 'granted' : 'denied'}' }
                });
                document.dispatchEvent(evt);
              } catch (e) {}
            })();
          `
          activeTab.webviewRef.current.injectJavaScript(js)
        }
      } finally {
        pendingCallback?.(granted)
        setPendingDomain(null)
        setPendingPermission(null)
        setPendingCallback(null)
      }
    },
    [pendingDomain, pendingPermission, activeTab, permissionsDeniedForCurrentDomain, pendingCallback, domainForUrl, updateDeniedPermissionsForDomain]
  )

  const handlePermissionChange = useCallback(
    async (permission: PermissionType, state: PermissionState) => {
      try {
        const url = activeTab?.url
        const domain = url ? domainForUrl(url) : ''
        if (domain) await setDomainPermission(domain, permission, state)
        try {
          const osBacked: PermissionType[] = ['ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION'] as any
          if (domain && state === 'allow' && osBacked.includes(permission)) {
            await checkPermissionForDomain(domain, permission)
          }
        } catch {}
        if (url) await updateDeniedPermissionsForDomain(url)
        if (activeTab?.webviewRef?.current) {
          const stateStr = state === 'allow' ? 'granted' : state === 'deny' ? 'denied' : 'prompt'
          activeTab.webviewRef.current.injectJavaScript(`
            (function () {
              try {
                const evt = new CustomEvent('permissionchange', { detail: { permission: '${permission}', state: '${stateStr}' } });
                document.dispatchEvent(evt);
              } catch (e) {}
            })();
          `)
        }
      } catch {}
    },
    [activeTab, domainForUrl, updateDeniedPermissionsForDomain]
  )

  /** Config object for the WebView message router */
  const permissionRouterConfig = {
    setPendingDomain: (d: string) => setPendingDomain(d),
    setPendingPermission: (p: PermissionType) => setPendingPermission(p),
    setPendingCallback: (cb: (granted: boolean) => void) => setPendingCallback(() => cb),
    setPermissionModalVisible: (v: boolean) => setPermissionModalVisible(v),
  }

  return {
    permissionModalVisible,
    pendingPermission,
    pendingDomain,
    permissionsDeniedForCurrentDomain,
    onDecision,
    handlePermissionChange,
    permissionRouterConfig,
  }
}
