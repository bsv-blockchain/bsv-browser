/**
 * The recipient field for the handle rail: a search box that resolves names,
 * accepts a pasted identity key, opens the scanner, and collapses to an
 * identity card once a counterparty is chosen.
 *
 * Copied verbatim out of app/payments.tsx so both handle cells present the
 * recipient the same way.
 */
import React from 'react'
import { ActivityIndicator, Image, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import type { DisplayableIdentity } from '@bsv/sdk'
import Animated, { FadeInDown, useReducedMotion } from 'react-native-reanimated'
import { spacing, typography, radii } from '@/context/theme/tokens'
import { springs } from '@/context/theme/motion'

interface RecipientFieldProps {
  readonly selectedIdentity: DisplayableIdentity | null
  readonly searchQuery: string
  readonly recipientKey: string
  readonly isSearching: boolean
  readonly searchResults: DisplayableIdentity[]
  readonly colors: ReturnType<typeof import('@/context/theme/ThemeContext').useTheme>['colors']
  readonly t: ReturnType<typeof import('react-i18next').useTranslation>['t']
  readonly onSearchChange: (v: string) => void
  readonly onSelectIdentity: (i: DisplayableIdentity) => void
  readonly onClear: () => void
  readonly onOpenScanner: () => void
}

export default function RecipientField({
  selectedIdentity,
  searchQuery,
  recipientKey,
  isSearching,
  searchResults,
  colors,
  t,
  onSearchChange,
  onSelectIdentity,
  onClear,
  onOpenScanner
}: RecipientFieldProps) {
  const reducedMotion = useReducedMotion()
  if (selectedIdentity) {
    const identityEntering = reducedMotion
      ? undefined
      : FadeInDown.springify().stiffness(springs.snappy.stiffness).damping(springs.snappy.damping)
    return (
      <Animated.View
        entering={identityEntering}
        style={[styles.selectedRecipient, { backgroundColor: colors.backgroundSecondary }]}
      >
        {selectedIdentity.avatarURL ? (
          <Image source={{ uri: selectedIdentity.avatarURL }} style={styles.avatar} />
        ) : (
          <View style={[styles.avatarPlaceholder, { backgroundColor: colors.accent }]}>
            <Ionicons name="person" size={20} color={colors.background} />
          </View>
        )}
        <View style={styles.selectedInfo}>
          <Text style={[styles.selectedName, { color: colors.textPrimary }]} numberOfLines={1}>
            {selectedIdentity.name || t('unknown')}
          </Text>
          <Text style={[styles.selectedKey, { color: colors.textSecondary }]} numberOfLines={1}>
            {selectedIdentity.abbreviatedKey || `${selectedIdentity.identityKey.slice(0, 10)}...`}
          </Text>
        </View>
        <TouchableOpacity onPress={onClear} style={styles.clearButton}>
          <Ionicons name="close-circle" size={20} color={colors.textTertiary} />
        </TouchableOpacity>
      </Animated.View>
    )
  }
  const showDropdown = (isSearching || searchResults.length > 0) && !recipientKey
  return (
    <>
      <View
        style={[
          styles.inputRow,
          {
            backgroundColor: colors.backgroundSecondary,
            borderColor: recipientKey ? colors.success : colors.separator,
            borderWidth: recipientKey ? 1 : StyleSheet.hairlineWidth
          }
        ]}
      >
        <TextInput
          value={searchQuery}
          onChangeText={onSearchChange}
          placeholder={t('search_name_or_key')}
          placeholderTextColor={colors.textTertiary}
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.recipientInput, { color: colors.textPrimary }]}
        />
        <TouchableOpacity onPress={onOpenScanner} style={styles.inputAction} accessibilityLabel="Scan QR code">
          <Ionicons name="qr-code-outline" size={20} color={colors.accent} />
        </TouchableOpacity>
      </View>
      {!!recipientKey && (
        <View style={styles.directKeyRow}>
          <Ionicons name="key-outline" size={14} color={colors.success} />
          <Text style={[styles.directKeyText, { color: colors.success }]}>{t('valid_identity_key')}</Text>
        </View>
      )}
      {showDropdown && (
        <View
          style={[styles.searchResults, { backgroundColor: colors.backgroundSecondary, borderColor: colors.separator }]}
        >
          {isSearching ? (
            <View style={styles.searchLoading}>
              <ActivityIndicator size="small" color={colors.accent} />
              <Text style={[styles.searchLoadingText, { color: colors.textSecondary }]}>{t('searching')}</Text>
            </View>
          ) : (
            searchResults.map((identity, idx) => (
              <TouchableOpacity
                key={identity.identityKey + idx}
                onPress={() => onSelectIdentity(identity)}
                style={[
                  styles.searchResultRow,
                  idx < searchResults.length - 1 && {
                    borderBottomWidth: StyleSheet.hairlineWidth,
                    borderBottomColor: colors.separator
                  }
                ]}
              >
                {identity.avatarURL ? (
                  <Image source={{ uri: identity.avatarURL }} style={styles.searchAvatar} />
                ) : (
                  <View style={[styles.searchAvatarPlaceholder, { backgroundColor: colors.accent }]}>
                    <Ionicons name="person" size={18} color={colors.background} />
                  </View>
                )}
                <View style={styles.searchResultInfo}>
                  <Text style={[styles.searchResultName, { color: colors.textPrimary }]} numberOfLines={1}>
                    {identity.name || t('unknown')}
                  </Text>
                  <Text style={[styles.searchResultKey, { color: colors.textSecondary }]} numberOfLines={1}>
                    {identity.abbreviatedKey || `${identity.identityKey.slice(0, 20)}...`}
                  </Text>
                </View>
                {identity.badgeLabel ? (
                  <View style={[styles.badge, { backgroundColor: colors.accent + '20' }]}>
                    <Text style={[styles.badgeText, { color: colors.accent }]}>{identity.badgeLabel}</Text>
                  </View>
                ) : null}
              </TouchableOpacity>
            ))
          )}
        </View>
      )}
    </>
  )
}

