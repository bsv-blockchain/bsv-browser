import React, { useMemo } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { BlurChrome } from '@/components/ui/BlurChrome'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, radii, typography } from '@/context/theme/tokens'

let LiquidGlassView: React.ComponentType<any> | null = null
let isLiquidGlassSupported = false
try {
  const lg = require('@callstack/liquid-glass')
  LiquidGlassView = lg.LiquidGlassView
  isLiquidGlassSupported = lg.isLiquidGlassSupported ?? false
} catch {}

interface HistoryPopoverProps {
  entries: { url: string; title: string }[]
  currentIndex: number
  /** Which side of the history stack to show. */
  direction: 'back' | 'forward'
  bottomOffset: number
  addressBarAtTop?: boolean
  topOffset?: number
  onDismiss: () => void
  onSelectEntry: (index: number) => void
}

/** Extract the domain from a URL for display as secondary text. */
function domainFromUrl(url: string): string {
  try {
    if (!url || url === 'about:blank') return ''
    const { hostname } = new URL(url)
    return hostname
  } catch {
    return url
  }
}

/** Is this a new-tab sentinel entry? */
function isNewTabEntry(url: string): boolean {
  return url === 'about:blank' || url.includes('new-tab')
}

interface HistoryItem {
  url: string
  title: string
  /** The original index in the full history array (for navigateToHistoryIndex). */
  originalIndex: number
}

/**
 * Floating glass popover anchored to the bottom-left (or top-left) of the screen,
 * listing the back or forward navigation history for the active tab.
 *
 * - Long hold on Back  → shows pages *before* the current position (most recent first).
 * - Long hold on Forward → shows pages *after* the current position (nearest first).
 *
 * The current page is never included. Consecutive exact-URL duplicates are collapsed.
 */
export const HistoryPopover: React.FC<HistoryPopoverProps> = ({
  entries,
  currentIndex,
  direction,
  bottomOffset,
  addressBarAtTop = false,
  topOffset = 0,
  onDismiss,
  onSelectEntry
}) => {
  const { isDark, colors } = useTheme()

  const items: HistoryItem[] = useMemo(() => {
    const result: HistoryItem[] = []
    let prevUrl: string | null = null

    if (direction === 'back') {
      // Walk backwards from one before current to the start.
      // Result order: closest-to-current first (most recent back entry at top).
      for (let i = currentIndex - 1; i >= 0; i--) {
        const entry = entries[i]
        if (isNewTabEntry(entry.url)) continue
        if (entry.url === prevUrl) continue
        prevUrl = entry.url
        result.push({ url: entry.url, title: entry.title, originalIndex: i })
      }
    } else {
      // Walk forwards from one after current to the end.
      // Result order: closest-to-current first (next forward entry at top).
      for (let i = currentIndex + 1; i < entries.length; i++) {
        const entry = entries[i]
        if (isNewTabEntry(entry.url)) continue
        if (entry.url === prevUrl) continue
        prevUrl = entry.url
        result.push({ url: entry.url, title: entry.title, originalIndex: i })
      }
    }

    return result
  }, [entries, currentIndex, direction])

  const dismiss = (fn: () => void) => () => {
    onDismiss()
    fn()
  }

  const cardContent = (
    <View style={styles.card}>
      <ScrollView style={styles.scrollView} bounces={false} showsVerticalScrollIndicator={false}>
        {items.map((item, idx) => {
          const domain = domainFromUrl(item.url)
          const displayTitle = item.title || domain || item.url

          return (
            <React.Fragment key={`${item.url}-${item.originalIndex}`}>
              {idx > 0 && <View style={[styles.divider, { backgroundColor: colors.separator }]} />}
              <TouchableOpacity
                style={styles.row}
                onPress={dismiss(() => onSelectEntry(item.originalIndex))}
                activeOpacity={0.6}
              >
                <View style={styles.rowContent}>
                  <Text style={[styles.rowTitle, { color: colors.textPrimary }]} numberOfLines={1} ellipsizeMode="tail">
                    {displayTitle}
                  </Text>
                  {domain ? (
                    <Text
                      style={[styles.rowDomain, { color: colors.textSecondary }]}
                      numberOfLines={1}
                      ellipsizeMode="middle"
                    >
                      {domain}
                    </Text>
                  ) : null}
                </View>
              </TouchableOpacity>
            </React.Fragment>
          )
        })}
      </ScrollView>
    </View>
  )

  return (
    <View style={styles.overlay} pointerEvents="box-none">
      {/* Invisible backdrop to dismiss on outside tap */}
      <Pressable style={StyleSheet.absoluteFill} onPress={onDismiss} />

      {/* Popover card anchored bottom-left or top-left */}
      <View
        style={[styles.anchor, addressBarAtTop ? { top: topOffset } : { bottom: bottomOffset }]}
        pointerEvents="box-none"
      >
        {isLiquidGlassSupported && LiquidGlassView ? (
          <LiquidGlassView
            effect="regular"
            colorScheme={isDark ? 'dark' : 'light'}
            style={[styles.glassCard, { borderRadius: radii.xl }]}
          >
            {cardContent}
          </LiquidGlassView>
        ) : (
          <BlurChrome
            intensity={66}
            borderRadius={radii.xl}
            style={[
              styles.glassCard,
              {
                borderRadius: radii.xl,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.08)',
                shadowColor: '#000',
                shadowOffset: { width: 0, height: 8 },
                shadowOpacity: isDark ? 0.5 : 0.18,
                shadowRadius: 24,
                elevation: 16
              }
            ]}
          >
            {cardContent}
          </BlurChrome>
        )}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 50
  },
  anchor: {
    position: 'absolute',
    left: spacing.md,
    width: 280,
    alignItems: 'flex-start'
  },
  glassCard: {
    width: 260,
    overflow: 'hidden'
  },
  card: {
    paddingVertical: spacing.xs
  },
  scrollView: {
    maxHeight: 360
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md
  },
  rowContent: {
    flex: 1,
    minWidth: 0
  },
  rowTitle: {
    ...typography.subhead
  },
  rowDomain: {
    ...typography.caption1,
    marginTop: 1
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginHorizontal: spacing.lg
  }
})
