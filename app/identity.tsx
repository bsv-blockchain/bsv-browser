import React, { useEffect, useState } from 'react'
import { View, Text, StyleSheet, TouchableOpacity, Alert } from 'react-native'
import CustomSafeArea from '@/components/ui/CustomSafeArea'
import { MaterialIcons } from '@expo/vector-icons'
import { StatusBar } from 'expo-status-bar'
import * as Clipboard from 'expo-clipboard'
import { useTranslation } from 'react-i18next'
import { useTheme } from '@/context/theme/ThemeContext'
import { useThemeStyles } from '@/context/theme/useThemeStyles'
import { useWallet } from '@/context/WalletContext'

export default function IdentityScreen() {
  // Get theme colors and translation
  const { t } = useTranslation()
  const { colors, isDark } = useTheme()
  const themeStyles = useThemeStyles()
  const { managers, adminOriginator } = useWallet()
  const [identityKey, setIdentityKey] = useState<string>('')
  const [privilegedKey, setPrivilegedKey] = useState<string>('')
  const [showPrivilegedKey, setShowPrivilegedKey] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copiedPrivileged, setCopiedPrivileged] = useState(false)

  const handleCopy = async () => {
    await Clipboard.setString(identityKey)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleCopyPrivilegedKey = async () => {
    await Clipboard.setString(privilegedKey)
    setCopiedPrivileged(true)
    setTimeout(() => setCopiedPrivileged(false), 2000)
  }

  const handleRevealKey = async () => {
    try {
      // Check if the managers are available
      if (!managers?.permissionsManager) {
        Alert.alert(t('error'), t('wallet_manager_not_available'))
        return
      }
      // Request password authentication
      const { publicKey } = await managers.permissionsManager!.getPublicKey({
        identityKey: true,
        privileged: true,
        privilegedReason: t('privileged_reason')
      })
      setPrivilegedKey(publicKey)
      setShowPrivilegedKey(true)
    } catch (error) {
      console.error('Failed to reveal key:', error)
      Alert.alert(t('error'), t('failed_to_reveal_key'))
    }
  }

  useEffect(() => {
    async function getIdentityKey() {
      const response = await managers?.permissionsManager?.getPublicKey({ identityKey: true }, adminOriginator)
      if (response) {
        setIdentityKey(response.publicKey)
      }
    }
    getIdentityKey()
  }, [managers, adminOriginator])

  return (
    <CustomSafeArea style={themeStyles.container}>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <View style={themeStyles.contentContainer}>
        <Text style={[themeStyles.title, { color: colors.textPrimary, textAlign: 'left', alignSelf: 'flex-start' }]}>
          {t('identity')}
        </Text>
        <Text style={[themeStyles.textSecondary, { marginBottom: 20, textAlign: 'left', alignSelf: 'flex-start' }]}>
          {t('manage_digital_identity')}
        </Text>
        <View style={styles.keySection}>
          <Text style={styles.keyLabel}>{t('identity_key')}</Text>
          <View style={styles.keyContainer}>
            <Text
              style={[styles.keyText, { backgroundColor: colors.paperBackground }]}
              numberOfLines={1}
              ellipsizeMode="middle"
            >
              {identityKey}
            </Text>
            <TouchableOpacity
              style={[styles.copyButton, { backgroundColor: colors.paperBackground }]}
              onPress={handleCopy}
              disabled={copied}
            >
              <MaterialIcons name={copied ? 'check' : 'content-copy'} size={20} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <Text style={[styles.keyLabel, { marginTop: 20 }]}>{t('privileged_identity_key')}</Text>
          {showPrivilegedKey ? (
            <View style={styles.keyContainer}>
              <Text
                style={[styles.keyText, { backgroundColor: colors.paperBackground }]}
                numberOfLines={1}
                ellipsizeMode="middle"
              >
                {privilegedKey}
              </Text>
              <TouchableOpacity
                style={[styles.copyButton, { backgroundColor: colors.paperBackground }]}
                onPress={handleCopyPrivilegedKey}
                disabled={copiedPrivileged}
              >
                <MaterialIcons
                  name={copiedPrivileged ? 'check' : 'content-copy'}
                  size={20}
                  color={colors.textSecondary}
                />
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity
              style={[styles.revealButton, { backgroundColor: colors.primary }]}
              onPress={handleRevealKey}
            >
              <Text style={{ color: colors.buttonText, fontSize: 16, fontWeight: '500' }}>{t('reveal_key')}</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </CustomSafeArea>
  )
}

const styles = StyleSheet.create({
  keySection: {
    width: '100%'
  },
  keyLabel: {
    fontSize: 16,
    fontWeight: '500',
    marginBottom: 8,
    color: '#666' // Will be overridden by theme color
  },
  keyContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%'
  },
  keyText: {
    flex: 1,
    fontFamily: 'monospace',
    fontSize: 14,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 6,
    color: '#666' // Will be overridden by theme color
  },
  copyButton: {
    marginLeft: 8,
    padding: 8,
    borderRadius: 6,
    justifyContent: 'center',
    alignItems: 'center'
  },
  revealButton: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center'
  }
})
