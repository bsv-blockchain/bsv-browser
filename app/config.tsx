import React, { useState, useCallback } from 'react'
import {
  View,
  Text,
  TouchableOpacity,
  SafeAreaView,
  ScrollView,
  Alert,
  KeyboardAvoidingView,
  Platform
} from 'react-native'
import { StatusBar } from 'expo-status-bar'
import { router } from 'expo-router'
import { useTranslation } from 'react-i18next'
import { useTheme } from '@/context/theme/ThemeContext'
import { useThemeStyles } from '@/context/theme/useThemeStyles'
import { useWallet, WABConfig } from '@/context/WalletContext'
import { useLocalStorage } from '@/context/LocalStorageProvider'
import { Utils } from '@bsv/sdk'
import WalletConfigPicker from '@/components/WalletConfigPicker'

const ConfigScreen = () => {
  // Access theme and translation
  const { t } = useTranslation()
  const { colors, isDark } = useTheme()
  const styles = useThemeStyles()
  const {
    finalizeConfig,
    managers,
    setConfigStatus,
    selectedWabUrl,
    selectedStorageUrl,
    selectedMethod,
    selectedNetwork,
    setWalletBuilt
  } = useWallet()
  const { getSnap, setItem } = useLocalStorage()

  const [backupConfig, setBackupConfig] = useState<WABConfig>()

  const layAwayCurrentConfig = () => {
    setWalletBuilt(false)
    setBackupConfig({
      wabUrl: selectedWabUrl,
      wabInfo: null,
      method: selectedMethod,
      network: selectedNetwork,
      storageUrl: selectedStorageUrl
    })
    if (managers?.walletManager) {
      delete managers.walletManager
    }
    if (managers?.permissionsManager) {
      delete managers.permissionsManager
    }
    if (managers?.settingsManager) {
      delete managers.settingsManager
    }
  }

  const resetCurrentConfig = useCallback(() => {
    if (backupConfig) {
      finalizeConfig(backupConfig)
    }
  }, [backupConfig, finalizeConfig])

  // Handle config selection from picker
  const handleQuickPickConfig = async (config: any) => {
    layAwayCurrentConfig()

    // Construct the WAB config
    const wabConfig: WABConfig = {
      wabUrl: config.wabUrl,
      wabInfo: config.wabInfo || null,
      method: config.method,
      network: config.network,
      storageUrl: config.storageUrl
    }

    // Save the configuration
    const success = finalizeConfig(wabConfig)
    if (success) {
      setConfigStatus('configured')
      console.log('Configuration saved successfully')

      // Save to local storage
      await setItem('finalConfig', JSON.stringify(wabConfig))

      // Navigate to appropriate auth screen based on method
      await handleConfigured()
    } else {
      Alert.alert(t('configuration_error'), t('failed_to_save_config'))
      resetCurrentConfig()
    }
  }

  const handleConfigured = async () => {
    // After successful config, proceed with auth
    try {
      // Check if this is a self-custodial (noWAB) setup
      if (selectedWabUrl === 'noWAB' || selectedMethod === 'mnemonic') {
        console.log('[Config] Self-custodial wallet configured, routing to mnemonic screen')
        router.push('/auth/mnemonic')
        return
      }

      const snap = await getSnap()
      if (!snap) {
        router.push('/auth/phone')
        return
      }
      const snapArr = Utils.toArray(snap, 'base64')
      await managers?.walletManager?.loadSnapshot(snapArr)

      router.dismissAll()
      router.push('/')
    } catch (error) {
      console.error(error)
      Alert.alert(t('error'), t('failed_to_authenticate'))
    }
  }

  // Handle cancellation
  const handleCancel = () => {
    setConfigStatus('configured')
    resetCurrentConfig()
    router.back()
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
      >
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: 16,
            borderBottomWidth: 1,
            borderBottomColor: colors.inputBorder
          }}
        >
          <TouchableOpacity onPress={handleCancel}>
            <Text style={[styles.text, { color: colors.secondary }]}>{t('cancel')}</Text>
          </TouchableOpacity>
          <Text style={[styles.title, { color: colors.textPrimary }]}>{t('configuration')}</Text>
          <View style={{ width: 50 }} />
        </View>

        <ScrollView style={{ flex: 1 }}>
          <WalletConfigPicker
            onSelectConfig={handleQuickPickConfig}
            selectedNetwork={selectedNetwork}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

export default ConfigScreen
