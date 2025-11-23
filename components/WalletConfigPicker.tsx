import React, { useState, useEffect } from 'react'
import { View, Text, TouchableOpacity, ActivityIndicator, ScrollView, Alert } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { LookupResolver } from '@bsv/sdk'
import { useTheme } from '@/context/theme/ThemeContext'
import { useThemeStyles } from '@/context/theme/useThemeStyles'
import { useTranslation } from 'react-i18next'

interface WalletConfig {
  name: string
  description?: string
  wabUrl: string
  storageUrl: string
  network: 'main' | 'test'
  method: string
  icon?: string
}

interface WalletConfigPickerProps {
  onSelectConfig: (config: WalletConfig) => void
  selectedNetwork: 'main' | 'test'
}

const WalletConfigPicker: React.FC<WalletConfigPickerProps> = ({ onSelectConfig, selectedNetwork }) => {
  const { colors } = useTheme()
  const styles = useThemeStyles()
  const { t } = useTranslation()

  const [configs, setConfigs] = useState<WalletConfig[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    loadWalletConfigs()
  }, [selectedNetwork])

  const loadWalletConfigs = async () => {
    setLoading(true)
    setError(null)

    try {
      // Initialize LookupResolver for the selected network
      const lookupUrl = selectedNetwork === 'main'
        ? 'https://lookup.bsvb.tech'
        : 'https://lookup-testnet.bsvb.tech'

      const resolver = new LookupResolver(lookupUrl)

      // Query for ls_config topic
      const results = await resolver.query({
        service: 'ls_config',
        query: {}
      })

      console.log('[WalletConfigPicker] LookupResolver results:', results)

      // Parse the results and extract wallet configurations
      const parsedConfigs: WalletConfig[] = []

      if (results && Array.isArray(results)) {
        for (const result of results) {
          try {
            // Each result should contain metadata about the wallet provider
            // The metadata format may vary, but typically includes:
            // - name: Provider name
            // - wabUrl: Wallet Authentication Backend URL
            // - storageUrl: Storage provider URL
            // - description: Provider description

            const config: WalletConfig = {
              name: result.name || result.domain || 'Unknown Provider',
              description: result.description || '',
              wabUrl: result.wabUrl || result.wab_url || '',
              storageUrl: result.storageUrl || result.storage_url || '',
              network: selectedNetwork,
              method: result.method || result.authMethod || 'Twilio',
              icon: result.icon || result.iconUrl
            }

            // Only add configs that have valid, non-empty URLs
            if (config.wabUrl && config.wabUrl.trim() !== '' &&
                config.storageUrl && config.storageUrl.trim() !== '') {
              parsedConfigs.push(config)
            } else {
              console.log('[WalletConfigPicker] Skipping config with empty URLs:', config.name)
            }
          } catch (err) {
            console.error('[WalletConfigPicker] Error parsing config:', err)
          }
        }
      }

      // Add self-custodial option as the first choice (fully local, no backend)
      const selfCustodialConfig: WalletConfig = {
        name: 'Self-Custodial Wallet',
        description: 'Complete independence - your keys, your coins. Uses a mnemonic seed phrase with no backend services required',
        wabUrl: 'noWAB', // Special marker for no backend
        storageUrl: 'local', // Special marker for local storage
        network: selectedNetwork,
        method: 'mnemonic',
        icon: 'key-outline'
      }

      // Add local storage with WAB option as second choice
      const localStorageConfig: WalletConfig = {
        name: 'Local Storage + Cloud Auth',
        description: 'Store wallet data locally but use cloud authentication for account recovery',
        wabUrl: selectedNetwork === 'main'
          ? 'https://wab-eu-1.bsvb.tech'
          : 'https://wab-testnet-eu-1.bsvb.tech',
        storageUrl: 'local', // Special marker for local storage
        network: selectedNetwork,
        method: 'Twilio',
        icon: 'phone-portrait-outline'
      }

      // Insert self-custodial and local storage at the beginning
      parsedConfigs.unshift(selfCustodialConfig, localStorageConfig)

      // Add default BSV Association providers if no remote configs found
      if (parsedConfigs.length === 2) { // Only self-custodial and local storage exist
        parsedConfigs.push({
          name: 'BSV Association (EU)',
          description: 'Official BSV Association wallet services hosted in Europe',
          wabUrl: selectedNetwork === 'main'
            ? 'https://wab-eu-1.bsvb.tech'
            : 'https://wab-testnet-eu-1.bsvb.tech',
          storageUrl: selectedNetwork === 'main'
            ? 'https://store-eu-1.bsvb.tech'
            : 'https://store-testnet-eu-1.bsvb.tech',
          network: selectedNetwork,
          method: 'Twilio'
        })

        parsedConfigs.push({
          name: 'BSV Association (US)',
          description: 'Official BSV Association wallet services hosted in United States',
          wabUrl: selectedNetwork === 'main'
            ? 'https://wab-us-1.bsvb.tech'
            : 'https://wab-testnet-us-1.bsvb.tech',
          storageUrl: selectedNetwork === 'main'
            ? 'https://store-us-1.bsvb.tech'
            : 'https://store-testnet-us-1.bsvb.tech',
          network: selectedNetwork,
          method: 'Twilio'
        })
      }

      setConfigs(parsedConfigs)
    } catch (err: any) {
      console.error('[WalletConfigPicker] Error loading configs:', err)
      setError(err.message || 'Failed to load wallet configurations')

      // Fallback to default configs on error (always include local options)
      setConfigs([
        {
          name: 'Self-Custodial Wallet',
          description: 'Complete independence - your keys, your coins. Uses a mnemonic seed phrase with no backend services required',
          wabUrl: 'noWAB',
          storageUrl: 'local',
          network: selectedNetwork,
          method: 'mnemonic',
          icon: 'key-outline'
        },
        {
          name: 'Local Storage + Cloud Auth',
          description: 'Store wallet data locally but use cloud authentication for account recovery',
          wabUrl: selectedNetwork === 'main'
            ? 'https://wab-eu-1.bsvb.tech'
            : 'https://wab-testnet-eu-1.bsvb.tech',
          storageUrl: 'local',
          network: selectedNetwork,
          method: 'Twilio',
          icon: 'phone-portrait-outline'
        },
        {
          name: 'BSV Association (EU)',
          description: 'Official BSV Association wallet services hosted in Europe',
          wabUrl: selectedNetwork === 'main'
            ? 'https://wab-eu-1.bsvb.tech'
            : 'https://wab-testnet-eu-1.bsvb.tech',
          storageUrl: selectedNetwork === 'main'
            ? 'https://store-eu-1.bsvb.tech'
            : 'https://store-testnet-eu-1.bsvb.tech',
          network: selectedNetwork,
          method: 'Twilio'
        }
      ])
    } finally {
      setLoading(false)
    }
  }

  const handleSelectConfig = async (config: WalletConfig) => {
    try {
      // Skip WAB verification for noWAB (self-custodial) configs
      if (config.wabUrl === 'noWAB') {
        console.log('[WalletConfigPicker] Selected self-custodial wallet (noWAB)')
        onSelectConfig(config as any)
        return
      }

      // Verify the WAB URL is accessible before selecting
      const response = await fetch(`${config.wabUrl}/info`, {
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      })

      if (!response.ok) {
        throw new Error(`WAB service not available (status: ${response.status})`)
      }

      const wabInfo = await response.json()

      // Add WAB info to the config
      const fullConfig = {
        ...config,
        wabInfo
      }

      onSelectConfig(fullConfig as any)
    } catch (err: any) {
      console.error('[WalletConfigPicker] Error verifying config:', err)
      Alert.alert(
        t('error'),
        `Could not connect to ${config.name}. ${err.message || 'Please try another provider.'}`
      )
    }
  }

  if (loading) {
    return (
      <View style={{ padding: 20, alignItems: 'center' }}>
        <ActivityIndicator size="large" color={colors.secondary} />
        <Text style={[styles.textSecondary, { marginTop: 10 }]}>
          {t('loading_wallet_providers')}
        </Text>
      </View>
    )
  }

  if (error && configs.length === 0) {
    return (
      <View style={{ padding: 20 }}>
        <Text style={[styles.text, { color: colors.error, textAlign: 'center' }]}>
          {error}
        </Text>
        <TouchableOpacity
          style={[styles.button, { marginTop: 15 }]}
          onPress={loadWalletConfigs}
        >
          <Text style={styles.buttonText}>{t('retry')}</Text>
        </TouchableOpacity>
      </View>
    )
  }

  return (
    <ScrollView style={{ maxHeight: 400 }}>
      <Text style={[styles.textSecondary, { padding: 15, paddingBottom: 10 }]}>
        {t('select_wallet_provider_description')}
      </Text>

      {configs.map((config, index) => {
        const isLocalStorage = config.storageUrl === 'local'
        const isNoWAB = config.wabUrl === 'noWAB'
        const isSelfCustodial = isNoWAB && isLocalStorage

        return (
          <TouchableOpacity
            key={`${config.name}-${index}`}
            style={{
              padding: 15,
              marginHorizontal: 15,
              marginBottom: 10,
              borderRadius: 10,
              backgroundColor: isSelfCustodial ? colors.primary + '15' : (isLocalStorage ? colors.success + '15' : colors.inputBackground),
              borderWidth: isSelfCustodial ? 2 : (isLocalStorage ? 2 : 1),
              borderColor: isSelfCustodial ? colors.primary : (isLocalStorage ? colors.success : colors.inputBorder),
              flexDirection: 'row',
              alignItems: 'center'
            }}
            onPress={() => handleSelectConfig(config)}
          >
            {isSelfCustodial && (
              <View style={{ marginRight: 12 }}>
                <Ionicons name="key-outline" size={32} color={colors.primary} />
              </View>
            )}
            {isLocalStorage && !isSelfCustodial && (
              <View style={{ marginRight: 12 }}>
                <Ionicons name="phone-portrait-outline" size={32} color={colors.success} />
              </View>
            )}
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 5 }}>
                <Text style={[styles.text, { fontWeight: 'bold', fontSize: 16 }]}>
                  {config.name}
                </Text>
                {isSelfCustodial && (
                  <View style={{
                    marginLeft: 8,
                    paddingHorizontal: 8,
                    paddingVertical: 2,
                    backgroundColor: colors.primary,
                    borderRadius: 4
                  }}>
                    <Text style={{ fontSize: 10, color: '#fff', fontWeight: 'bold' }}>
                      RECOMMENDED
                    </Text>
                  </View>
                )}
              </View>
              {config.description && (
                <Text style={[styles.textSecondary, { fontSize: 14, marginBottom: 8 }]}>
                  {config.description}
                </Text>
              )}
              <Text style={[styles.textSecondary, { fontSize: 12 }]}>
                Auth: {isNoWAB ? 'Mnemonic seed phrase' : (config.wabUrl ? new URL(config.wabUrl).hostname : 'Not configured')}
              </Text>
              <Text style={[styles.textSecondary, { fontSize: 12 }]}>
                Storage: {isLocalStorage ? 'On this device' : (config.storageUrl ? new URL(config.storageUrl).hostname : 'Not configured')}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={24} color={isSelfCustodial ? colors.primary : (isLocalStorage ? colors.success : colors.secondary)} />
          </TouchableOpacity>
        )
      })}
    </ScrollView>
  )
}

export default WalletConfigPicker
