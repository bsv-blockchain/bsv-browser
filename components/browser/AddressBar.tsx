import React, { useCallback, useRef, useEffect, useState } from 'react'
import {
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from '@/context/theme/ThemeContext'
import { BlurChrome } from '@/components/ui/BlurChrome'
import { spacing, radii, typography } from '@/context/theme/tokens'
import type { HistoryEntry, Bookmark } from '@/shared/types/browser'

interface AddressBarProps {
  addressText: string
  addressFocused: boolean
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  isNewTab: boolean
  isHttps: boolean
  suggestions: (HistoryEntry | Bookmark)[]
  onChangeText: (text: string) => void
  onSubmit: () => void
  onFocus: () => void
  onBlur: () => void
  onBack: () => void
  onForward: () => void
  onReloadOrStop: () => void
  onClearText: () => void
  onSuggestionPress: (url: string) => void
  onMorePress: () => void
  inputRef: React.RefObject<TextInput | null>
}

const kNEW_TAB_URL = 'about:blank'

function domainFromUrl(url: string): string {
  try {
    if (url === kNEW_TAB_URL || !url) return ''
    const { hostname } = new URL(url)
    return hostname
  } catch {
    return url
  }
}

export const AddressBar: React.FC<AddressBarProps> = ({
  addressText,
  addressFocused,
  isLoading,
  canGoBack,
  canGoForward,
  isNewTab,
  isHttps,
  suggestions,
  onChangeText,
  onSubmit,
  onFocus,
  onBlur,
  onBack,
  onForward,
  onReloadOrStop,
  onClearText,
  onSuggestionPress,
  onMorePress,
  inputRef
}) => {
  const { colors } = useTheme()

  const displayText = addressFocused
    ? addressText
    : domainFromUrl(addressText)

  const isBackDisabled = !canGoBack || isNewTab
  const isForwardDisabled = !canGoForward || isNewTab

  return (
    <BlurChrome style={styles.container}>
      <View style={[styles.barRow, { borderColor: colors.separator }]}>
        {/* Back / Forward - only shown when not editing */}
        {!addressFocused && (
          <View style={styles.navButtons}>
            <TouchableOpacity
              onPress={onBack}
              disabled={isBackDisabled}
              style={styles.navButton}
              activeOpacity={0.6}
            >
              <Ionicons
                name="chevron-back"
                size={24}
                color={isBackDisabled ? colors.textQuaternary : colors.accent}
              />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={onForward}
              disabled={isForwardDisabled}
              style={styles.navButton}
              activeOpacity={0.6}
            >
              <Ionicons
                name="chevron-forward"
                size={24}
                color={isForwardDisabled ? colors.textQuaternary : colors.accent}
              />
            </TouchableOpacity>
          </View>
        )}

        {/* URL field */}
        <View style={[styles.urlField, { backgroundColor: colors.fillTertiary }]}>
          {!addressFocused && isHttps && !isNewTab && (
            <Ionicons
              name="lock-closed"
              size={12}
              color={colors.textSecondary}
              style={styles.lockIcon}
            />
          )}
          <TextInput
            ref={inputRef}
            editable
            value={displayText === 'new-tab-page' ? '' : displayText}
            onChangeText={onChangeText}
            onFocus={onFocus}
            onBlur={onBlur}
            onSubmitEditing={onSubmit}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="go"
            style={[
              styles.urlInput,
              {
                color: colors.textPrimary,
                textAlign: addressFocused ? 'left' : 'center',
              }
            ]}
            placeholder="Search or enter website"
            placeholderTextColor={colors.textTertiary}
            selectTextOnFocus
          />
          {addressFocused ? (
            <TouchableOpacity onPress={onClearText} style={styles.actionButton}>
              <Ionicons name="close-circle" size={18} color={colors.textTertiary} />
            </TouchableOpacity>
          ) : isLoading ? (
            <TouchableOpacity onPress={onReloadOrStop} style={styles.actionButton}>
              <Ionicons name="close" size={18} color={colors.textSecondary} />
            </TouchableOpacity>
          ) : !isNewTab ? (
            <TouchableOpacity onPress={onReloadOrStop} style={styles.actionButton}>
              <Ionicons name="refresh" size={16} color={colors.textSecondary} />
            </TouchableOpacity>
          ) : null}
        </View>

        {/* More / Cancel */}
        {addressFocused ? (
          <TouchableOpacity
            onPress={() => {
              inputRef.current?.blur()
              Keyboard.dismiss()
            }}
            style={styles.cancelButton}
          >
            <Text style={[styles.cancelText, { color: colors.accent }]}>Cancel</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity onPress={onMorePress} style={styles.moreButton}>
            <Ionicons name="ellipsis-horizontal" size={20} color={colors.accent} />
          </TouchableOpacity>
        )}
      </View>

      {/* Suggestions dropdown */}
      {addressFocused && suggestions.length > 0 && (
        <View style={[styles.suggestions, { backgroundColor: colors.backgroundElevated }]}>
          {suggestions.map((entry, i) => (
            <TouchableOpacity
              key={`suggestion-${i}-${entry.url}`}
              onPress={() => onSuggestionPress(entry.url)}
              style={[
                styles.suggestionItem,
                i < suggestions.length - 1 && {
                  borderBottomWidth: StyleSheet.hairlineWidth,
                  borderBottomColor: colors.separator
                }
              ]}
            >
              <Text
                numberOfLines={1}
                style={[styles.suggestionTitle, { color: colors.textPrimary }]}
              >
                {entry.title}
              </Text>
              <Text
                numberOfLines={1}
                style={[styles.suggestionUrl, { color: colors.textSecondary }]}
              >
                {entry.url}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </BlurChrome>
  )
}

const styles = StyleSheet.create({
  container: {
    zIndex: 10,
  },
  barRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
  navButtons: {
    flexDirection: 'row',
    marginRight: spacing.xs,
  },
  navButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  urlField: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    height: 36,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
  },
  lockIcon: {
    marginRight: spacing.xs,
  },
  urlInput: {
    flex: 1,
    ...typography.subhead,
    paddingVertical: 0,
  },
  actionButton: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelButton: {
    paddingHorizontal: spacing.md,
    height: 36,
    justifyContent: 'center',
  },
  cancelText: {
    ...typography.body,
  },
  moreButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: spacing.xs,
  },
  suggestions: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(0,0,0,0.1)',
  },
  suggestionItem: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  suggestionTitle: {
    ...typography.subhead,
  },
  suggestionUrl: {
    ...typography.caption1,
    marginTop: 2,
  },
})
