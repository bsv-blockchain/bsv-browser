// Polyfill AbortSignal.timeout for Hermes (React Native JS engine)
if (typeof AbortSignal !== 'undefined' && !AbortSignal.timeout) {
  AbortSignal.timeout = (ms: number) => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new Error('TimeoutError')), ms)
    return controller.signal
  }
}

import '../wdyr' // dev-only re-render tracking; must run before any component renders
import '@/utils/devMenu' // dev-only profiling controls in the expo-dev-client menu

import React, { useEffect } from 'react'
import { View, useColorScheme } from 'react-native'
import { Stack } from 'expo-router'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { UserContextProvider, NativeHandlers } from '@bsv/expo-wallet-toolbox/core/context/UserContext'
import packageJson from '../package.json'
import { WalletContextProvider, useWallet } from '@bsv/expo-wallet-toolbox/core/context/WalletContext'
import { ExchangeRateContextProvider } from '@bsv/expo-wallet-toolbox/core/context/ExchangeRateContext'
import { ThemeProvider } from '@bsv/expo-wallet-toolbox/core/theme/ThemeContext'
// TODO: Re-add RecoveryKeySaver when WAB support returns
import LocalStorageProvider from '@bsv/expo-wallet-toolbox/core/context/LocalStorageProvider'
import PermissionSheet from '@bsv/expo-wallet-toolbox/ui/components/ui/PermissionSheet'
import { AlertHost } from '@bsv/expo-wallet-toolbox/ui/components/ui/AlertCard'
import { VaultProvider } from '@bsv/expo-wallet-toolbox/core/context/VaultContext'
import { VaultCeremonySheet } from '@bsv/expo-wallet-toolbox/ui/components/vault/VaultCeremonySheet'
import { ToastHost, showToast } from '@bsv/expo-wallet-toolbox/ui/components/ui/Toast'
import { useDeepLinking } from '@/hooks/useDeepLinking'
import { LanguageProvider } from '@/context/i18n/browserTranslations'
import { BrowserModeProvider } from '@/context/BrowserModeContext'
import Web3BenefitsModalHandler from '@/components/onboarding/Web3BenefitsModalHandler'
import { WalletConnectionProvider } from '@bsv/expo-wallet-toolbox/core/context/WalletConnectionContext'

import AsyncStorage from '@react-native-async-storage/async-storage'
import { ErrorBoundary } from '@bsv/expo-wallet-toolbox/ui/components/ui/ErrorBoundary'
import { configureToolbox } from '@bsv/expo-wallet-toolbox'

// Host-supplied toolbox configuration. Must run at module scope, before anything from the
// package renders or builds a wallet: chaintracksUrlFor and createServiceOptions are plain
// functions called outside React, and they throw if reached before this call.
//
// The reads below must stay literal `process.env.EXPO_PUBLIC_*` member expressions. Babel
// only inlines that exact shape, and it refuses to inline for files under node_modules —
// which is why the toolbox reads no env of its own and takes these values from the host.
//
// backupUrl is the encrypted wallet-backup origin: no trailing slash, no path, because the
// BRC-103/104 handshake posts to the origin root. `null` disables backup entirely — no
// monitor task, nothing sent, no backup UI.
configureToolbox({
  backupUrl: process.env.EXPO_PUBLIC_BACKUP_URL ?? null,
  services: {
    main: {
      arcUrl: process.env.EXPO_PUBLIC_ARC_URL,
      arcApiKey: process.env.EXPO_PUBLIC_ARC_API_KEY,
      chaintracksUrl: process.env.EXPO_PUBLIC_CHAINTRACKS_URL,
      whatsOnChainApiKey: process.env.EXPO_PUBLIC_WOC_API_KEY,
      taalApiKey: process.env.EXPO_PUBLIC_WOC_API_KEY
    },
    test: {
      arcUrl: process.env.EXPO_PUBLIC_TEST_ARC_URL,
      arcApiKey: process.env.EXPO_PUBLIC_TEST_ARC_API_KEY,
      chaintracksUrl: process.env.EXPO_PUBLIC_TEST_CHAINTRACKS_URL,
      whatsOnChainApiKey: process.env.EXPO_PUBLIC_TEST_WOC_API_KEY,
      taalApiKey: process.env.EXPO_PUBLIC_TEST_TAAL_API_KEY
    },
    teratest: {
      arcUrl: process.env.EXPO_PUBLIC_TERATEST_ARC_URL,
      arcApiKey: process.env.EXPO_PUBLIC_TERATEST_ARC_API_KEY,
      chaintracksUrl: process.env.EXPO_PUBLIC_TERATEST_CHAINTRACKS_URL,
      whatsOnChainApiKey: process.env.EXPO_PUBLIC_TERATEST_WOC_API_KEY,
      taalApiKey: process.env.EXPO_PUBLIC_TERATEST_WOC_API_KEY
    }
  }
})

