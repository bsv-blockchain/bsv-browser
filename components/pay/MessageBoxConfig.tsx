/**
 * MessageBox server configuration — the state hook and the panel.
 *
 * Both are copied verbatim out of app/payments.tsx (useMessageBoxConfig and
 * ConfigPanel). The only change: the storage key, the default host and the
 * "no server" sentinel are imported from the handle rail rather than redeclared
 * here, so the screen and the rail cannot disagree about what they mean.
 */
import React, { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { showToast } from '@/components/ui/Toast'
import { spacing, typography, radii } from '@/context/theme/tokens'
import { DEFAULT_MESSAGE_BOX_URL, LEGACY_MESSAGE_BOX_URL, MESSAGE_BOX_URL_KEY, NO_MESSAGE_BOX } from '@/utils/pay/rails/handle'

export function useMessageBoxConfig(t: ReturnType<typeof import('react-i18next').useTranslation>['t']) {
  const [messageBoxUrl, setMessageBoxUrl] = useState(DEFAULT_MESSAGE_BOX_URL)
  const [urlInput, setUrlInput] = useState(DEFAULT_MESSAGE_BOX_URL)
  const [isSaving, setIsSaving] = useState(false)
  const [showConfig, setShowConfig] = useState(false)

  useEffect(() => {
    AsyncStorage.getItem(MESSAGE_BOX_URL_KEY).then(saved => {
      // A preference equal to the retired default means "default", not a
      // deliberate choice of that server — follow the new default instead.
      if (saved === LEGACY_MESSAGE_BOX_URL) {
        void AsyncStorage.removeItem(MESSAGE_BOX_URL_KEY)
        return
      }
      if (saved) {
        setMessageBoxUrl(saved)
        setUrlInput(saved)
        if (saved === NO_MESSAGE_BOX) setShowConfig(true)
      }
    })
  }, [])

  const handleSave = useCallback(
    async (input: string) => {
      const trimmed = input.trim().replace(/\/+$/, '')
      if (!trimmed) {
        showToast(t('enter_valid_url'), { type: 'error' })
        return
      }
      setIsSaving(true)
      try {
        await AsyncStorage.setItem(MESSAGE_BOX_URL_KEY, trimmed)
        setMessageBoxUrl(trimmed)
        setShowConfig(false)
        showToast(t('message_box_saved'), { type: 'success' })
      } catch (error: any) {
        showToast(`Failed to save: ${error.message || 'unknown error'}`, { type: 'error' })
      } finally {
        setIsSaving(false)
      }
    },
    [t]
  )

  const handleReset = useCallback(async () => {
    await AsyncStorage.removeItem(MESSAGE_BOX_URL_KEY)
    setMessageBoxUrl(DEFAULT_MESSAGE_BOX_URL)
    setUrlInput(DEFAULT_MESSAGE_BOX_URL)
    setShowConfig(false)
    showToast(t('message_box_removed'), { type: 'success' })
  }, [t])

  const handleNone = useCallback(async () => {
    const noneValue = NO_MESSAGE_BOX
    setIsSaving(true)
    try {
      await AsyncStorage.setItem(MESSAGE_BOX_URL_KEY, noneValue)
      setMessageBoxUrl(noneValue)
      setUrlInput(noneValue)
      setShowConfig(true)
      showToast(t('message_box_removed'), { type: 'success' })
    } catch (error: any) {
      showToast(`Failed to save: ${error.message || 'unknown error'}`, { type: 'error' })
    } finally {
      setIsSaving(false)
    }
  }, [t])

  return {
    messageBoxUrl,
    urlInput,
    setUrlInput,
    isSaving,
    showConfig,
    setShowConfig,
    handleSave,
    handleReset,
    handleNone
  }
}

interface MessageBoxBarProps {
  readonly url: string
  readonly open: boolean
  readonly onToggle: () => void
  readonly colors: ReturnType<typeof import('@/context/theme/ThemeContext').useTheme>['colors']
  readonly t: ReturnType<typeof import('react-i18next').useTranslation>['t']
}

/**
 * The only way into the message-box settings, and the only place the active host
 * is shown.
 *
 * Both are load-bearing rather than decorative. The panel holds the reset and
 * the use-no-server escape hatches, so without an affordance that opens it a
 * user who saved a broken host has no route back — the panel's own auto-open
 * only fires for the explicit no-server sentinel. And the host is worth naming
 * because it decides whether a handle payment can be delivered at all.
 *
 * Kept to one quiet row: the old screen carried a header gear and a separate
 * green server chip, which is two controls for one fact.
 */
export function MessageBoxBar({ url, open, onToggle, colors, t }: MessageBoxBarProps) {
  const isNone = url === NO_MESSAGE_BOX
  return (
    <TouchableOpacity
      onPress={onToggle}
      style={[styles.bar, { borderColor: isNone ? colors.error + '40' : colors.separator }]}
      accessibilityRole="button"
      accessibilityLabel={t('message_box_server')}
      accessibilityState={{ expanded: open }}
    >
      <Ionicons
        name={isNone ? 'alert-circle' : 'checkmark-circle'}
        size={14}
        color={isNone ? colors.error : colors.success}
      />
      <Text
        style={[styles.barText, { color: isNone ? colors.error : colors.textSecondary }]}
        numberOfLines={1}
        ellipsizeMode="middle"
      >
        {isNone ? t('message_box_tap_to_configure') : url}
      </Text>
      <Ionicons name="settings-outline" size={16} color={open ? colors.accent : colors.textTertiary} />
    </TouchableOpacity>
  )
}

interface ConfigPanelProps {
  readonly urlInput: string
  readonly isSaving: boolean
  readonly colors: ReturnType<typeof import('@/context/theme/ThemeContext').useTheme>['colors']
  readonly t: ReturnType<typeof import('react-i18next').useTranslation>['t']
  readonly onChangeUrl: (v: string) => void
  readonly onSave: () => void
  readonly onReset: () => void
  readonly onNone: () => void
}

export function ConfigPanel({ urlInput, isSaving, colors, t, onChangeUrl, onSave, onReset, onNone }: ConfigPanelProps) {
  const hasUrl = !!urlInput.trim()
  const isNonDefault = urlInput.trim() !== DEFAULT_MESSAGE_BOX_URL && urlInput !== NO_MESSAGE_BOX
  return (
    <View style={[styles.configPanel, { backgroundColor: colors.backgroundSecondary }]}>
      <Text style={[styles.configTitle, { color: colors.textPrimary }]}>{t('message_box_server')}</Text>
      <Text style={[styles.configSubtitle, { color: colors.textSecondary }]}>{t('message_box_required')}</Text>
      <TextInput
        value={urlInput}
        onChangeText={onChangeUrl}
        placeholder={DEFAULT_MESSAGE_BOX_URL}
        placeholderTextColor={colors.textTertiary}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        returnKeyType="done"
        onSubmitEditing={onSave}
        style={[
          styles.urlInput,
          { color: colors.textPrimary, backgroundColor: colors.background, borderColor: colors.separator }
        ]}
      />

      {/* Primary action: Save */}
      <TouchableOpacity
        onPress={onSave}
        disabled={isSaving || !hasUrl}
        style={[
          styles.configButtonPrimary,
          { backgroundColor: hasUrl ? colors.accent : colors.backgroundSecondary, opacity: hasUrl ? 1 : 0.5 }
        ]}
      >
        {isSaving ? (
          <ActivityIndicator size="small" color={hasUrl ? colors.background : colors.textSecondary} />
        ) : (
          <Text style={[styles.configButtonTextPrimary, { color: hasUrl ? colors.background : colors.textSecondary }]}>
            {t('save')}
          </Text>
        )}
      </TouchableOpacity>

      {/* Secondary / destructive row */}
      <View style={styles.configSecondaryActions}>
        {isNonDefault && (
          <TouchableOpacity onPress={onReset} style={[styles.configResetPill, { borderColor: colors.textSecondary }]}>
            <Ionicons name="refresh" size={12} color={colors.textSecondary} />
            <Text style={[styles.configResetText, { color: colors.textSecondary }]}>Default</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          onPress={onNone}
          disabled={isSaving}
          style={[styles.configNoneLink, { opacity: isSaving ? 0.4 : 1 }]}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={[styles.configNoneText, { color: colors.error }]}>Use no server</Text>
        </TouchableOpacity>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginBottom: spacing.lg
  },
  barText: {
    ...typography.caption1,
    flex: 1
  },
  configPanel: {
    padding: spacing.lg,
    borderRadius: radii.md,
    marginBottom: spacing.xl
  },
  configTitle: {
    ...typography.headline,
    marginBottom: spacing.xs
  },
  configSubtitle: {
    ...typography.footnote,
    marginBottom: spacing.md
  },
  urlInput: {
    ...typography.body,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: spacing.md
  },
  configButtonPrimary: {
    flex: 2,
    paddingVertical: spacing.sm + 2,
    borderRadius: radii.sm,
    alignItems: 'center',
    justifyContent: 'center'
  },
  configButtonTextPrimary: {
    ...typography.subhead,
    fontWeight: '600'
  },
  // Secondary / destructive row (Reset pill + None link)
  configSecondaryActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.md
  },
  configResetPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 5,
    borderRadius: radii.sm,
    borderWidth: StyleSheet.hairlineWidth
  },
  configResetText: {
    ...typography.caption1,
    fontWeight: '500'
  },
  configNoneLink: {
    marginLeft: 'auto' as any
  },
  configNoneText: {
    ...typography.caption1,
    fontWeight: '500'
  }
})
