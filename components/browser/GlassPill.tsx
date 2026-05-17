import React from 'react'
import { PlatformColor, StyleSheet, View, ViewStyle, StyleProp } from 'react-native'
import { useTheme } from '@/context/theme/ThemeContext'
import { BlurChrome } from '@/components/ui/BlurChrome'

let LiquidGlassView: React.ComponentType<any> | null = null
let isLiquidGlassSupported = false
try {
  const lg = require('@callstack/liquid-glass')
  LiquidGlassView = lg.LiquidGlassView
  isLiquidGlassSupported = lg.isLiquidGlassSupported ?? false
} catch {}

export const PILL_RADIUS = 22

interface GlassPillProps {
  style?: StyleProp<ViewStyle>
  children: React.ReactNode
  flex?: number
}

export const GlassPill: React.FC<GlassPillProps> = ({ style, children, flex }) => {
  const { isDark } = useTheme()
  const pillStyle: StyleProp<ViewStyle> = [styles.pill, flex !== undefined && { flex }, style]
  const border = {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.08)'
  }

  if (isLiquidGlassSupported && LiquidGlassView) {
    return (
      <LiquidGlassView
        effect="regular"
        colorScheme={isDark ? 'dark' : 'light'}
        style={[pillStyle, { borderRadius: PILL_RADIUS }]}
      >
        {children}
      </LiquidGlassView>
    )
  }

  return (
    <BlurChrome intensity={85} borderRadius={PILL_RADIUS} style={[pillStyle, { borderRadius: PILL_RADIUS }, border]}>
      {children}
    </BlurChrome>
  )
}

export const useGlassColors = () => {
  const { colors } = useTheme()
  const gc = isLiquidGlassSupported
    ? {
        accent: PlatformColor('labelColor'),
        primary: PlatformColor('labelColor'),
        secondary: PlatformColor('secondaryLabelColor'),
        tertiary: PlatformColor('tertiaryLabelColor'),
        quaternary: PlatformColor('quaternaryLabelColor'),
        separator: PlatformColor('separatorColor')
      }
    : null

  return {
    accent: gc?.accent ?? colors.accent,
    primary: gc?.primary ?? colors.textPrimary,
    secondary: gc?.secondary ?? colors.textSecondary,
    tertiary: gc?.tertiary ?? colors.textTertiary,
    quaternary: gc?.quaternary ?? colors.textQuaternary,
    separator: gc?.separator ?? colors.separator
  }
}

export { isLiquidGlassSupported }

const styles = StyleSheet.create({
  pill: {
    overflow: 'hidden',
    minHeight: 44,
    borderRadius: PILL_RADIUS
  }
})
