import React, { useMemo } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
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

interface DeduplicatedEntry {
  url: string
  title: string
  /** The original index in the history array (for navigateToHistoryIndex). */
  originalIndex: number
  isCurrent: boolean
}

/**
 * Floating glass popover anchored to the bottom-left (or top-left) of the screen,
 * listing the navigation history for the active tab.
 *
 * Items are de-duplicated by URL (keeping the entry closest to the current index)
 * and displayed with title + domain.
 */
export const HistoryPopover: React.FC<HistoryPopoverProps> = ({
  entries,
  currentIndex,
  bottomOffset,
  addressBarAtTop = false,
  topOffset = 0,
  onDismiss,
  onSelectEntry
}) => {
  const { isDark, colors } = useTheme()

  /** De-duplicate entries by URL, keeping the one closest to currentIndex. */
  const items: DeduplicatedEntry[] = useMemo(() => {
    const seen = new Map<string, DeduplicatedEntry>()

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      const existing = seen.get(entry.url)

      if (!existing) {
        seen.set(entry.url, {
          url: entry.url,
          title: entry.title,
          originalIndex: i,
          isCurrent: i === currentIndex
        })
      } else {
        // Keep the entry closest to currentIndex
        if (Math.abs(i - currentIndex) < Math.abs(existing.originalIndex - currentIndex)) {
          seen.set(entry.url, {
            url: entry.url,
            title: entry.title,
            originalIndex: i,
            isCurrent: i === currentIndex
          })
        }
        // If either is the current, mark it
        if (i === currentIndex) {
          const e = seen.get(entry.url)!
          e.isCurrent = true
          e.originalIndex = i
        }
      }
    }

    // Return in reverse chronological order (most recent first)
    return Array.from(seen.values()).sort((a, b) => b.originalIndex - a.originalIndex)
  }, [entries, currentIndex])

  const dismiss = (fn: () => void) => () => {
    onDismiss()
    fn()
  }

  const cardContent = (
    <View style={styles.card}>
      <ScrollView style={styles.scrollView} bounces={false} showsVerticalScrollIndicator={false}>
        {items.map((item, idx) => {
          const domain = domainFromUrl(item.url)
          const isNewTab = item.url === 'about:blank' || item.url.includes('new-tab')
          const displayTitle = isNewTab ? 'New Tab' : item.title || domain || item.url

          return (
            <React.Fragment key={`${item.url}-${item.originalIndex}`}>
              {idx > 0 && <View style={[styles.divider, { backgroundColor: colors.separator }]} />}
              <TouchableOpacity
                style={styles.row}
                onPress={dismiss(() => onSelectEntry(item.originalIndex))}
                activeOpacity={0.6}
              >
                {item.isCurrent && (
                  <Ionicons name="checkmark" size={16} color={colors.accent} style={styles.checkIcon} />
                )}
                <View style={[styles.rowContent, !item.isCurrent && styles.rowContentNoCheck]}>
                  <Text
                    style={[styles.rowTitle, { color: colors.textPrimary }, item.isCurrent && styles.rowTitleCurrent]}
                    numberOfLines={1}
                    ellipsizeMode="tail"
                  >
                    {displayTitle}
                  </Text>
                  {domain && !isNewTab ? (
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
  checkIcon: {
    width: 22,
    marginRight: spacing.sm
  },
  rowContent: {
    flex: 1,
    minWidth: 0
  },
  rowContentNoCheck: {
    marginLeft: 22 + spacing.sm // Indent to align with rows that have checkmarks
  },
  rowTitle: {
    ...typography.subhead
  },
  rowTitleCurrent: {
    fontWeight: '600'
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
