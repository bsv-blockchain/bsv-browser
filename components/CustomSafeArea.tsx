import React from 'react'
import { View, Platform, StyleSheet, StyleProp, ViewStyle } from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '@/context/theme/ThemeContext'

interface CustomSafeAreaProps {
  children: React.ReactNode
  style?: StyleProp<ViewStyle>
  minTopInset?: number // Customizable minimum top inset
  minBottomInset?: number // Customizable minimum bottom inset
  edges?: ('top' | 'right' | 'bottom' | 'left')[]
}

/**
 * Custom SafeAreaView that respects a minimum top inset for Android devices
 * to properly handle camera notches and provides consistent behavior across platforms.
 */
export default function CustomSafeArea({
  children,
  style,
  minTopInset = 30, // Default minimum top inset for Android
  edges
}: CustomSafeAreaProps) {
  const insets = useSafeAreaInsets()
  const { colors } = useTheme()

  // Apply minimum insets only on Android
  const appliedTopInset = Platform.OS === 'android' ? Math.max(insets.top, minTopInset) : insets.top

  // If edges are specified, use SafeAreaView with edges
  if (edges) {
    return (
      <SafeAreaView style={[{ backgroundColor: colors.background }, style]} edges={edges}>
        {children}
      </SafeAreaView>
    )
  }

  // Otherwise use View with manual padding
  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: colors.background,
          paddingTop: appliedTopInset,
          // paddingBottom: appliedBottomInset,
          paddingLeft: insets.left,
          paddingRight: insets.right
        },
        style
      ]}
    >
      {children}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1
  }
})
