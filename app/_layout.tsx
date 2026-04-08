// Polyfill AbortSignal.timeout for Hermes (React Native JS engine)
if (typeof AbortSignal !== 'undefined' && !AbortSignal.timeout) {
  AbortSignal.timeout = (ms: number) => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new Error('TimeoutError')), ms)
    return controller.signal
  }
}

import React, { useEffect } from 'react'
import { View, Text, TouchableOpacity, StyleSheet, useColorScheme } from 'react-native'
import { Stack } from 'expo-router'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { UserContextProvider, NativeHandlers } from '../context/UserContext'
import packageJson from '../package.json'
import { WalletContextProvider, useWallet } from '@/context/WalletContext'
import { ExchangeRateContextProvider } from '@/context/ExchangeRateContext'
import { ThemeProvider, useTheme } from '@/context/theme/ThemeContext'
// TODO: Re-add RecoveryKeySaver when WAB support returns
import LocalStorageProvider from '@/context/LocalStorageProvider'
import PermissionSheet from '@/components/ui/PermissionSheet'
import { useDeepLinking } from '@/hooks/useDeepLinking'
import DefaultBrowserPrompt from '@/components/onboarding/DefaultBrowserPrompt'
import { LanguageProvider } from '@/context/i18n/translations'
import { BrowserModeProvider } from '@/context/BrowserModeContext'
import Web3BenefitsModalHandler from '@/components/onboarding/Web3BenefitsModalHandler'
import { WalletConnectionProvider, useWalletConnection } from '@/context/WalletConnectionContext'
import { RpcApprovalModal } from '@/components/RpcApprovalModal'
import { Ionicons } from '@expo/vector-icons'
import { spacing, radii, typography } from '@/context/theme/tokens'

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

// Renders the RPC approval modal from layout so it persists across screen navigation
function WalletApprovalHandler() {
  const { currentApproval, sessionMeta, approveCurrentRpc, rejectCurrentRpc } = useWalletConnection()
  return (
    <RpcApprovalModal
      pending={currentApproval}
      origin={sessionMeta?.origin ?? ''}
      onApprove={approveCurrentRpc}
      onReject={rejectCurrentRpc}
    />
  )
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

// Global snackbar that shows BLE payment notifications from background processing.
// Rendered inside ThemeProvider + WalletContextProvider so it has access to
// both colours and the wallet notification state.
function BLENotificationSnackbar() {
  const { bleNotification, clearBleNotification } = useWallet()
  const { colors } = useTheme()

  if (!bleNotification) return null

  const isSuccess = bleNotification.type === 'success'
  const isError = bleNotification.type === 'error'
  const borderColor = isSuccess ? colors.success : isError ? colors.error : colors.separator
  const iconColor = isSuccess ? colors.success : isError ? colors.error : colors.info
  const iconName = isSuccess ? 'checkmark-circle' : isError ? 'alert-circle' : 'information-circle'

  return (
    <TouchableOpacity
      activeOpacity={0.9}
      onPress={clearBleNotification}
      style={[snackStyles.snack, { backgroundColor: colors.backgroundElevated, borderColor }]}
    >
      <Ionicons name={iconName} size={18} color={iconColor} />
      <Text style={[snackStyles.text, { color: colors.textPrimary }]}>{bleNotification.message}</Text>
    </TouchableOpacity>
  )
}

const snackStyles = StyleSheet.create({
  snack: {
    position: 'absolute',
    bottom: 40,
    left: spacing.lg,
    right: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12,
    shadowRadius: 8,
    elevation: 6,
    zIndex: 9999
  },
  text: {
    ...typography.subhead,
    flex: 1
  }
})

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
                      <WalletConnectionProvider>
                        <View style={{ flex: 1, backgroundColor }}>
                          {/* <DebuggerDisplay /> */}
                          <FirstTouchRecorder />
                          <DeepLinkHandler />
                          <Web3BenefitsModalHandler />
                          <WalletApprovalHandler />
                          {/* <TranslationTester /> */}
                          <DefaultBrowserPrompt />
                          <PermissionSheet />
                          <BLENotificationSnackbar />
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
                            <Stack.Screen name="local-payments" />
                            <Stack.Screen name="connections" />
                            <Stack.Screen name="pair" />
                            <Stack.Screen name="not-found" />
                          </Stack>
                        </View>
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
