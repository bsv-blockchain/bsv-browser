import React, { useEffect, useState, useCallback } from 'react'
import { View, Text, StyleSheet, TouchableOpacity, SafeAreaView, Alert, ActivityIndicator } from 'react-native'
import ConfigModal from '@/components/ConfigModal'
import { router } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { Ionicons } from '@expo/vector-icons'
import AppLogo from '@/components/AppLogo'
import { useTheme } from '@/context/theme/ThemeContext'
import { useWallet } from '@/context/WalletContext'
import { useLocalStorage } from '@/context/LocalStorageProvider'
import { Utils } from '@bsv/sdk'
import { useTranslation } from 'react-i18next'
import { useBrowserMode } from '@/context/BrowserModeContext'

export default function LoginScreen() {
  // Get theme colors
  const { colors, isDark } = useTheme()
  const { managers, selectedWabUrl, selectedStorageUrl, selectedMethod, selectedNetwork, finalizeConfig } = useWallet()
  const { getSnap, setItem, getItem } = useLocalStorage()

  const [startButtonText] = useState('Get Started')
  const { t } = useTranslation()
  const { showWeb3Benefits, setWeb2Mode } = useBrowserMode()
  const [loading, setLoading] = React.useState(false)
  const [initializing, setInitializing] = useState(true)

  // Navigate to phone auth screen
  const handleGetStarted = useCallback(async () => {
    try {
      setLoading(true)

      // Fetch WAB info
      const res = await fetch(`${selectedWabUrl}/info`)
      if (!res.ok) {
        throw new Error(`Failed to fetch info: ${res.status}`)
      }
      const wabInfo = await res.json()
      const finalConfig = {
        wabUrl: selectedWabUrl,
        wabInfo,
        method: selectedMethod || wabInfo.supportedAuthMethods[0],
        network: selectedNetwork,
        storageUrl: selectedStorageUrl
      }
      const success = finalizeConfig(finalConfig)
      if (!success) {
        Alert.alert('Error', 'Failed to finalize configuration. Please try again.')
        return
      }
      await setItem('finalConfig', JSON.stringify(finalConfig))

      // if there's a wallet snapshot, load that
      const snap = await getSnap()
      if (!snap) {
        router.push('/auth/phone')
        return
      }
      await managers?.walletManager?.loadSnapshot(snap)

      router.dismissAll()
      router.replace('/browser')
      return
    } catch (error) {
      console.error(error)
      Alert.alert('Error', 'Failed to get started. Please try again.')
    } finally {
      setLoading(false)
    }
  }, [selectedWabUrl, selectedMethod, selectedNetwork, selectedStorageUrl, finalizeConfig, setItem, getSnap, managers?.walletManager])

  // Config modal state
  const [showConfig, setShowConfig] = useState(false)

  // Handle config modal
  const handleConfig = () => {
    setShowConfig(true)
  }

  const handleConfigDismiss = () => {
    setShowConfig(false)
  }

  const handleConfigured = async () => {
    // After successful config, proceed with auth
    try {
      // The ConfigModal has already called finalizeConfig() with the new configuration
      // No need to load from storage - the wallet context already has the updated values
      const snap = await getSnap()
      if (!snap) {
        router.push('/auth/phone')
        return
      }
      const snapArr = Utils.toArray(snap, 'base64')
      await managers?.walletManager?.loadSnapshot(snapArr)

      router.dismissAll()
      router.replace('/browser')
    } catch (error) {
      console.error(error)
      Alert.alert('Error', 'Failed to authenticate. Please try again.')
    }
  }

  // Initial app load - check if wallet exists and auto-login if available
  useEffect(() => {
    ; (async () => {
      try {
        const snap = await getSnap()
        if (snap && managers?.walletManager) {
          // Silently load wallet if available
          await managers.walletManager.loadSnapshot(snap)
          // Only auto-redirect if wallet is successfully loaded
          router.dismissAll()
          router.replace('/browser')
        }
      } finally {
        setInitializing(false)
      }
    })()
  }, [getSnap, managers?.walletManager])

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <View style={[styles.contentContainer, { backgroundColor: colors.background }]}>
        <View style={styles.logoContainer}>
          <AppLogo />
        </View>
        {!initializing && (
          <>
            <Text style={[styles.welcomeTitle, { color: colors.textPrimary }]}>{t('metanet')}</Text>
            <Text style={[styles.welcomeText, { color: colors.textSecondary }]}>
              {t('browser_with_identity_payments')}
            </Text>

            <TouchableOpacity
              style={[styles.getStartedButton, { backgroundColor: colors.primary, opacity: loading ? 0.2 : 1 }]}
              onPress={handleGetStarted}
              disabled={loading}
            >
              <Text style={[styles.getStartedButtonText, { color: colors.buttonText }]}>
                {loading ? <ActivityIndicator color="#fff" /> : startButtonText}
              </Text>
            </TouchableOpacity>

            {/* Skip Login Button for Web2 Mode */}
            <TouchableOpacity
              style={[
                styles.getStartedButton,
                {
                  backgroundColor: colors.paperBackground,
                  borderWidth: 1,
                  borderColor: colors.inputBorder,
                  marginTop: 12
                }
              ]}
              onPress={handleConfig}
            >
              <View style={styles.configIconContainer}>
                <Ionicons name="settings-outline" size={20} color={colors.primary} style={{ marginRight: 8 }} />
                <Text style={{ color: colors.textPrimary }}>{t('configure_providers')}</Text>
              </View>
            </TouchableOpacity>

            <Text style={[styles.termsText, { paddingHorizontal: 50, color: colors.textSecondary }]}>{t('terms_privacy_agreement')}</Text>

            <TouchableOpacity style={styles.configButton} onPress={() => {
                // Set mode to web2 immediately when button is pressed
                setWeb2Mode(true)

                showWeb3Benefits(
                  // onContinue - if they still want to skip
                  () => {
                    router.replace({ pathname: '/browser', params: { mode: 'web2' } })
                  },
                  // onGoToLogin - if they decide to get Web3 identity
                  () => {
                    handleGetStarted()
                  }
                )
              }}>
                <Text style={[styles.configButtonText, { color: '#487dbf' }]}>{t('continue_without_login')}</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
      
      <ConfigModal
        visible={showConfig}
        onDismiss={handleConfigDismiss}
        onConfigured={handleConfigured}
      />
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1
  },
  contentContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20
  },
  logoContainer: {
    marginBottom: 40
  },
  logoPlaceholder: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: '#487dbf',
    justifyContent: 'center',
    alignItems: 'center'
  },
  logoText: {
    fontSize: 48,
    fontWeight: 'bold',
    color: 'white'
  },
  welcomeTitle: {
    fontSize: 28,
    fontWeight: 'bold',
    marginBottom: 10,
    textAlign: 'center'
  },
  welcomeText: {
    fontSize: 16,
    marginBottom: 30,
    textAlign: 'center'
  },
  getStartedButton: {
    paddingVertical: 15,
    paddingHorizontal: 40,
    borderRadius: 10,
    width: '100%',
    alignItems: 'center'
  },
  getStartedButtonText: {
    fontSize: 16,
    fontWeight: 'bold'
  },
  continueButtonText: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#0066cc'
  },
  configButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 50,
    padding: 10,
    borderWidth: 1,
    borderColor: '#487dbf',
    borderRadius: 10,
    width: '60%'
  },
  configIconContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 8
  },
  configButtonText: {
    fontSize: 14,
    marginLeft: 2
  },
  chevronIcon: {
    marginRight: 2
  },
  termsText: {
    fontSize: 12,
    textAlign: 'center',
    marginTop: 15
  }
})
