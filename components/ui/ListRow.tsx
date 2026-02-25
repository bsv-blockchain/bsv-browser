import React from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, typography } from '@/context/theme/tokens'

interface ListRowProps {
  label: string
  value?: string
  icon?: keyof typeof Ionicons.glyphMap
  iconColor?: string
  onPress?: () => void
  showChevron?: boolean
  destructive?: boolean
  trailing?: React.ReactNode
  isLast?: boolean
}

/**
 * Standard row for iOS-style grouped lists.
 * Shows icon (optional), label, value/trailing, and chevron.
 */
export const ListRow: React.FC<ListRowProps> = ({
  label,
  value,
  icon,
  iconColor,
  onPress,
  showChevron = true,
  destructive = false,
  trailing,
  isLast = false
}) => {
  const { colors } = useTheme()

  const content = (
    <View style={[styles.container, !isLast && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator }]}>
      {icon && (
        <View style={[styles.iconContainer, { backgroundColor: iconColor || colors.accent }]}>
          <Ionicons name={icon} size={18} color="#FFFFFF" />
        </View>
      )}
      <Text
        style={[
          styles.label,
          { color: destructive ? colors.error : colors.textPrimary }
        ]}
        numberOfLines={1}
      >
        {label}
      </Text>
      <View style={styles.trailing}>
        {trailing}
        {value && !trailing && (
          <Text style={[styles.value, { color: colors.textSecondary }]} numberOfLines={1}>
            {value}
          </Text>
        )}
        {showChevron && onPress && !destructive && (
          <Ionicons
            name="chevron-forward"
            size={18}
            color={colors.textQuaternary}
            style={styles.chevron}
          />
        )}
      </View>
    </View>
  )

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        style={({ pressed }) => pressed && { opacity: 0.6 }}
        accessibilityRole="button"
      >
        {content}
      </Pressable>
    )
  }

  return content
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  iconContainer: {
    width: 28,
    height: 28,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.md,
  },
  label: {
    ...typography.body,
    flex: 1,
  },
  trailing: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
    marginLeft: spacing.sm,
  },
  value: {
    ...typography.body,
    maxWidth: 200,
  },
  chevron: {
    marginLeft: spacing.xs,
  },
})
