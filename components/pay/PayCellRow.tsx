/**
 * One row of the counterparty picker. A row, not a grid tile: six tiles on one
 * screen is a worse maze than three menu rows, and the row form keeps one
 * focal element per line — the title — with the transport hint demoted to a
 * subtitle where transport names are allowed to live.
 */
import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import PressableScale from '@/components/ui/PressableScale'
import { useTheme } from '@/context/theme/ThemeContext'
import { radii, spacing, typography } from '@/context/theme/tokens'

export interface PayCellRowProps {
  title: string
  subtitle: string
  icon: keyof typeof Ionicons.glyphMap
  onPress: () => void
  /** Dimmed and unpressable — used for rails that need internet. */
  disabled?: boolean
}

export default function PayCellRow({ title, subtitle, icon, onPress, disabled = false }: PayCellRowProps) {
  const { colors } = useTheme()
  return (
    <PressableScale
      onPress={disabled ? () => {} : onPress}
      haptic={disabled ? undefined : 'tap'}
      scaleTo={disabled ? 1 : 0.98}
      disabled={disabled}
      style={[
        styles.row,
        { backgroundColor: colors.backgroundElevated, borderColor: colors.separator },
        disabled && styles.disabled
      ]}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      accessibilityLabel={`${title}. ${subtitle}`}
    >
      <View
        style={[
          styles.iconWrap,
          { backgroundColor: colors.surfaceSunken, borderColor: colors.surfaceSunkenBorder }
        ]}
      >
        <Ionicons name={icon} size={20} color={colors.textSecondary} />
      </View>
      <View style={styles.text}>
        <Text style={[styles.title, { color: colors.textPrimary }]} numberOfLines={1}>
          {title}
        </Text>
        <Text style={[styles.subtitle, { color: colors.textSecondary }]} numberOfLines={2}>
          {subtitle}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.textQuaternary} />
    </PressableScale>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth
  },
  // Rounded square, not a circle: every glyph well in this system is a squircle
  // of the same family, and a lone circle here reads as a different component.
  iconWrap: {
    width: 40,
    height: 40,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center'
  },
  disabled: { opacity: 0.4 },
  text: { flex: 1 },
  title: { ...typography.headline, fontWeight: '600' },
  subtitle: { ...typography.footnote }
})