const styles = StyleSheet.create({
  // Selected recipient
  selectedRecipient: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md,
    borderRadius: radii.md
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18
  },
  avatarPlaceholder: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center'
  },
  selectedInfo: {
    flex: 1,
    marginLeft: spacing.md
  },
  selectedName: {
    ...typography.subhead,
    fontWeight: '600'
  },
  selectedKey: {
    ...typography.caption1,
    fontFamily: 'monospace'
  },
  clearButton: {
    padding: spacing.xs
  },

  // Direct key
  directKeyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.sm
  },
  directKeyText: {
    ...typography.caption1,
    fontWeight: '500'
  },

  // Search results
  searchResults: {
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: spacing.sm,
    overflow: 'hidden'
  },
  searchLoading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.md,
    gap: spacing.sm
  },
  searchLoadingText: {
    ...typography.subhead
  },
  searchResultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md
  },
  searchAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    marginRight: spacing.md
  },
  searchAvatarPlaceholder: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.md
  },
  searchResultInfo: {
    flex: 1
  },
  searchResultName: {
    ...typography.subhead,
    fontWeight: '500'
  },
  searchResultKey: {
    ...typography.caption1,
    fontFamily: 'monospace'
  },
  badge: {
    paddingHorizontal: spacing.xs,
    paddingVertical: 1,
    borderRadius: 3,
    marginLeft: spacing.sm,
    flexShrink: 1
  },
  badgeText: {
    ...typography.caption2,
    fontWeight: '600',
    fontSize: 10
  },

  // Recipient input row (text field + QR scan button)
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden'
  },
  recipientInput: {
    ...typography.body,
    flex: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md
  },
  inputAction: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center'
  }
})