// Fail the release profiles that are supposed to carry backup, loudly, at boot.
//
// The type and first-access checks in the toolbox catch "the host forgot to configure".
// They cannot catch "a build profile has no env var set", because an undefined backupUrl
// is indistinguishable from a deliberate opt-out. So assert here instead.
//
// EXPO_PUBLIC_ARC_URL stands in for "this profile has an env block at all": preview-apk
// deliberately has none, so it is legitimately backup-free and must not throw. The
// development, dev-physical and production profiles all set both (see eas.json).
if (!__DEV__ && process.env.EXPO_PUBLIC_ARC_URL != null && process.env.EXPO_PUBLIC_BACKUP_URL == null) {
  throw new Error('Production build has no EXPO_PUBLIC_BACKUP_URL — check the eas.json env block for this profile')
}

export const FIRST_TOUCH_DATE_KEY = 'firstTouchDate'

const nativeHandlers: NativeHandlers = {
  isFocused: async () => false,
  onFocusRequested: async () => {},
  onFocusRelinquished: async () => {},
  onDownloadFile: async (fileData: Blob, fileName: string) => {
    try {
      const url = window.URL.createObjectURL(fileData)
      const link = document.createElement('a')
      link.href = url
      link.download = fileName
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      window.URL.revokeObjectURL(url)
      return true
    } catch (error) {
      console.error('Download failed:', error)
      return false
    }
  }
}

// Record the date of first app launch (never overwritten)
function FirstTouchRecorder() {
  useEffect(() => {
    AsyncStorage.getItem(FIRST_TOUCH_DATE_KEY).then(existing => {
      if (!existing) {
        AsyncStorage.setItem(FIRST_TOUCH_DATE_KEY, new Date().toISOString())
      }
    })
  }, [])
  return null
}

// Deep link handler component
function DeepLinkHandler() {
  useDeepLinking()
  return null
}

// Surfaces background local-payment internalization (e.g. a payment queued
// while offline that was internalized after wallet build or on reconnect)
// via the existing global ToastHost snackbar, so it is visible from any
// screen — not just the local-payments screen itself.
function LocalPayNotificationBridge() {
  const { localPayNotification, clearLocalPayNotification } = useWallet()

  useEffect(() => {
    if (!localPayNotification) return
    showToast(localPayNotification.message, { type: localPayNotification.type })
    clearLocalPayNotification()
  }, [localPayNotification, clearLocalPayNotification])

  return null
}

// const DebuggerDisplay = () => {
//   const [toggle, setToggle] = React.useState(false);
//   const v = useWallet()
//   const b = useBrowserMode()
//   if (!toggle) return <>
//   <Text onPress={() => setToggle(true)} style={{ top: 100, backgroundColor: 'yellow', position: 'absolute', left: 0, padding: 10, zIndex: 1000,  }}>SHOW</Text>
//   </>;
//   return (
//   <>
//     <Text onPress={() => setToggle(false)} style={{ position: 'absolute', top: 100, left: 0, backgroundColor: 'red', padding: 10, zIndex: 1000 }}>HIDE</Text>
//     <Text className="text-xs text-gray-500" style={{ position: 'absolute', top: 150, left: 0, zIndex: 1000, backgroundColor: 'white', padding: 10 }}>
//       {JSON.stringify({ configStatus: v.configStatus, network: v.selectedNetwork, browserMode: b }, null, 2)}
//     </Text>
//   </>
//   )
// }

