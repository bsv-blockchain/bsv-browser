import React, { useState, useCallback } from 'react'
import {
  Keyboard,
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
  tabCount: number
  onChangeText: (text: string) => void
  onSubmit: () => void
  onFocus: () => void
  onBlur: () => void
  onBack: () => void
  onForward: () => void
  onReloadOrStop: () => void
  onClearText: () => void
  onSuggestionPress: (url: string) => void
  onShare: () => void
  onBookmarks: () => void
  onTabs: () => void
  onSettings: () => void
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

/** Floating glass capsule — LiquidGlassView on iOS 26+, BlurChrome pill elsewhere */
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
  tabCount,
  onChangeText,
  onSubmit,
  onFocus,
  onBlur,
  onBack,
  onForward,
  onReloadOrStop,
  onClearText,
  onSuggestionPress,
  onShare,
  onBookmarks,
  onTabs,
  onSettings,
  inputRef,
}) => {
  const { colors } = useTheme()
  const [actionsExpanded, setActionsExpanded] = useState(false)

  const collapseActions = useCallback(() => setActionsExpanded(false), [])

  const handleShare = useCallback(() => { collapseActions(); onShare() }, [collapseActions, onShare])
  const handleBookmarks = useCallback(() => { collapseActions(); onBookmarks() }, [collapseActions, onBookmarks])
  const handleTabs = useCallback(() => { collapseActions(); onTabs() }, [collapseActions, onTabs])
  const handleSettings = useCallback(() => { collapseActions(); onSettings() }, [collapseActions, onSettings])

  const displayText = addressFocused ? addressText : domainFromUrl(addressText)
  const isBackDisabled = !canGoBack || isNewTab
  const isForwardDisabled = !canGoForward || isNewTab

  // --- Expanded action row replaces nav + URL pill ---
  const actionRow = (
    <View style={styles.row}>
      <GlassPill flex={1} style={styles.urlPill}>
        <View style={styles.actionButtons}>
          <TouchableOpacity onPress={handleShare} style={styles.actionBtn} activeOpacity={0.6}>
            <Ionicons name="share-outline" size={22} color={colors.accent} />
          </TouchableOpacity>
          <TouchableOpacity onPress={handleBookmarks} style={styles.actionBtn} activeOpacity={0.6}>
            <Ionicons name="book-outline" size={22} color={colors.accent} />
          </TouchableOpacity>
          <TouchableOpacity onPress={handleTabs} style={styles.actionBtn} activeOpacity={0.6}>
            <View>
              <Ionicons name="copy-outline" size={22} color={colors.accent} />
              {tabCount > 1 && (
                <View style={[styles.badge, { backgroundColor: colors.accent }]}>
                  <Text style={styles.badgeText}>{tabCount}</Text>
                </View>
              )}
            </View>
          </TouchableOpacity>
          <TouchableOpacity onPress={handleSettings} style={styles.actionBtn} activeOpacity={0.6}>
            <Ionicons name="settings-outline" size={22} color={colors.accent} />
          </TouchableOpacity>
        </View>
      </GlassPill>

      {/* Toggle button — collapses back to URL view */}
      <GlassPill style={styles.morePill}>
        <TouchableOpacity onPress={collapseActions} style={styles.moreButton} activeOpacity={0.6}>
          <Ionicons name="ellipsis-horizontal" size={20} color={colors.accent} />
        </TouchableOpacity>
      </GlassPill>
    </View>
  )

  // --- Normal URL row ---
  const urlRow = (
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
              color={isBackDisabled ? colors.textQuaternary : colors.accent}
            />
          </TouchableOpacity>
          <View style={[styles.navDivider, { backgroundColor: colors.separator }]} />
          <TouchableOpacity
            onPress={onForward}
            disabled={isForwardDisabled}
            style={styles.navButton}
            activeOpacity={0.6}
          >
            <Ionicons
              name="chevron-forward"
              size={22}
              color={isForwardDisabled ? colors.textQuaternary : colors.accent}
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
            },
          ]}
          placeholder="Search or enter website"
          placeholderTextColor={colors.textTertiary}
          selectTextOnFocus
        />
        {addressFocused ? (
          <TouchableOpacity onPress={onClearText} style={styles.inputAction}>
            <Ionicons name="close-circle" size={18} color={colors.textTertiary} />
          </TouchableOpacity>
        ) : isLoading ? (
          <TouchableOpacity onPress={onReloadOrStop} style={styles.inputAction}>
            <Ionicons name="close" size={18} color={colors.textSecondary} />
          </TouchableOpacity>
        ) : !isNewTab ? (
          <TouchableOpacity onPress={onReloadOrStop} style={styles.inputAction}>
            <Ionicons name="refresh" size={16} color={colors.textSecondary} />
          </TouchableOpacity>
        ) : null}
      </GlassPill>

      {/* More toggle / Cancel */}
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
        <GlassPill style={styles.morePill}>
          <TouchableOpacity
            onPress={() => setActionsExpanded(true)}
            style={styles.moreButton}
            activeOpacity={0.6}
          >
            <Ionicons name="ellipsis-horizontal" size={20} color={colors.accent} />
          </TouchableOpacity>
        </GlassPill>
      )}
    </View>
  )

  return (
    <View style={styles.container}>
      {actionsExpanded && !addressFocused ? actionRow : urlRow}

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
    zIndex: 10,
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
  cancelButton: {
    paddingHorizontal: spacing.md,
    height: 44,
    justifyContent: 'center',
  },
  cancelText: {
    ...typography.body,
  },
  actionButtons: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
  },
  actionBtn: {
    flex: 1,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    top: -4,
    right: -6,
    minWidth: 14,
    height: 14,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 2,
  },
  badgeText: {
    color: '#fff',
    fontSize: 9,
    fontWeight: '700',
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
