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

            // Only add configs that have required URLs
            if (config.wabUrl && config.storageUrl) {
              parsedConfigs.push(config)
            }
          } catch (err) {
            console.error('[WalletConfigPicker] Error parsing config:', err)
          }
        }
      }

      // Add default BSV Association providers if no configs found
      if (parsedConfigs.length === 0) {
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

      // Fallback to default configs on error
      setConfigs([{
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
      }])
    } finally {
      setLoading(false)
    }
  }

  const handleSelectConfig = async (config: WalletConfig) => {
    try {
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

      {configs.map((config, index) => (
        <TouchableOpacity
          key={`${config.name}-${index}`}
          style={{
            padding: 15,
            marginHorizontal: 15,
            marginBottom: 10,
            borderRadius: 10,
            backgroundColor: colors.inputBackground,
            borderWidth: 1,
            borderColor: colors.inputBorder,
            flexDirection: 'row',
            alignItems: 'center'
          }}
          onPress={() => handleSelectConfig(config)}
        >
          <View style={{ flex: 1 }}>
            <Text style={[styles.text, { fontWeight: 'bold', fontSize: 16, marginBottom: 5 }]}>
              {config.name}
            </Text>
            {config.description && (
              <Text style={[styles.textSecondary, { fontSize: 14, marginBottom: 8 }]}>
                {config.description}
              </Text>
            )}
            <Text style={[styles.textSecondary, { fontSize: 12 }]}>
              WAB: {new URL(config.wabUrl).hostname}
            </Text>
            <Text style={[styles.textSecondary, { fontSize: 12 }]}>
              Storage: {new URL(config.storageUrl).hostname}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={24} color={colors.secondary} />
        </TouchableOpacity>
      ))}
    </ScrollView>
  )
}

export default WalletConfigPicker