export default function RootLayout() {
  const isDark = useColorScheme() === 'dark'
  // Root canvas — the colour every screen's own background sits on during
  // transitions, so it has to be the theme's canvas, not pure black/white.
  const backgroundColor = isDark ? '#0C0E12' : '#FFFFFF'

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ErrorBoundary>
        <LanguageProvider>
          <LocalStorageProvider>
            <UserContextProvider nativeHandlers={nativeHandlers} appVersion={packageJson.version} appName="BSV Browser">
              <ExchangeRateContextProvider>
                <WalletContextProvider onToast={showToast}>
                  <BrowserModeProvider>
                    <ThemeProvider>
                      <WalletConnectionProvider walletName="BSV Browser">
                       <VaultProvider onToast={showToast}>
                        <View style={{ flex: 1, backgroundColor }}>
                          {/* <DebuggerDisplay /> */}
                          <FirstTouchRecorder />
                          <DeepLinkHandler />
                          <Web3BenefitsModalHandler />
                          {/* <TranslationTester /> */}
                          <PermissionSheet />
                          <VaultCeremonySheet />
                          <LocalPayNotificationBridge />
                          <AlertHost />
                          <Stack
                            screenOptions={{
                              animation: 'slide_from_right',
                              headerShown: false,
                              contentStyle: { backgroundColor },
                              // Every menu/wallet/vault screen stays upright; only
                              // the Browser (index, below) follows the device.
                              orientation: 'portrait_up'
                            }}
                          >
                            {/* One Browser, ever — and one wallet screen, ever
                                (below). Both routes take no params, so there is
                                only ever one identity to collapse, which is what
                                makes `dangerouslySingular` safe here.

                                Without it, every navigation to a route already in
                                the stack APPENDS another live instance rather than
                                returning to the existing one: this expo-router
                                emits a bare NAVIGATE, and react-navigation's stack
                                router only reuses a route when it is already on
                                top, is addressed with `pop`, or — as here — has an
                                id to match on. A default browser navigates to '/'
                                on every external link tap (see +native-intent and
                                useDeepLinking), so a day of link taps while the
                                wallet screen was open stacked six live wallet
                                screens and as many Browsers, each re-running its
                                own multi-second listOutputs balance read whenever
                                the wallet context rebuilt. */}
                            <Stack.Screen name="index" dangerouslySingular options={{ orientation: 'default' }} />
                            <Stack.Screen name="config" />
                            <Stack.Screen name="auth/mnemonic" />
                            <Stack.Screen name="transactions" />
                            <Stack.Screen name="wallet" dangerouslySingular />
                            <Stack.Screen name="wallet-config" />
                            <Stack.Screen name="vault" />
                            <Stack.Screen name="vault-recover" />
                            <Stack.Screen name="vault-transfer" />
                            <Stack.Screen name="pay" />
                            {/* The three below become redirect stubs into /pay (Task 14).
                                They stay registered so an old link resolves instead of
                                hitting +not-found. */}
                            <Stack.Screen name="legacy-payments" />
                            <Stack.Screen name="payments" />
                            <Stack.Screen name="local-payments" />
                            <Stack.Screen name="connections" />
                            <Stack.Screen name="pair" />
                            <Stack.Screen name="not-found" />
                          </Stack>
                          <ToastHost />
                        </View>
                       </VaultProvider>
                      </WalletConnectionProvider>
                    </ThemeProvider>
                  </BrowserModeProvider>
                </WalletContextProvider>
              </ExchangeRateContextProvider>
            </UserContextProvider>
          </LocalStorageProvider>
        </LanguageProvider>
      </ErrorBoundary>
    </GestureHandlerRootView>
  )
}
