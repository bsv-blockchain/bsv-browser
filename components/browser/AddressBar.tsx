import React from 'react'
import {
  Keyboard,
  PlatformColor,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from '@/context/theme/ThemeContext'
import { BlurChrome } from '@/components/ui/BlurChrome'
import { spacing, radii, typography } from '@/context/theme/tokens'
import type { HistoryEntry, Bookmark } from '@/shared/types/browser'

let LiquidGlassView: React.ComponentType<any> | null = null
let isLiquidGlassSupported = false
try {
  const lg = require('@callstack/liquid-glass')
  LiquidGlassView = lg.LiquidGlassView
  isLiquidGlassSupported = lg.isLiquidGlassSupported ?? false
} catch {}

const PILL_RADIUS = 22

interface AddressBarProps {
  addressText: string
  addressFocused: boolean
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  isNewTab: boolean
  isHttps: boolean
  suggestions: (HistoryEntry | Bookmark)[]
  menuOpen: boolean
  onMorePress: () => void
  onChangeText: (text: string) => void
  onSubmit: () => void
  onFocus: () => void
  onBlur: () => void
  onBack: () => void
  onForward: () => void
  onReloadOrStop: () => void
  onClearText: () => void
  onSuggestionPress: (url: string) => void
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

/** Floating glass capsule */
const GlassPill: React.FC<{ style?: any; children: React.ReactNode; flex?: number }> = ({
  style,
  children,
  flex,
}) => {
  const { isDark } = useTheme()
  const pillStyle = [styles.pill, flex !== undefined && { flex }, style]
  const border = {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.08)',
  }

  if (isLiquidGlassSupported && LiquidGlassView) {
    return (
      <LiquidGlassView
        effect="regular"
        colorScheme={isDark ? 'dark' : 'light'}
        style={[pillStyle, { borderRadius: PILL_RADIUS }]}
      >
        {children}
      </LiquidGlassView>
    )
  }

  return (
    <BlurChrome
      intensity={85}
      borderRadius={PILL_RADIUS}
      style={[pillStyle, { borderRadius: PILL_RADIUS }, border]}
    >
      {children}
    </BlurChrome>
  )
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
  menuOpen,
  onMorePress,
  onChangeText,
  onSubmit,
  onFocus,
  onBlur,
  onBack,
  onForward,
  onReloadOrStop,
  onClearText,
  onSuggestionPress,
  inputRef,
}) => {
  const { colors } = useTheme()

  // Inside LiquidGlassView, iOS semantic colors get vibrant treatment —
  // the system auto-adjusts them for contrast against whatever is behind the glass.
  // Hardcoded hex colors do NOT get this treatment, so we swap them out.
  const gc = isLiquidGlassSupported ? {
    accent: PlatformColor('labelColor'),
    primary: PlatformColor('labelColor'),
    secondary: PlatformColor('secondaryLabelColor'),
    tertiary: PlatformColor('tertiaryLabelColor'),
    quaternary: PlatformColor('quaternaryLabelColor'),
    separator: PlatformColor('separatorColor'),
  } : null

  const displayText = addressFocused ? addressText : domainFromUrl(addressText)
  const isBackDisabled = !canGoBack || isNewTab
  const isForwardDisabled = !canGoForward || isNewTab

  return (
    <View style={styles.container}>
      <View style={styles.row}>
        {/* Back / Forward — hidden while editing */}
        {!addressFocused && (
          <GlassPill style={styles.navPill}>
            <TouchableOpacity
              onPress={onBack}
              disabled={isBackDisabled}
              style={styles.navButton}
              activeOpacity={0.6}
            >
              <Ionicons
                name="chevron-back"
                size={22}
                color={isBackDisabled ? (gc?.quaternary ?? colors.textQuaternary) : (gc?.accent ?? colors.accent)}
              />
            </TouchableOpacity>
            <View style={[styles.navDivider, { backgroundColor: gc?.separator ?? colors.separator }]} />
            <TouchableOpacity
              onPress={onForward}
              disabled={isForwardDisabled}
              style={styles.navButton}
              activeOpacity={0.6}
            >
              <Ionicons
                name="chevron-forward"
                size={22}
                color={isForwardDisabled ? (gc?.quaternary ?? colors.textQuaternary) : (gc?.accent ?? colors.accent)}
              />
            </TouchableOpacity>
          </GlassPill>
        )}

        {/* URL pill */}
        <GlassPill flex={1} style={styles.urlPill}>
          {!addressFocused && isHttps && !isNewTab && (
            <Ionicons
              name="lock-closed"
              size={12}
              color={gc?.secondary ?? colors.textSecondary}
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
                color: gc?.primary ?? colors.textPrimary,
                textAlign: addressFocused ? 'left' : 'center',
              },
            ]}
            placeholder="Search or enter website"
            placeholderTextColor={gc?.tertiary ?? colors.textTertiary}
            selectTextOnFocus
          />
          {addressFocused ? (
            <TouchableOpacity onPress={onClearText} style={styles.inputAction}>
              <Ionicons name="close-circle" size={18} color={gc?.tertiary ?? colors.textTertiary} />
            </TouchableOpacity>
          ) : isLoading ? (
            <TouchableOpacity onPress={onReloadOrStop} style={styles.inputAction}>
              <Ionicons name="close" size={18} color={gc?.secondary ?? colors.textSecondary} />
            </TouchableOpacity>
          ) : !isNewTab ? (
            <TouchableOpacity onPress={onReloadOrStop} style={styles.inputAction}>
              <Ionicons name="refresh" size={16} color={gc?.secondary ?? colors.textSecondary} />
            </TouchableOpacity>
          ) : null}
        </GlassPill>

        {/* More button — hidden when popover is open (popover renders in its place) or when editing */}
        {addressFocused ? (
          <GlassPill style={styles.morePill}>
            <TouchableOpacity onPress={() => {
              inputRef.current?.blur()
              Keyboard.dismiss()
            }} style={styles.moreButton} activeOpacity={0.6}>
              <Ionicons name="close" size={20} color={gc?.accent ?? colors.accent} />
            </TouchableOpacity>
          </GlassPill>
        ) : !menuOpen ? (
          <GlassPill style={styles.morePill}>
            <TouchableOpacity onPress={onMorePress} style={styles.moreButton} activeOpacity={0.6}>
              <Ionicons name="ellipsis-horizontal" size={20} color={gc?.accent ?? colors.accent} />
            </TouchableOpacity>
          </GlassPill>
        ) : (
          /* Placeholder so the URL pill doesn't reflow when popover opens */
          <View style={styles.morePlaceholder} />
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
                  borderBottomColor: colors.separator,
                },
              ]}
            >
              <Text numberOfLines={1} style={[styles.suggestionTitle, { color: colors.textPrimary }]}>
                {entry.title}
              </Text>
              <Text numberOfLines={1} style={[styles.suggestionUrl, { color: colors.textSecondary }]}>
                {entry.url}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    // No background — fully transparent, pills float over content
    paddingHorizontal: spacing.md,
    paddingTop: spacing.xs,
    paddingBottom: spacing.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  pill: {
    overflow: 'hidden',
    height: 44,
    borderRadius: PILL_RADIUS,
  },
  navPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.xs,
    width: 88,
  },
  navButton: {
    flex: 1,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  navDivider: {
    width: StyleSheet.hairlineWidth,
    height: 20,
  },
  urlPill: {
    flexDirection: 'row',
    alignItems: 'center',
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
  inputAction: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  morePill: {
    width: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  moreButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  morePlaceholder: {
    width: 44,
  },
  cancelButton: {
    paddingHorizontal: spacing.md,
    height: 44,
    justifyContent: 'center',
  },
  cancelText: {
    ...typography.body,
  },
  suggestions: {
    marginTop: spacing.xs,
    borderRadius: radii.lg,
    overflow: 'hidden',
  },
  suggestionItem: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  suggestionTitle: {
    ...typography.subhead,
  },
  suggestionUrl: {
    ...typography.footnote,
    marginTop: 2,
  },
})
