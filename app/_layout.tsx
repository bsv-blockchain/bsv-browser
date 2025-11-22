import 'react-native-quick-crypto'
import { Buffer } from 'buffer'
global.Buffer = Buffer
import React from 'react'
import { Stack } from 'expo-router'
import { UserContextProvider, NativeHandlers } from '../context/UserContext'
import packageJson from '../package.json'
import { WalletContextProvider } from '@/context/WalletContext'
import { ExchangeRateContextProvider } from '@/context/ExchangeRateContext'
import { ThemeProvider } from '@/context/theme/ThemeContext'
import PasswordHandler from '@/components/PasswordHandler'
import RecoveryKeySaver from '@/components/RecoveryKeySaver'
import LocalStorageProvider from '@/context/LocalStorageProvider'
import ProtocolAccessModal from '@/components/ProtocolAccessModal'
import BasketAccessModal from '@/components/BasketAccessModal'
import CertificateAccessModal from '@/components/CertificateAccessModal'
import SpendingAuthorizationModal from '@/components/SpendingAuthorizationModal'
import { useDeepLinking } from '@/hooks/useDeepLinking'
import DefaultBrowserPrompt from '@/components/DefaultBrowserPrompt'
import { LanguageProvider } from '@/utils/translations'
import { BrowserModeProvider } from '@/context/BrowserModeContext'
import Web3BenefitsModalHandler from '@/components/Web3BenefitsModalHandler'
import '@/utils/translations'

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

export default function RootLayout() {
  return (
    <LanguageProvider>
      <LocalStorageProvider>
        <UserContextProvider nativeHandlers={nativeHandlers} appVersion={packageJson.version} appName="BSV Browser">
          <ExchangeRateContextProvider>
            <WalletContextProvider>
              <BrowserModeProvider>
                <ThemeProvider>
                  <DeepLinkHandler />
                  <Web3BenefitsModalHandler />
                  {/* <TranslationTester /> */}
                  <DefaultBrowserPrompt />
                  <PasswordHandler />
                  <RecoveryKeySaver />
                  <ProtocolAccessModal />
                  <BasketAccessModal />
                  <CertificateAccessModal />
                  <SpendingAuthorizationModal />
                  <Stack
                    screenOptions={{
                      animation: 'slide_from_right',
                      headerShown: false
                    }}
                  >
                    <Stack.Screen name="index" />
                    <Stack.Screen name="browser" />
                    <Stack.Screen
                      name="config"
                      options={{
                        headerShown: false,
                        animation: 'slide_from_bottom',
                        presentation: 'modal'
                      }}
                    />
                  </Stack>
                </ThemeProvider>
              </BrowserModeProvider>
            </WalletContextProvider>
          </ExchangeRateContextProvider>
        </UserContextProvider>
      </LocalStorageProvider>
    </LanguageProvider>
  )
}
