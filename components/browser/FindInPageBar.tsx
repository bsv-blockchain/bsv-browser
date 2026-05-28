import React, { useEffect, useRef } from 'react'
import { StyleSheet, TextInput, Text, TouchableOpacity, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useTranslation } from 'react-i18next'
import { useTheme } from '@/context/theme/ThemeContext'
import { BlurChrome } from '@/components/ui/BlurChrome'
import { spacing, radii, typography } from '@/context/theme/tokens'

let LiquidGlassView: React.ComponentType<any> | null = null
let isLiquidGlassSupported = false
try {
  const lg = require('@callstack/liquid-glass')
  LiquidGlassView = lg.LiquidGlassView
  isLiquidGlassSupported = lg.isLiquidGlassSupported ?? false
} catch {}

interface FindInPageBarProps {
  query: string
  currentMatch: number
  totalMatches: number
  capped?: boolean
  onChangeQuery: (text: string) => void
  onNext: () => void
  onPrevious: () => void
  onClose: () => void
}

export const FindInPageBar: React.FC<FindInPageBarProps> = ({
  query,
  currentMatch,
  totalMatches,
  capped,
  onChangeQuery,
  onNext,
  onPrevious,
  onClose
}) => {
  const { t } = useTranslation()
  const { isDark, colors } = useTheme()
  const inputRef = useRef<TextInput>(null)

  useEffect(() => {
    // Auto-focus the input when the bar appears
    const timer = setTimeout(() => inputRef.current?.focus(), 100)
    return () => clearTimeout(timer)
  }, [])

  const hasQuery = query.length > 0
  const hasMatches = totalMatches > 0

  const totalLabel = capped ? `${totalMatches}+` : String(totalMatches)
  const matchLabel = hasQuery
    ? hasMatches
      ? t('find_in_page_matches', { current: currentMatch, total: totalLabel })
      : t('find_in_page_no_matches')
    : ''

  const content = (
    <View style={styles.bar}>
      <View style={[styles.inputContainer, { backgroundColor: colors.fillTertiary }]}>
        <Ionicons name="search" size={16} color={colors.textTertiary} style={styles.searchIcon} />
        <TextInput
          ref={inputRef}
          value={query}
          onChangeText={onChangeQuery}
          placeholder={t('find_in_page_placeholder')}
          placeholderTextColor={colors.textTertiary}
          style={[styles.input, { color: colors.textPrimary }]}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          onSubmitEditing={onNext}
        />
        {hasQuery && <Text style={[styles.matchLabel, { color: colors.textSecondary }]}>{matchLabel}</Text>}
      </View>

      <TouchableOpacity onPress={onPrevious} disabled={!hasMatches} style={styles.navButton} activeOpacity={0.6}>
        <Ionicons name="chevron-up" size={22} color={hasMatches ? colors.accent : colors.textQuaternary} />
      </TouchableOpacity>

      <TouchableOpacity onPress={onNext} disabled={!hasMatches} style={styles.navButton} activeOpacity={0.6}>
        <Ionicons name="chevron-down" size={22} color={hasMatches ? colors.accent : colors.textQuaternary} />
      </TouchableOpacity>

      <TouchableOpacity onPress={onClose} style={styles.navButton} activeOpacity={0.6}>
        <Ionicons name="close" size={22} color={colors.accent} />
      </TouchableOpacity>
    </View>
  )

  if (isLiquidGlassSupported && LiquidGlassView) {
    return (
      <View style={styles.container}>
        <LiquidGlassView
          effect="regular"
          colorScheme={isDark ? 'dark' : 'light'}
          style={[styles.glass, { borderRadius: radii.lg }]}
        >
          {content}
        </LiquidGlassView>
      </View>
    )
  }

  return (
    <View style={styles.container}>
      <BlurChrome
        intensity={66}
        borderRadius={radii.lg}
        style={[
          styles.glass,
          {
            borderRadius: radii.lg,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.08)',
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 4 },
            shadowOpacity: isDark ? 0.4 : 0.12,
            shadowRadius: 12,
            elevation: 8
          }
        ]}
      >
        {content}
      </BlurChrome>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 30,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.xs
  },
  glass: {
    overflow: 'hidden'
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    gap: spacing.xs
  },
  inputContainer: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    height: 32
  },
  searchIcon: {
    marginRight: spacing.xs
  },
  input: {
    flex: 1,
    fontSize: typography.subhead.fontSize,
    fontWeight: typography.subhead.fontWeight,
    paddingVertical: 0
  },
  matchLabel: {
    ...typography.caption1,
    marginLeft: spacing.xs,
    flexShrink: 0
  },
  navButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center'
  }
})
