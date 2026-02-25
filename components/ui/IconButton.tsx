import React from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from '@/context/theme/ThemeContext'
import { hitTargets } from '@/context/theme/tokens'

interface IconButtonProps {
  name: keyof typeof Ionicons.glyphMap
  onPress: () => void
  onLongPress?: () => void
  size?: number
  color?: string
  disabled?: boolean
  badge?: number | string
  accessibilityLabel?: string
}

/**
 * Minimal icon button with proper 44pt hit target (iOS HIG).
 * Supports an optional numeric badge overlay.
 */
export const IconButton: React.FC<IconButtonProps> = ({
  name,
  onPress,
  onLongPress,
  size = 22,
  color,
  disabled = false,
  badge,
  accessibilityLabel
}) => {
  const { colors } = useTheme()
  const iconColor = color ?? colors.accent

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.container,
        pressed && styles.pressed,
        disabled && styles.disabled
      ]}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      hitSlop={4}
    >
      <Ionicons name={name} size={size} color={iconColor} />
      {badge !== undefined && (
        <View style={[styles.badge, { backgroundColor: colors.accent }]}>
          <Text style={styles.badgeText}>
            {typeof badge === 'number' && badge > 99 ? '99+' : badge}
          </Text>
        </View>
      )}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  container: {
    width: hitTargets.minimum,
    height: hitTargets.minimum,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: {
    opacity: 0.5,
  },
  disabled: {
    opacity: 0.3,
  },
  badge: {
    position: 'absolute',
    top: 4,
    right: 4,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  badgeText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '700',
  },
})
