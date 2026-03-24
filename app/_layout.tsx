// Polyfill AbortSignal.timeout for Hermes (React Native JS engine)
if (typeof AbortSignal !== 'undefined' && !AbortSignal.timeout) {
  AbortSignal.timeout = (ms: number) => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new Error('TimeoutError')), ms)
    return controller.signal
  }
}

import React, { useEffect } from 'react'
import { View, useColorScheme } from 'react-native'
import { Stack } from 'expo-router'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { UserContextProvider, NativeHandlers } from '../context/UserContext'
import packageJson from '../package.json'
import { WalletContextProvider } from '@/context/WalletContext'
import { ExchangeRateContextProvider } from '@/context/ExchangeRateContext'
import { ThemeProvider } from '@/context/theme/ThemeContext'
// TODO: Re-add RecoveryKeySaver when WAB support returns
import LocalStorageProvider from '@/context/LocalStorageProvider'
import PermissionSheet from '@/components/ui/PermissionSheet'
import { useDeepLinking } from '@/hooks/useDeepLinking'
import DefaultBrowserPrompt from '@/components/onboarding/DefaultBrowserPrompt'
import { LanguageProvider } from '@/context/i18n/translations'
import { BrowserModeProvider } from '@/context/BrowserModeContext'
import Web3BenefitsModalHandler from '@/components/onboarding/Web3BenefitsModalHandler'

import AsyncStorage from '@react-native-async-storage/async-storage'
import { ErrorBoundary } from '@/components/ui/ErrorBoundary'

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
  const backgroundColor = isDark ? '#000000' : '#FFFFFF'

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ErrorBoundary>
        <LanguageProvider>
          <LocalStorageProvider>
            <UserContextProvider nativeHandlers={nativeHandlers} appVersion={packageJson.version} appName="BSV Browser">
              <ExchangeRateContextProvider>
                <WalletContextProvider>
                  <BrowserModeProvider>
                    <ThemeProvider>
                      <View style={{ flex: 1, backgroundColor }}>
                        {/* <DebuggerDisplay /> */}
                        <FirstTouchRecorder />
                        <DeepLinkHandler />
                        <Web3BenefitsModalHandler />
                        {/* <TranslationTester /> */}
                        <DefaultBrowserPrompt />
                        <PermissionSheet />
                        <Stack
                          screenOptions={{
                            animation: 'slide_from_right',
                            headerShown: false,
                            contentStyle: { backgroundColor }
                          }}
                        >
                          <Stack.Screen name="index" />
                          <Stack.Screen name="config" />
                          <Stack.Screen name="auth/mnemonic" />
                          <Stack.Screen name="transactions" />
                          <Stack.Screen name="wallet-config" />
                          <Stack.Screen name="legacy-payments" />
                          <Stack.Screen name="payments" />
                          <Stack.Screen name="not-found" />
                        </Stack>
                      </View>
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
