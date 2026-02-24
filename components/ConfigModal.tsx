import React, { useState, useEffect, useCallback } from 'react'
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Modal
} from 'react-native'
import { useTranslation } from 'react-i18next'
import { useTheme } from '@/context/theme/ThemeContext'
import { useThemeStyles } from '@/context/theme/useThemeStyles'
import { useWallet, WABConfig } from '@/context/WalletContext'
import WalletConfigPicker from './WalletConfigPicker'

interface ConfigModalProps {
  visible: boolean
  onDismiss: () => void
  onConfigured: () => void
}

const ConfigModal: React.FC<ConfigModalProps> = ({ visible, onDismiss, onConfigured }) => {
  // Access theme and translation
  const { t } = useTranslation()
  const { colors } = useTheme()
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

  // State for configuration
  const [wabUrl, setWabUrl] = useState<string>(selectedWabUrl)
  const [wabInfo, setWabInfo] = useState<{
    supportedAuthMethods: string[]
    faucetEnabled: boolean
    faucetAmount: number
  } | null>(null)
  const [method, setMethod] = useState<WABConfig['method']>(selectedMethod)
  const [network, setNetwork] = useState<WABConfig['network']>(selectedNetwork)
  const [storageUrl, setStorageUrl] = useState<string>(selectedStorageUrl)
  const [backupConfig, setBackupConfig] = useState<WABConfig>()

  // Validation
  const isUrlValid = (url: string) => {
    // Allow special markers for noWAB and local storage
    if (url === 'noWAB' || url === 'local') {
      return true
    }
    try {
      new URL(url)
      return true
    } catch {
      return false
    }
  }

  const isFormValid = () => {
    return isUrlValid(wabUrl) && isUrlValid(storageUrl)
  }

  // Fetch wallet configuration info
  const fetchWalletConfig = useCallback(async () => {
    try {
      const res = await fetch(`${wabUrl}/info`)
      if (!res.ok) {
        throw new Error(`Failed to fetch info: ${res.status}`)
      }
      const info = await res.json()
      setWabInfo(info)

      // Auto-select the first supported authentication method if available
      if (info.supportedAuthMethods && info.supportedAuthMethods.length > 0) {
        setMethod(info.supportedAuthMethods[0])
      }
    } catch (error: any) {
      console.error('Error fetching wallet config:', error)
      Alert.alert(t('error'), t('could_not_fetch_wallet_config') + ' ' + error.message)
    }
  }, [wabUrl, t])

  // Auto-fetch wallet configuration info when component mounts
  useEffect(() => {
    if (visible && !wabInfo && !managers?.walletManager?.authenticated) {
      fetchWalletConfig()
    }
  }, [visible, fetchWalletConfig, wabInfo, managers?.walletManager?.authenticated])

  // Force the manager to use the "presentation-key-and-password" flow
  useEffect(() => {
    if (managers?.walletManager) {
      managers.walletManager.authenticationMode = 'presentation-key-and-password'
    }
  }, [managers?.walletManager])

  const layAwayCurrentConfig = () => {
    setWalletBuilt(false)
    setBackupConfig({
      wabUrl,
      wabInfo,
      method,
      network,
      storageUrl
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

  // Handle save and continue
  const handleSaveConfig = () => {
    if (!isFormValid()) {
      Alert.alert('Invalid Configuration', 'Please ensure both URLs are valid.')
      return
    }

    layAwayCurrentConfig()

    // Construct the WAB config
    const wabConfig: WABConfig = {
      wabUrl,
      wabInfo,
      method,
      network,
      storageUrl
    }

    // Save the configuration
    const success = finalizeConfig(wabConfig)
    if (success) {
      setConfigStatus('configured')
      console.log('Configuration saved successfully')
      onConfigured()
      onDismiss()
    } else {
      Alert.alert(t('configuration_error'), t('failed_to_save_config'))
      resetCurrentConfig()
    }
  }

  // Handle cancellation
  const handleCancel = () => {
    setConfigStatus('configured')
    resetCurrentConfig()
    onDismiss()
  }

  // Handle config selection from picker
  const handleQuickPickConfig = (config: any) => {
    setWabUrl(config.wabUrl)
    setStorageUrl(config.storageUrl)
    setMethod(config.method)
    setNetwork(config.network)
    setWabInfo(config.wabInfo || null) // Set to null for noWAB configs

    // Automatically save the configuration
    handleSaveConfig()
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={handleCancel}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={[styles.container, { backgroundColor: colors.background }]}
      >
        <View
          style={[
            {
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: 16,
              borderBottomWidth: 1,
              borderBottomColor: colors.inputBorder
            }
          ]}
        >
          <TouchableOpacity onPress={handleCancel}>
            <Text style={[styles.text, { color: colors.secondary }]}>{t('cancel')}</Text>
          </TouchableOpacity>
          <Text style={[styles.title, { color: colors.textPrimary }]}>{t('configuration')}</Text>
          <TouchableOpacity onPress={handleSaveConfig} disabled={!isFormValid()}>
            <Text style={[styles.text, { color: isFormValid() ? colors.secondary : colors.textSecondary }]}>
              {t('save')}
            </Text>
          </TouchableOpacity>
        </View>

        <ScrollView style={{ flex: 1 }}>
          {/* Only show Quick Pick - Manual config removed per requirements */}
          <WalletConfigPicker
            onSelectConfig={handleQuickPickConfig}
            selectedNetwork={network}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  )
}

export default ConfigModal
