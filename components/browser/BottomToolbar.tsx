import React, { useCallback } from 'react'
import { StyleSheet, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '@/context/theme/ThemeContext'
import { BlurChrome } from '@/components/ui/BlurChrome'
import { IconButton } from '@/components/ui/IconButton'
import { spacing } from '@/context/theme/tokens'

interface BottomToolbarProps {
  onShare: () => void
  onBookmarks: () => void
  onTabs: () => void
  onMenu?: () => void
  tabCount: number
  shareDisabled?: boolean
}

/**
 * Safari-style 4-button bottom toolbar.
 * Sits below the address bar, above the safe area.
 */
export const BottomToolbar: React.FC<BottomToolbarProps> = ({
  onShare,
  onBookmarks,
  onTabs,
  onMenu,
  tabCount,
  shareDisabled = false,
}) => {
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()

  return (
    <BlurChrome
      style={[
        styles.container,
        {
          paddingBottom: insets.bottom,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: colors.separator,
        }
      ]}
    >
      <View style={styles.row}>
        <IconButton
          name="share-outline"
          onPress={onShare}
          size={22}
          color={shareDisabled ? colors.textQuaternary : colors.accent}
          disabled={shareDisabled}
          accessibilityLabel="Share"
        />
        <IconButton
          name="book-outline"
          onPress={onBookmarks}
          size={22}
          color={colors.accent}
          accessibilityLabel="Bookmarks"
        />
        <IconButton
          name="copy-outline"
          onPress={onTabs}
          size={22}
          color={colors.accent}
          badge={tabCount > 1 ? tabCount : undefined}
          accessibilityLabel={`${tabCount} tabs`}
        />
      </View>
    </BlurChrome>
  )
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingVertical: spacing.xs,
  },
})
