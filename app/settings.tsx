import React, { useState, useEffect } from 'react'
import { View, Text, SafeAreaView, TouchableOpacity, ScrollView, Alert, TextInput, StyleSheet } from 'react-native'
import { useTranslation } from 'react-i18next'
import { useTheme, ThemeMode } from '@/context/theme/ThemeContext'
import { spacing, radii, typography } from '@/context/theme/tokens'
import { Ionicons } from '@expo/vector-icons'
import { useWallet } from '@/context/WalletContext'
import { useLocalStorage } from '@/context/LocalStorageProvider'
import { DEFAULT_HOMEPAGE_URL } from '@/shared/constants'
import { GroupedSection } from '@/components/ui/GroupedList'
import { ListRow } from '@/components/ui/ListRow'
import SegmentedControl from '@react-native-segmented-control/segmented-control'

export default function SettingsScreen() {
  const { t } = useTranslation()
  const { colors, mode, setThemeMode } = useTheme()
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

  // Segmented control values and mapping
  const themeModes: ThemeMode[] = ['light', 'dark', 'system']
  const themeLabels = [t('light'), t('dark'), t('system_default')]
  const selectedThemeIndex = themeModes.indexOf(mode)

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.backgroundSecondary }}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingTop: spacing.xxl, paddingBottom: spacing.xxxl }}
      >
        {/* ── General ── */}
        <GroupedSection
          header="General"
          footer="The page that loads when you open a new tab."
        >
          {editingHomepage ? (
            <View style={localStyles.editContainer}>
              <TextInput
                style={[
                  localStyles.urlInput,
                  {
                    backgroundColor: colors.fillTertiary,
                    borderColor: colors.separator,
                    color: colors.textPrimary,
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
                placeholderTextColor={colors.textTertiary}
              />
              <View style={localStyles.editButtons}>
                <TouchableOpacity
                  style={[
                    localStyles.editButton,
                    { backgroundColor: colors.accent }
                  ]}
                  onPress={() => saveHomepageUrl(homepageUrl)}
                >
                  <Text style={[localStyles.editButtonText, { color: colors.textOnAccent }]}>
                    Save
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    localStyles.editButton,
                    {
                      backgroundColor: colors.fillTertiary,
                      borderWidth: StyleSheet.hairlineWidth,
                      borderColor: colors.separator,
                    }
                  ]}
                  onPress={() => {
                    setEditingHomepage(false)
                    ;(async () => {
                      const stored = await getItem('homepageUrl')
                      setHomepageUrl(stored || DEFAULT_HOMEPAGE_URL)
                    })()
                  }}
                >
                  <Text style={[localStyles.editButtonText, { color: colors.textPrimary }]}>
                    Cancel
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : (
            <ListRow
              label="Homepage"
              value={homepageUrl}
              icon="globe-outline"
              iconColor={colors.accent}
              onPress={() => setEditingHomepage(true)}
              isLast
            />
          )}
        </GroupedSection>

        {/* ── Appearance ── */}
        <GroupedSection header="Appearance">
          <View style={localStyles.segmentedContainer}>
            <Text style={[localStyles.segmentedLabel, { color: colors.textPrimary }]}>
              Theme
            </Text>
            <SegmentedControl
              values={themeLabels}
              selectedIndex={selectedThemeIndex >= 0 ? selectedThemeIndex : 2}
              onChange={(event) => {
                const index = event.nativeEvent.selectedSegmentIndex
                handleThemeChange(themeModes[index])
              }}
              style={localStyles.segmentedControl}
            />
          </View>
        </GroupedSection>

        {/* ── Wallet ── */}
        <GroupedSection header="Wallet">
          <ListRow
            label={t('bsv_network')}
            value={selectedNetwork || 'main'}
            icon="server-outline"
            iconColor={colors.success}
            showChevron={false}
          />
          <ListRow
            label="Storage"
            value="Local (on-device)"
            icon="hardware-chip-outline"
            iconColor={colors.warning}
            showChevron={false}
          />
          {!showMnemonic ? (
            <ListRow
              label={t('recovery_phrase')}
              icon="key-outline"
              iconColor={colors.accentSecondary}
              onPress={handleShowMnemonic}
              isLast
            />
          ) : (
            <View style={localStyles.mnemonicSection}>
              {/* Mnemonic Display */}
              <View
                style={[
                  localStyles.mnemonicBox,
                  {
                    backgroundColor: colors.fillTertiary,
                    borderColor: colors.accentSecondary,
                  }
                ]}
              >
                <Text
                  style={[
                    localStyles.mnemonicText,
                    { color: colors.textPrimary }
                  ]}
                  selectable
                >
                  {mnemonic}
                </Text>
              </View>

              {/* Warning Message */}
              <View
                style={[
                  localStyles.warningBox,
                  { backgroundColor: colors.error + '10' }
                ]}
              >
                <Ionicons
                  name="warning-outline"
                  size={18}
                  color={colors.error}
                  style={{ marginRight: spacing.sm }}
                />
                <Text style={[localStyles.warningText, { color: colors.textSecondary }]}>
                  {t('recovery_phrase_security_warning')}
                </Text>
              </View>

              {/* Hide Button */}
              <TouchableOpacity
                style={[
                  localStyles.hideButton,
                  { backgroundColor: colors.fillTertiary }
                ]}
                onPress={handleHideMnemonic}
              >
                <Ionicons
                  name="eye-off-outline"
                  size={18}
                  color={colors.textPrimary}
                  style={{ marginRight: spacing.sm }}
                />
                <Text style={[localStyles.hideButtonText, { color: colors.textPrimary }]}>
                  {t('hide_recovery_phrase')}
                </Text>
              </TouchableOpacity>
            </View>
          )}
        </GroupedSection>

        {/* ── Account ── */}
        <GroupedSection>
          <ListRow
            label={t('logout')}
            icon="log-out-outline"
            iconColor={colors.error}
            onPress={logout}
            destructive
            showChevron={false}
            isLast
          />
        </GroupedSection>
      </ScrollView>
    </SafeAreaView>
  )
}

const localStyles = StyleSheet.create({
  /* ── Homepage editing ── */
  editContainer: {
    padding: spacing.lg,
  },
  urlInput: {
    ...typography.body,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    marginBottom: spacing.md,
  },
  editButtons: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  editButton: {
    flex: 1,
    paddingVertical: spacing.md,
    borderRadius: radii.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  editButtonText: {
    ...typography.headline,
  },

  /* ── Segmented control ── */
  segmentedContainer: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  segmentedLabel: {
    ...typography.body,
    marginBottom: spacing.md,
  },
  segmentedControl: {
    height: 32,
  },

  /* ── Mnemonic reveal ── */
  mnemonicSection: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
  },
  mnemonicBox: {
    padding: spacing.lg,
    borderRadius: radii.sm,
    borderWidth: 1.5,
    marginBottom: spacing.md,
  },
  mnemonicText: {
    ...typography.callout,
    fontFamily: 'monospace',
    lineHeight: 22,
    textAlign: 'center',
  },
  warningBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: spacing.md,
    borderRadius: radii.sm,
    marginBottom: spacing.md,
  },
  warningText: {
    ...typography.footnote,
    flex: 1,
  },
  hideButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.md,
    borderRadius: radii.sm,
  },
  hideButtonText: {
    ...typography.subhead,
    fontWeight: '500',
  },
})
