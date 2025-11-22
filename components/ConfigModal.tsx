import React, { useState, useEffect, useCallback } from 'react'
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Modal
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
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

  // State for configuration mode
  const [configMode, setConfigMode] = useState<'quick' | 'manual'>('quick')

  // State for configuration
  const [wabUrl, setWabUrl] = useState<string>(selectedWabUrl)
  const [wabInfo, setWabInfo] = useState<{
    supportedAuthMethods: string[]
    faucetEnabled: boolean
    faucetAmount: number
  } | null>(null)
  const [isLoadingConfig, setIsLoadingConfig] = useState(false)
  const [method, setMethod] = useState<WABConfig['method']>(selectedMethod)
  const [network, setNetwork] = useState<WABConfig['network']>(selectedNetwork)
  const [storageUrl, setStorageUrl] = useState<string>(selectedStorageUrl)
  const [backupConfig, setBackupConfig] = useState<WABConfig>()

  // Validation
  const isUrlValid = (url: string) => {
    try {
      new URL(url)
      return true
    } catch (e) {
      return false
    }
  }

  const isFormValid = () => {
    return isUrlValid(wabUrl) && isUrlValid(storageUrl)
  }

  // Fetch wallet configuration info
  const fetchWalletConfig = async () => {
    setIsLoadingConfig(true)
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
    } finally {
      setIsLoadingConfig(false)
    }
  }

  // Auto-fetch wallet configuration info when component mounts
  useEffect(() => {
    if (visible && !wabInfo && !managers?.walletManager?.authenticated) {
      fetchWalletConfig()
    }
  }, [visible])

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
    setWabInfo(config.wabInfo)

    // Automatically save the configuration
    handleSaveConfig()
  }

  // Render a selectable chip
  const renderChip = (label: string, labelSelected: string, onPress: Function) => (
    <TouchableOpacity
      style={[
        styles.row,
        {
          padding: 12,
          borderRadius: 20,
          marginRight: 10,
          marginBottom: 5,
          backgroundColor: labelSelected === label ? colors.secondary : colors.inputBackground,
          borderWidth: 1,
          borderColor: labelSelected === label ? colors.secondary : colors.inputBorder
        }
      ]}
      onPress={() => onPress(label)}
    >
      {labelSelected === label && (
        <Ionicons
          name="checkmark-circle"
          size={18}
          color={isDark ? colors.background : colors.buttonText}
          style={{ marginRight: 6 }}
        />
      )}
      <Text
        style={[
          styles.text,
          { color: labelSelected === label ? (isDark ? colors.background : colors.buttonText) : colors.textPrimary }
        ]}
      >
        {label}
      </Text>
    </TouchableOpacity>
  )

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
          {/* Mode Toggle */}
          <View style={{ flexDirection: 'row', padding: 15, justifyContent: 'center', gap: 10 }}>
            <TouchableOpacity
              style={[
                styles.row,
                {
                  padding: 12,
                  borderRadius: 20,
                  flex: 1,
                  justifyContent: 'center',
                  backgroundColor: configMode === 'quick' ? colors.secondary : colors.inputBackground,
                  borderWidth: 1,
                  borderColor: configMode === 'quick' ? colors.secondary : colors.inputBorder
                }
              ]}
              onPress={() => setConfigMode('quick')}
            >
              <Text
                style={[
                  styles.text,
                  {
                    textAlign: 'center',
                    color: configMode === 'quick' ? (isDark ? colors.background : colors.buttonText) : colors.textPrimary
                  }
                ]}
              >
                {t('quick_pick')}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.row,
                {
                  padding: 12,
                  borderRadius: 20,
                  flex: 1,
                  justifyContent: 'center',
                  backgroundColor: configMode === 'manual' ? colors.secondary : colors.inputBackground,
                  borderWidth: 1,
                  borderColor: configMode === 'manual' ? colors.secondary : colors.inputBorder
                }
              ]}
              onPress={() => setConfigMode('manual')}
            >
              <Text
                style={[
                  styles.text,
                  {
                    textAlign: 'center',
                    color: configMode === 'manual' ? (isDark ? colors.background : colors.buttonText) : colors.textPrimary
                  }
                ]}
              >
                {t('manual_config')}
              </Text>
            </TouchableOpacity>
          </View>

          {configMode === 'quick' ? (
            <WalletConfigPicker
              onSelectConfig={handleQuickPickConfig}
              selectedNetwork={network}
            />
          ) : (
            <View style={{ padding: 20 }}>
              {/* WAB Configuration */}
              <View style={styles.card}>
              <Text style={[styles.text, { fontWeight: 'bold', fontSize: 16, marginBottom: 10 }]}>
                {t('wallet_auth_backend')}
              </Text>
              <Text style={[styles.textSecondary, { marginBottom: 15 }]}>{t('wab_description')}</Text>

              {isLoadingConfig && (
                <View style={{ padding: 20, alignItems: 'center' }}>
                  <ActivityIndicator size="large" color={colors.secondary} />
                </View>
              )}

              <Text style={styles.inputLabel}>{t('wab_url')}</Text>
              <View style={styles.input}>
                <TextInput
                  style={styles.inputText}
                  value={wabUrl}
                  onChangeText={setWabUrl}
                  placeholder={t('enter_wab_url')}
                  placeholderTextColor={colors.textSecondary}
                  autoCapitalize="none"
                  keyboardType="url"
                />
              </View>

              <TouchableOpacity
                style={[styles.button, { marginTop: 10 }]}
                onPress={fetchWalletConfig}
                disabled={isLoadingConfig}
              >
                <Text style={styles.buttonText}>{t('refresh_info')}</Text>
              </TouchableOpacity>

              {/* Phone Verification Service */}
              <Text style={[styles.inputLabel, { marginTop: 15 }]}>{t('phone_verification_service')}</Text>
              <View style={[styles.row, { flexWrap: 'wrap', marginVertical: 10 }]}>
                {renderChip('Twilio', method, setMethod)}
                {renderChip('Persona', method, setMethod)}
              </View>
            </View>

            {/* Network Configuration */}
            <View style={[styles.card, { marginTop: 15 }]}>
              <Text style={[styles.text, { fontWeight: 'bold', fontSize: 16, marginBottom: 10 }]}>
                {t('bsv_network')}
              </Text>

              <View style={[styles.row, { flexWrap: 'wrap', marginVertical: 10 }]}>
                {renderChip('main', network, setNetwork)}
                {renderChip('test', network, setNetwork)}
              </View>
            </View>

            {/* Storage Configuration */}
            <View style={[styles.card, { marginTop: 15 }]}>
              <Text style={[styles.text, { fontWeight: 'bold', fontSize: 16, marginBottom: 10 }]}>
                {t('wallet_storage_provider')}
              </Text>
              <Text style={[styles.textSecondary, { marginBottom: 15 }]}>{t('storage_description')}</Text>

              <Text style={styles.inputLabel}>{t('storage_url')}</Text>
              <View style={styles.input}>
                <TextInput
                  style={styles.inputText}
                  value={storageUrl}
                  onChangeText={setStorageUrl}
                  placeholder={t('enter_storage_url')}
                  placeholderTextColor={colors.textSecondary}
                  autoCapitalize="none"
                  keyboardType="url"
                />
              </View>
            </View>
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  )
}

export default ConfigModal
