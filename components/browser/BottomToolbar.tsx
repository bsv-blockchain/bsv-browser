import React, { useState, useCallback } from 'react'
import { StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '@/context/theme/ThemeContext'
import { BlurChrome } from '@/components/ui/BlurChrome'
import { IconButton } from '@/components/ui/IconButton'
import { spacing } from '@/context/theme/tokens'

let LiquidGlassView: React.ComponentType<any> | null = null
let isLiquidGlassSupported = false
try {
  const lg = require('@callstack/liquid-glass')
  LiquidGlassView = lg.LiquidGlassView
  isLiquidGlassSupported = lg.isLiquidGlassSupported ?? false
} catch {}

const PILL_RADIUS = 26

interface BottomToolbarProps {
  onShare: () => void
  onBookmarks: () => void
  onTabs: () => void
  onSettings: () => void
  tabCount: number
  shareDisabled?: boolean
}

/**
 * Collapsed glass pill showing only ⋯.
 * Tap ⋯ to expand and reveal Share / Bookmarks / Tabs / Settings.
 * Tapping any action button collapses the pill and performs the action.
 */
export const BottomToolbar: React.FC<BottomToolbarProps> = ({
  onShare,
  onBookmarks,
  onTabs,
  onSettings,
  tabCount,
  shareDisabled = false,
}) => {
  const { colors, isDark } = useTheme()
  const insets = useSafeAreaInsets()
  const [expanded, setExpanded] = useState(false)

  const collapse = useCallback(() => setExpanded(false), [])

  const handleShare = useCallback(() => {
    collapse()
    onShare()
  }, [collapse, onShare])

  const handleBookmarks = useCallback(() => {
    collapse()
    onBookmarks()
  }, [collapse, onBookmarks])

  const handleTabs = useCallback(() => {
    collapse()
    onTabs()
  }, [collapse, onTabs])

  const handleSettings = useCallback(() => {
    collapse()
    onSettings()
  }, [collapse, onSettings])

  const pillContent = expanded ? (
    <View style={styles.pillRow}>
      <IconButton
        name="share-outline"
        onPress={handleShare}
        size={22}
        color={shareDisabled ? colors.textQuaternary : colors.accent}
        disabled={shareDisabled}
        accessibilityLabel="Share"
      />
      <IconButton
        name="book-outline"
        onPress={handleBookmarks}
        size={22}
        color={colors.accent}
        accessibilityLabel="Bookmarks"
      />
      <IconButton
        name="copy-outline"
        onPress={handleTabs}
        size={22}
        color={colors.accent}
        badge={tabCount > 1 ? tabCount : undefined}
        accessibilityLabel={`${tabCount} tabs`}
      />
      <IconButton
        name="settings-outline"
        onPress={handleSettings}
        size={22}
        color={colors.accent}
        accessibilityLabel="Settings"
      />
    </View>
  ) : (
    <View style={styles.pillRowCollapsed}>
      <IconButton
        name="ellipsis-horizontal"
        onPress={() => setExpanded(true)}
        size={22}
        color={colors.accent}
        accessibilityLabel="More"
      />
    </View>
  )

  const glassStyle: any[] = [
    styles.pill,
    { borderRadius: PILL_RADIUS },
    !isLiquidGlassSupported && {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.08)',
    },
  ]

  return (
    <View style={[styles.container, { paddingBottom: insets.bottom + spacing.xs }]}>
      {isLiquidGlassSupported && LiquidGlassView ? (
        <LiquidGlassView
          effect="regular"
          colorScheme={isDark ? 'dark' : 'light'}
          style={[glassStyle, { borderRadius: PILL_RADIUS }]}
        >
          {pillContent}
        </LiquidGlassView>
      ) : (
        <BlurChrome intensity={85} borderRadius={PILL_RADIUS} style={glassStyle}>
          {pillContent}
        </BlurChrome>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    paddingTop: spacing.xs,
    paddingHorizontal: spacing.xl,
  },
  pill: {
    overflow: 'hidden',
  },
  pillRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    gap: spacing.xl,
  },
  pillRowCollapsed: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
})
