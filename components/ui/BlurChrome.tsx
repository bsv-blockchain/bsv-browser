import React from 'react'
import { StyleSheet, View, Platform } from 'react-native'
import { BlurView } from 'expo-blur'
import { useTheme } from '@/context/theme/ThemeContext'

interface BlurChromeProps {
  children: React.ReactNode
  intensity?: number
  borderRadius?: number
  style?: any
}

/**
 * Translucent wrapper using expo-blur on iOS, solid fallback on Android.
 * Used for toolbar chrome and floating glass pill fallbacks.
 */
export const BlurChrome: React.FC<BlurChromeProps> = ({
  children,
  intensity = 80,
  borderRadius = 0,
  style
}) => {
  const { isDark, colors } = useTheme()

  if (Platform.OS === 'ios') {
    return (
      <BlurView
        intensity={intensity}
        tint={isDark ? 'dark' : 'light'}
        style={[styles.container, { borderRadius }, style]}
      >
        {children}
      </BlurView>
    )
  }

  return (
    <View
      style={[
        styles.container,
        { borderRadius, backgroundColor: colors.chromeBackground },
        style
      ]}
    >
      {children}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
  },
})
