import React from 'react'
import { Stack } from 'expo-router'
import { UserContextProvider, NativeHandlers } from '../context/UserContext'
import packageJson from '../package.json'
import { WalletContextProvider , useWallet } from '@/context/WalletContext'
import { ExchangeRateContextProvider } from '@/context/ExchangeRateContext'
import { ThemeProvider } from '@/context/theme/ThemeContext'
// TODO: Re-add RecoveryKeySaver when WAB support returns
import LocalStorageProvider from '@/context/LocalStorageProvider'
import ProtocolAccessModal from '@/components/ProtocolAccessModal'
import BasketAccessModal from '@/components/BasketAccessModal'
import CertificateAccessModal from '@/components/CertificateAccessModal'
import SpendingAuthorizationModal from '@/components/SpendingAuthorizationModal'
import { useDeepLinking } from '@/hooks/useDeepLinking'
import DefaultBrowserPrompt from '@/components/DefaultBrowserPrompt'
import { LanguageProvider } from '@/utils/translations'
import { BrowserModeProvider, useBrowserMode } from '@/context/BrowserModeContext'
import Web3BenefitsModalHandler from '@/components/Web3BenefitsModalHandler'
import { Text } from 'react-native'
import { ErrorBoundary } from '@/components/ErrorBoundary'

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
  return (
    <ErrorBoundary>
      <LanguageProvider>
        <LocalStorageProvider>
          <UserContextProvider nativeHandlers={nativeHandlers} appVersion={packageJson.version} appName="BSV Browser">
            <ExchangeRateContextProvider>
              <WalletContextProvider>
                <BrowserModeProvider>
                  <ThemeProvider>
                    {/* <DebuggerDisplay /> */}
                    <DeepLinkHandler />
                    <Web3BenefitsModalHandler />
                    {/* <TranslationTester /> */}
                    <DefaultBrowserPrompt />
                    <ProtocolAccessModal />
                    <BasketAccessModal />
                    <CertificateAccessModal />
                    <SpendingAuthorizationModal />
                    <Stack
                      screenOptions={{
                        animation: 'slide_from_right',
                        headerShown: false,
                      }}
                    >
                      <Stack.Screen name="index" />
                      <Stack.Screen name="config" />
                      <Stack.Screen name="auth/mnemonic" />
                      <Stack.Screen name="not-found" />
                    </Stack>
                  </ThemeProvider>
                </BrowserModeProvider>
              </WalletContextProvider>
            </ExchangeRateContextProvider>
          </UserContextProvider>
        </LocalStorageProvider>
      </LanguageProvider>
    </ErrorBoundary>
  )
}
