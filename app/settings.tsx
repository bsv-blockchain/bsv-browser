import React, { useState, useEffect } from 'react'
import { View, Text, SafeAreaView, TouchableOpacity, ScrollView, Alert, TextInput } from 'react-native'
import { useTranslation } from 'react-i18next'
import { useTheme, ThemeMode } from '@/context/theme/ThemeContext'
import { useThemeStyles } from '@/context/theme/useThemeStyles'
import { Ionicons } from '@expo/vector-icons'
import { useWallet } from '@/context/WalletContext'
import { useLocalStorage } from '@/context/LocalStorageProvider'
import { DEFAULT_HOMEPAGE_URL } from '@/shared/constants'

export default function SettingsScreen() {
  const { t } = useTranslation()
  const { colors, mode, setThemeMode } = useTheme()
  const styles = useThemeStyles()
  const { updateSettings, settings, logout, selectedNetwork } = useWallet()
  const { getMnemonic, getItem, setItem } = useLocalStorage()
  const [showMnemonic, setShowMnemonic] = useState(false)
  const [mnemonic, setMnemonic] = useState<string | null>(null)
  const [homepageUrl, setHomepageUrl] = useState(DEFAULT_HOMEPAGE_URL)
  const [editingHomepage, setEditingHomepage] = useState(false)

  // Load homepage URL from storage
  useEffect(() => {
    ;(async () => {
      const stored = await getItem('homepageUrl')
      if (stored) setHomepageUrl(stored)
    })()
  }, [getItem])

  const saveHomepageUrl = async (url: string) => {
    const trimmed = url.trim()
    if (trimmed) {
      setHomepageUrl(trimmed)
      await setItem('homepageUrl', trimmed)
    }
    setEditingHomepage(false)
  }

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

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView style={{ flex: 1 }}>
          {/* Homepage Section */}
          <View style={[styles.card, { marginTop: 20 }]}>
            <Text style={[styles.text, { fontWeight: 'bold', fontSize: 18, marginBottom: 15 }]}>Homepage</Text>

            <Text style={[styles.textSecondary, { fontSize: 13, marginBottom: 10 }]}>
              The page that loads when you open the app.
            </Text>

            {editingHomepage ? (
              <View>
                <TextInput
                  style={[
                    styles.input,
                    {
                      fontSize: 14,
                      marginBottom: 10,
                      padding: 12,
                      borderRadius: 8,
                      backgroundColor: colors.paperBackground,
                      borderWidth: 1,
                      borderColor: colors.inputBorder,
                      color: colors.textPrimary
                    }
                  ]}
                  value={homepageUrl}
                  onChangeText={setHomepageUrl}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  returnKeyType="done"
                  onSubmitEditing={() => saveHomepageUrl(homepageUrl)}
                  placeholder={DEFAULT_HOMEPAGE_URL}
                  placeholderTextColor={colors.textSecondary}
                />
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <TouchableOpacity
                    style={[styles.row, { flex: 1, padding: 12, borderRadius: 8, backgroundColor: colors.primary, justifyContent: 'center' }]}
                    onPress={() => saveHomepageUrl(homepageUrl)}
                  >
                    <Text style={[styles.text, { color: colors.buttonText }]}>Save</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.row, { flex: 1, padding: 12, borderRadius: 8, backgroundColor: colors.paperBackground, borderWidth: 1, borderColor: colors.inputBorder, justifyContent: 'center' }]}
                    onPress={() => {
                      setEditingHomepage(false)
                      ;(async () => {
                        const stored = await getItem('homepageUrl')
                        setHomepageUrl(stored || DEFAULT_HOMEPAGE_URL)
                      })()
                    }}
                  >
                    <Text style={styles.text}>Cancel</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              <TouchableOpacity
                style={[
                  styles.row,
                  {
                    paddingHorizontal: 12,
                    paddingVertical: 10,
                    borderRadius: 8,
                    backgroundColor: colors.paperBackground,
                    borderWidth: 1,
                    borderColor: colors.inputBorder,
                  }
                ]}
                onPress={() => setEditingHomepage(true)}
              >
                <Text style={[styles.textSecondary, { fontSize: 14, flex: 1 }]} numberOfLines={1}>
                  {homepageUrl}
                </Text>
                <Ionicons name="pencil-outline" size={18} color={colors.textSecondary} />
              </TouchableOpacity>
            )}
          </View>

          {/* Account Section */}
          <View style={styles.card}>
            <Text style={[styles.text, { fontWeight: 'bold', fontSize: 18, marginBottom: 15 }]}>{t('wallet_configuration')}</Text>

            {/* Network */}
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
                  {selectedNetwork || 'main'}
                </Text>
              </View>
            </View>

            <View style={{ marginBottom: 12 }}>
              <Text style={[styles.textSecondary, { fontSize: 14, marginBottom: 4 }]}>
                Storage
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
                  Local (on-device)
                </Text>
              </View>
            </View>

            <TouchableOpacity
              style={[styles.row, { padding: 15, borderRadius: 8, backgroundColor: colors.error + '20', marginTop: 10 }]}
              onPress={logout}
            >
              <View style={[styles.row, { flex: 1 }]}>
                <Ionicons name="log-out-outline" size={24} color={colors.error} style={{ marginRight: 10 }} />
                <Text style={[styles.text, { color: colors.error }]}>{t('logout')}</Text>
              </View>
            </TouchableOpacity>
          </View>

          {/* Recovery Phrase Section */}
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
