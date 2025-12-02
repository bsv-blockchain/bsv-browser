import React, { useState } from 'react'
import { View, Text, SafeAreaView, TouchableOpacity, ScrollView, Alert } from 'react-native'
import { useTranslation } from 'react-i18next'
import { useTheme, ThemeMode } from '@/context/theme/ThemeContext'
import { useThemeStyles } from '@/context/theme/useThemeStyles'
import { Ionicons } from '@expo/vector-icons'
import { useWallet } from '@/context/WalletContext'
import { useLocalStorage } from '@/context/LocalStorageProvider'

export default function SettingsScreen() {
  const { t } = useTranslation()
  const { colors, mode, setThemeMode } = useTheme()
  const styles = useThemeStyles()
  const { updateSettings, settings, logout, selectedWabUrl, selectedStorageUrl, selectedNetwork, selectedMethod } = useWallet()
  const { getMnemonic } = useLocalStorage()
  const [showMnemonic, setShowMnemonic] = useState(false)
  const [mnemonic, setMnemonic] = useState<string | null>(null)

  // Handle theme mode change
  const handleThemeChange = async (newMode: ThemeMode) => {
    setThemeMode(newMode)

    // Also update in wallet settings if available
    if (updateSettings && settings) {
      await updateSettings({
        ...settings,
        theme: {
          ...settings.theme,
          mode: newMode
        }
      })
    }
  }

  // Handle showing mnemonic with confirmation
  const handleShowMnemonic = async () => {
    Alert.alert(
      t('show_recovery_phrase'),
      t('recovery_phrase_warning'),
      [
        {
          text: t('cancel'),
          style: 'cancel'
        },
        {
          text: t('show'),
          style: 'destructive',
          onPress: async () => {
            try {
              const mnemonicValue = await getMnemonic()
              if (mnemonicValue) {
                setMnemonic(mnemonicValue)
                setShowMnemonic(true)
              } else {
                Alert.alert(t('error'), t('no_recovery_phrase_found'))
              }
            } catch (error) {
              console.error('Error retrieving mnemonic:', error)
              Alert.alert(t('error'), t('failed_to_retrieve_recovery_phrase'))
            }
          }
        }
      ]
    )
  }

  // Handle hiding mnemonic
  const handleHideMnemonic = () => {
    setShowMnemonic(false)
    setMnemonic(null)
  }

  // Check if we're in noWAB mode (mnemonic/self-custodial mode)
  const isNoWABMode = selectedWabUrl === 'noWAB' || selectedMethod === 'mnemonic'

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView style={{ flex: 1 }}>          
          {/* Account Section */}
          <View style={[styles.card, { marginTop: 20 }]}>
            <Text style={[styles.text, { fontWeight: 'bold', fontSize: 18, marginBottom: 15 }]}>{t('wallet_configuration')}</Text>

            {/* Wallet Configuration URLs */}
            <View style={{ marginBottom: 20 }}>              
              {/* WAB URL */}
              <View style={{ marginBottom: 12 }}>
                <Text style={[styles.textSecondary, { fontSize: 14, marginBottom: 4 }]}>
                  {t('wab_url')}
                </Text>
                <View style={[
                  styles.row,
                  {
                    paddingHorizontal: 12,
                    paddingVertical: 6,
                    borderRadius: 8,
                    backgroundColor: colors.paperBackground,
                    borderWidth: 1,
                    borderColor: colors.inputBorder,
                  }
                ]}>
                  <Text style={[styles.textSecondary, { fontSize: 14, flex: 1, textAlign: 'center' }]} numberOfLines={1}>
                    {selectedWabUrl || 'Not configured'}
                  </Text>
                </View>
              </View>

              {/* Wallet Storage URL */}
              <View style={{ marginBottom: 12 }}>
                <Text style={[styles.textSecondary, { fontSize: 14, marginBottom: 4 }]}>
                  {t('wallet_storage_url')}
                </Text>
                <View style={[
                  styles.row,
                  {
                    paddingHorizontal: 12,
                    paddingVertical: 6,
                    borderRadius: 8,
                    backgroundColor: colors.paperBackground,
                    borderWidth: 1,
                    borderColor: colors.inputBorder
                  }
                ]}>
                  <Text style={[styles.textSecondary, { fontSize: 14, flex: 1, textAlign: 'center' }]} numberOfLines={1}>
                    {selectedStorageUrl || 'Not configured'}
                  </Text>
                </View>
              </View>

              {/* NETWORK */}
              <View style={{ marginBottom: 12 }}>
                <Text style={[styles.textSecondary, { fontSize: 14, marginBottom: 4 }]}>
                  {t('bsv_network')}
                </Text>
                <View style={[
                  styles.row,
                  {
                    paddingHorizontal: 12,
                    paddingVertical: 6,
                    borderRadius: 8,
                    backgroundColor: colors.paperBackground,
                    borderWidth: 1,
                    borderColor: colors.inputBorder
                  }
                ]}>
                  <Text style={[styles.textSecondary, { fontSize: 14, flex: 1, textAlign: 'center' }]} numberOfLines={1}>
                    {selectedNetwork || 'Not configured'}
                  </Text>
                </View>
              </View>

              {/* Explanation text */}
              <Text style={[styles.textSecondary, { fontSize: 13, fontStyle: 'italic', marginBottom: 15 }]}>
                {t('logout_to_change_urls')}
              </Text>
            </View>

            <TouchableOpacity
              style={[styles.row, { padding: 15, borderRadius: 8, backgroundColor: colors.error + '20' }]}
              onPress={logout}
            >
              <View style={[styles.row, { flex: 1 }]}>
                <Ionicons name="log-out-outline" size={24} color={colors.error} style={{ marginRight: 10 }} />
                <Text style={[styles.text, { color: colors.error }]}>{t('logout')}</Text>
              </View>
            </TouchableOpacity>
          </View>

          {/* Recovery Phrase Section (only for mnemonic/noWAB mode) */}
          {isNoWABMode && (
            <View style={styles.card}>
              <Text style={[styles.text, { fontWeight: 'bold', fontSize: 18, marginBottom: 15 }]}>
                {t('recovery_phrase')}
              </Text>

              <Text style={[styles.textSecondary, { fontSize: 13, marginBottom: 15 }]}>
                {t('recovery_phrase_description')}
              </Text>

              {!showMnemonic ? (
                <TouchableOpacity
                  style={[
                    styles.row,
                    {
                      padding: 15,
                      borderRadius: 8,
                      backgroundColor: colors.secondary + '20',
                      justifyContent: 'center'
                    }
                  ]}
                  onPress={handleShowMnemonic}
                >
                  <Ionicons name="eye-outline" size={24} color={colors.secondary} style={{ marginRight: 10 }} />
                  <Text style={[styles.text, { color: colors.secondary }]}>{t('show_recovery_phrase')}</Text>
                </TouchableOpacity>
              ) : (
                <View>
                  {/* Mnemonic Display */}
                  <View
                    style={{
                      padding: 15,
                      borderRadius: 8,
                      backgroundColor: colors.paperBackground,
                      borderWidth: 2,
                      borderColor: colors.secondary,
                      marginBottom: 15
                    }}
                  >
                    <Text
                      style={[
                        styles.text,
                        {
                          fontSize: 16,
                          lineHeight: 24,
                          fontFamily: 'monospace',
                          textAlign: 'center'
                        }
                      ]}
                      selectable
                    >
                      {mnemonic}
                    </Text>
                  </View>

                  {/* Warning Message */}
                  <View
                    style={{
                      padding: 12,
                      borderRadius: 8,
                      backgroundColor: colors.error + '10',
                      marginBottom: 15,
                      flexDirection: 'row',
                      alignItems: 'flex-start'
                    }}
                  >
                    <Ionicons name="warning-outline" size={20} color={colors.error} style={{ marginRight: 8, marginTop: 2 }} />
                    <Text style={[styles.textSecondary, { fontSize: 13, flex: 1 }]}>
                      {t('recovery_phrase_security_warning')}
                    </Text>
                  </View>

                  {/* Hide Button */}
                  <TouchableOpacity
                    style={[
                      styles.row,
                      {
                        padding: 15,
                        borderRadius: 8,
                        backgroundColor: colors.paperBackground,
                        borderWidth: 1,
                        borderColor: colors.inputBorder,
                        justifyContent: 'center'
                      }
                    ]}
                    onPress={handleHideMnemonic}
                  >
                    <Ionicons name="eye-off-outline" size={24} color={colors.textPrimary} style={{ marginRight: 10 }} />
                    <Text style={styles.text}>{t('hide_recovery_phrase')}</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          )}

          {/* Theme Section */}
          <View style={styles.card}>
            <Text style={[styles.text, { fontWeight: 'bold', fontSize: 18, marginBottom: 15 }]}>{t('appearance')}</Text>

            <Text style={[styles.textSecondary, { marginBottom: 10 }]}>{t('choose_theme_mode')}</Text>

            {/* Light Mode Option */}
            <TouchableOpacity
              style={[
                styles.row,
                {
                  padding: 15,
                  borderRadius: 8,
                  backgroundColor: mode === 'light' ? colors.secondary + '20' : 'transparent'
                }
              ]}
              onPress={() => handleThemeChange('light')}
            >
              <View style={[styles.row, { flex: 1 }]}>
                <Ionicons name="sunny-outline" size={24} color={colors.textPrimary} style={{ marginRight: 10 }} />
                <Text style={styles.text}>{t('light')}</Text>
              </View>
              {mode === 'light' && <Ionicons name="checkmark-circle" size={24} color={colors.secondary} />}
            </TouchableOpacity>

            {/* Dark Mode Option */}
            <TouchableOpacity
              style={[
                styles.row,
                {
                  padding: 15,
                  borderRadius: 8,
                  backgroundColor: mode === 'dark' ? colors.secondary + '20' : 'transparent'
                }
              ]}
              onPress={() => handleThemeChange('dark')}
            >
              <View style={[styles.row, { flex: 1 }]}>
                <Ionicons name="moon-outline" size={24} color={colors.textPrimary} style={{ marginRight: 10 }} />
                <Text style={styles.text}>{t('dark')}</Text>
              </View>
              {mode === 'dark' && <Ionicons name="checkmark-circle" size={24} color={colors.secondary} />}
            </TouchableOpacity>

            {/* System Mode Option */}
            <TouchableOpacity
              style={[
                styles.row,
                {
                  padding: 15,
                  borderRadius: 8,
                  backgroundColor: mode === 'system' ? colors.secondary + '20' : 'transparent'
                }
              ]}
              onPress={() => handleThemeChange('system')}
            >
              <View style={[styles.row, { flex: 1 }]}>
                <Ionicons
                  name="phone-portrait-outline"
                  size={24}
                  color={colors.textPrimary}
                  style={{ marginRight: 10 }}
                />
                <Text style={styles.text}>{t('system_default')}</Text>
              </View>
              {mode === 'system' && <Ionicons name="checkmark-circle" size={24} color={colors.secondary} />}
            </TouchableOpacity>
          </View>

          {/* Other Settings Sections can be added here */}
      </ScrollView>
    </SafeAreaView>
  )
}

// Styles are provided by useThemeStyles hook
