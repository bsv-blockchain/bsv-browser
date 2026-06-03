import React from 'react'
import { Keyboard, Platform, StyleSheet, TextInput, TouchableOpacity, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useTranslation } from 'react-i18next'
import { spacing, typography } from '@/context/theme/tokens'
import { GlassPill, useGlassColors, PILL_RADIUS } from '@/components/browser/GlassPill'

interface AddressBarProps {
  addressText: string
  addressFocused: boolean
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  isNewTab: boolean
  isHttps: boolean
  historyPopoverOpen: boolean
  onChangeText: (text: string) => void
  onSubmit: () => void
  onFocus: () => void
  onBlur: () => void
  onBack: () => void
  onBackLongPress: () => void
  onForward: () => void
  onForwardLongPress: () => void
  onReloadOrStop: () => void
  onClearText: () => void
  onCancelNewTab?: () => void
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

const AddressBarImpl: React.FC<AddressBarProps> = ({
  addressText,
  addressFocused,
  isLoading,
  canGoBack,
  canGoForward,
  isNewTab,
  isHttps,
  historyPopoverOpen,
  onChangeText,
  onSubmit,
  onFocus,
  onBlur,
  onBack,
  onBackLongPress,
  onForward,
  onForwardLongPress,
  onReloadOrStop,
  onClearText,
  onCancelNewTab,
  inputRef
}) => {
  const { t } = useTranslation()
  const gc = useGlassColors()

  const displayText = addressFocused ? addressText : domainFromUrl(addressText)
  const isBackDisabled = !canGoBack || isNewTab
  // Show both back and forward buttons whenever forward navigation is available.
  // This replaces the single back button so the user can recover forward after going back.
  const showDualNav = canGoForward && !isNewTab

  return (
    <View style={styles.container}>
      <View style={styles.row}>
        {/* Nav button(s) — hidden while editing */}
        {!addressFocused && !historyPopoverOpen && (
          <GlassPill style={showDualNav ? styles.navPillDual : styles.navPill}>
            {/* Back button */}
            <TouchableOpacity
              onPress={isBackDisabled ? undefined : onBack}
              onLongPress={isBackDisabled ? undefined : onBackLongPress}
              delayLongPress={350}
              style={styles.navButton}
              activeOpacity={0.6}
            >
              <Ionicons
                name="chevron-back"
                size={22}
                color={isBackDisabled ? gc.quaternary : gc.accent}
              />
            </TouchableOpacity>

            {/* Divider + forward button — only when forward history is available */}
            {showDualNav && (
              <>
                <View style={[styles.navDivider, { backgroundColor: gc.separator }]} />
                <TouchableOpacity
                  onPress={onForward}
                  onLongPress={onForwardLongPress}
                  delayLongPress={350}
                  style={styles.navButton}
                  activeOpacity={0.6}
                >
                  <Ionicons name="chevron-forward" size={22} color={gc.accent} />
                </TouchableOpacity>
              </>
            )}
          </GlassPill>
        )}
        {/* Placeholder so the URL pill doesn't reflow when history popover opens */}
        {!addressFocused && historyPopoverOpen && (
          <View style={showDualNav ? styles.navPlaceholderDual : styles.navPlaceholder} />
        )}

        {/* URL pill */}
        <GlassPill flex={1} style={styles.urlPill}>
          {!addressFocused && isHttps && !isNewTab && (
            <Ionicons
              name="lock-closed"
              size={12}
              color={gc.secondary}
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
            keyboardType={Platform.select({ ios: 'web-search', default: 'url' })}
            returnKeyType="go"
            style={[
              styles.urlInput,
              {
                color: gc.primary,
                textAlign: addressFocused ? 'left' : 'center'
              }
            ]}
            placeholder={t('search_or_enter_website')}
            placeholderTextColor={gc.tertiary}
            selectTextOnFocus
          />
          {addressFocused ? (
            <TouchableOpacity onPress={onClearText} style={styles.inputAction}>
              <Ionicons name="close-circle" size={18} color={gc.tertiary} />
            </TouchableOpacity>
          ) : isLoading ? (
            <TouchableOpacity onPress={onReloadOrStop} style={styles.inputAction}>
              <Ionicons name="close" size={18} color={gc.secondary} />
            </TouchableOpacity>
          ) : !isNewTab ? (
            <TouchableOpacity onPress={onReloadOrStop} style={styles.inputAction}>
              <Ionicons name="refresh" size={16} color={gc.secondary} />
            </TouchableOpacity>
          ) : null}
        </GlassPill>

        {/* Rightmost slot.
            - When editing: an in-bar close pill (cancel new tab / blur input).
            - Otherwise: a transparent 44px placeholder so the URL pill leaves
              space for the always-present kebab (rendered by the parent as a
              sibling overlay — it lives OUTSIDE the collapsing bar wrapper so
              it stays visible during the right-swipe collapse). */}
        {addressFocused ? (
          <GlassPill style={styles.morePill}>
            <TouchableOpacity
              onPress={() => {
                if (onCancelNewTab) {
                  onCancelNewTab()
                } else {
                  inputRef.current?.blur()
                  Keyboard.dismiss()
                }
              }}
              style={styles.moreButton}
              activeOpacity={0.6}
            >
              <Ionicons name="close" size={20} color={gc.accent} />
            </TouchableOpacity>
          </GlassPill>
        ) : (
          <View style={styles.morePlaceholder} />
        )}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    // No background — fully transparent, pills float over content
    paddingHorizontal: spacing.md,
    paddingTop: spacing.xs
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  pill: {
    overflow: 'hidden',
    minHeight: 44,
    borderRadius: PILL_RADIUS
  },
  navPill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    width: 44
  },
  navPillDual: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    width: 88
  },
  navButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center'
  },
  navDivider: {
    width: StyleSheet.hairlineWidth,
    height: 22,
    opacity: 0.6
  },
  navPlaceholder: {
    width: 44
  },
  navPlaceholderDual: {
    width: 88
  },
  urlPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs
  },
  lockIcon: {
    marginRight: spacing.xs
  },
  urlInput: {
    flex: 1,
    fontSize: typography.subhead.fontSize,
    fontWeight: typography.subhead.fontWeight,
    // No explicit lineHeight — lets iOS scale it correctly with Dynamic Type
    paddingVertical: 0
  },
  inputAction: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center'
  },
  morePill: {
    width: 44,
    alignItems: 'center',
    justifyContent: 'center'
  },
  moreButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center'
  },
  morePlaceholder: {
    width: 44
  },
  cancelButton: {
    paddingHorizontal: spacing.md,
    height: 44,
    justifyContent: 'center'
  },
  cancelText: {
    ...typography.body
  }
})

/**
 * Memoized: with stable (useCallback'd) handler props from the Browser, the
 * address bar — including its expensive LiquidGlass pill — skips reconciliation
 * on Browser re-renders that don't change its own inputs (chrome animation
 * state, unrelated context churn). It still updates on addressText / focus /
 * isLoading / canGoBack changes, which are its real inputs.
 */
export const AddressBar = React.memo(AddressBarImpl)
