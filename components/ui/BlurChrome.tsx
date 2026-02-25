import React from 'react'
import { StyleSheet, View, Platform } from 'react-native'
import { BlurView } from 'expo-blur'
import { useTheme } from '@/context/theme/ThemeContext'
import { radii } from '@/context/theme/tokens'

interface BlurChromeProps {
  children: React.ReactNode
  intensity?: number
  borderRadius?: number
  style?: any
}

/**
 * Translucent toolbar/chrome wrapper using expo-blur.
 * Falls back to a solid semi-transparent background on Android
 * where BlurView performance can be inconsistent.
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

  // Android fallback: solid semi-transparent background
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
