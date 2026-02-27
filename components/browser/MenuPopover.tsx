import React from 'react'
import {
  Linking,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { BlurChrome } from '@/components/ui/BlurChrome'
import { useTheme } from '@/context/theme/ThemeContext'
import { useBrowserMode } from '@/context/BrowserModeContext'
import { useSheet } from '@/context/SheetContext'
import { spacing, radii, typography } from '@/context/theme/tokens'

let LiquidGlassView: React.ComponentType<any> | null = null
let isLiquidGlassSupported = false
try {
  const lg = require('@callstack/liquid-glass')
  LiquidGlassView = lg.LiquidGlassView
  isLiquidGlassSupported = lg.isLiquidGlassSupported ?? false
} catch {}

interface MenuPopoverProps {
  isNewTab: boolean
  canShare: boolean
  bottomOffset: number
  addressBarAtTop?: boolean
  topOffset?: number
  onDismiss: () => void
  onShare: () => void
  onAddBookmark: () => void
  onBookmarks: () => void
  onTabs: () => void
  onNewTab: () => void
  onSettings: () => void
  onTrust: () => void
  onEnableWeb3: () => void
}

interface RowProps {
  icon: string
  label: string
  onPress: () => void
  destructive?: boolean
}

const Row: React.FC<RowProps> = ({ icon, label, onPress, destructive }) => {
  const { colors } = useTheme()
  return (
    <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.6}>
      <Ionicons
        name={icon as any}
        size={22}
        color={destructive ? colors.error : colors.textPrimary}
        style={styles.rowIcon}
      />
      <Text style={[styles.rowLabel, { color: destructive ? colors.error : colors.textPrimary }]}>
        {label}
      </Text>
    </TouchableOpacity>
  )
}

const Divider: React.FC = () => {
  const { colors } = useTheme()
  return <View style={[styles.divider, { backgroundColor: colors.separator }]} />
}

/**
 * Floating glass popover anchored to the bottom-right of the screen,
 * replacing the ... button while open.
 */
export const MenuPopover: React.FC<MenuPopoverProps> = ({
  isNewTab,
  canShare,
  bottomOffset,
  addressBarAtTop = false,
  topOffset = 0,
  onDismiss,
  onShare,
  onAddBookmark,
  onBookmarks,
  onTabs,
  onNewTab,
  onSettings,
  onTrust,
  onEnableWeb3,
}) => {
  const { isDark, colors } = useTheme()
  const { isWeb2Mode } = useBrowserMode()

  const dismiss = (fn: () => void) => () => { onDismiss(); fn() }

  const cardContent = (
    <View style={styles.card}>
      {/* Actions group */}
      {!isNewTab && canShare && (
        <Row icon="share-outline" label="Share" onPress={dismiss(onShare)} />
      )}
      {!isNewTab && (
        <Row icon="bookmark-outline" label="Add Bookmark" onPress={dismiss(onAddBookmark)} />
      )}
      <Row icon="globe-outline" label="Browser" onPress={dismiss(onBookmarks)} />

      <Divider />

      {/* Web3 / Settings group */}
      <Row icon="bug-outline" label="Bug Report" onPress={dismiss(() => Linking.openURL('https://github.com/bsv-blockchain/bsv-browser/issues'))} />
      {isWeb2Mode ? (
        <Row icon="flash-outline" label="Enable Web3" onPress={dismiss(onEnableWeb3)} />
      ) : (
        <>
          <Row icon="wallet-outline" label="Wallet" onPress={dismiss(onSettings)} />
          <Row icon="shield-checkmark-outline" label="Trust Network" onPress={dismiss(onTrust)} />
        </>
      )}

      <Divider />
      
      {/* Tabs — split row */}
      <View style={styles.splitRow}>
        <TouchableOpacity style={styles.splitRowMain} onPress={dismiss(onTabs)} activeOpacity={0.6}>
          <Ionicons name="copy-outline" size={22} color={colors.textPrimary} style={styles.rowIcon} />
          <Text style={[styles.rowLabel, { color: colors.textPrimary }]}>Tabs</Text>
        </TouchableOpacity>
        <View style={[styles.splitDivider, { backgroundColor: colors.separator }]} />
        <TouchableOpacity style={styles.splitRowAction} onPress={dismiss(onNewTab)} activeOpacity={0.6}>
          <Ionicons name="add" size={24} color={colors.textPrimary} />
        </TouchableOpacity>
      </View>
    </View>
  )

  return (
    <View style={styles.overlay} pointerEvents="box-none">
      {/* Invisible backdrop to dismiss on outside tap */}
      <Pressable style={StyleSheet.absoluteFill} onPress={onDismiss} />

      {/* Popover card anchored bottom-right or top-right based on AddressBar position */}
      <View style={[
        styles.anchor,
        addressBarAtTop ? { top: topOffset } : { bottom: bottomOffset }
      ]} pointerEvents="box-none">
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
                elevation: 16,
              },
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
    zIndex: 50,
  },
  anchor: {
    position: 'absolute',
    right: spacing.md,
    width: 280,
    alignItems: 'flex-end',
  },
  glassCard: {
    width: 222,
    overflow: 'hidden',
  },
  card: {
    paddingVertical: spacing.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md + 2,
  },
  rowIcon: {
    width: 28,
    marginRight: spacing.md,
  },
  rowLabel: {
    ...typography.body,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginHorizontal: spacing.lg,
    marginVertical: spacing.xs,
  },
  splitRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  splitRowMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md + 2,
  },
  splitDivider: {
    width: StyleSheet.hairlineWidth,
    alignSelf: 'stretch',
    marginVertical: spacing.xs,
  },
  splitRowAction: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md + 2,
    justifyContent: 'center',
    alignItems: 'center',
  },
})
