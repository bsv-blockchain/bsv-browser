import React, { createContext, useContext } from 'react'
import { useColorScheme } from 'react-native'
import {
  lightColors as tokenLightColors,
  darkColors as tokenDarkColors
} from './tokens'

// Theme type definitions
export type ThemeMode = 'light' | 'dark' | 'system'

export interface ThemeColors {
  // Accent
  accent: string
  accentSecondary: string

  // Backgrounds
  background: string
  backgroundSecondary: string
  backgroundTertiary: string
  backgroundElevated: string

  // Translucent chrome
  chromeBackground: string
  chromeBackgroundBlur: string
  sheetBackground: string

  // Text
  textPrimary: string
  textSecondary: string
  textTertiary: string
  textQuaternary: string
  textOnAccent: string

  // Separators
  separator: string
  separatorOpaque: string

  // Fills
  fill: string
  fillSecondary: string
  fillTertiary: string

  // Status
  success: string
  error: string
  warning: string
  info: string

  // Permission approval
  permissionProtocol: string
  permissionBasket: string
  permissionIdentity: string
  permissionSpending: string

  // --- Legacy aliases (for gradual migration) ---
  primary: string
  secondary: string
  paperBackground: string
  buttonBackground: string
  buttonText: string
  buttonBackgroundDisabled: string
  buttonTextDisabled: string
  inputBackground: string
  inputBorder: string
  inputText: string
  protocolApproval: string
  basketApproval: string
  identityApproval: string
  renewalApproval: string
}

export interface ThemeContextType {
  mode: ThemeMode
  setThemeMode: (mode: ThemeMode) => void
  colors: ThemeColors
  isDark: boolean
}

// Build full color objects that include both new tokens and legacy aliases
const lightColors: ThemeColors = {
  // New tokens
  ...tokenLightColors,

  // Legacy aliases → mapped to new tokens
  primary: tokenLightColors.accent,
  secondary: tokenLightColors.accentSecondary,
  paperBackground: tokenLightColors.backgroundSecondary,
  buttonBackground: tokenLightColors.accent,
  buttonText: tokenLightColors.textOnAccent,
  buttonBackgroundDisabled: 'rgba(0, 0, 0, 0.12)',
  buttonTextDisabled: 'rgba(0, 0, 0, 0.26)',
  inputBackground: tokenLightColors.background,
  inputBorder: tokenLightColors.separatorOpaque,
  inputText: tokenLightColors.textPrimary,
  protocolApproval: tokenLightColors.permissionProtocol,
  basketApproval: tokenLightColors.permissionBasket,
  identityApproval: tokenLightColors.permissionIdentity,
  renewalApproval: tokenLightColors.accentSecondary,
}

const darkColors: ThemeColors = {
  // New tokens
  ...tokenDarkColors,

  // Legacy aliases → mapped to new tokens
  primary: tokenDarkColors.accent,
  secondary: tokenDarkColors.accentSecondary,
  paperBackground: tokenDarkColors.backgroundSecondary,
  buttonBackground: tokenDarkColors.accent,
  buttonText: tokenDarkColors.textOnAccent,
  buttonBackgroundDisabled: 'rgba(255, 255, 255, 0.12)',
  buttonTextDisabled: 'rgba(255, 255, 255, 0.3)',
  inputBackground: tokenDarkColors.backgroundTertiary,
  inputBorder: tokenDarkColors.separatorOpaque,
  inputText: tokenDarkColors.textPrimary,
  protocolApproval: tokenDarkColors.permissionProtocol,
  basketApproval: tokenDarkColors.permissionBasket,
  identityApproval: tokenDarkColors.permissionIdentity,
  renewalApproval: tokenDarkColors.accentSecondary,
}

// Create the context with default values
export const ThemeContext = createContext<ThemeContextType>({
  mode: 'system',
  setThemeMode: () => {},
  colors: lightColors,
  isDark: false
})

export const useTheme = () => useContext(ThemeContext)

interface ThemeProviderProps {
  children: React.ReactNode
}

export const ThemeProvider: React.FC<ThemeProviderProps> = ({ children }) => {
  // Always follow the device's appearance setting — no manual override.
  const colorScheme = useColorScheme()
  const isDark = colorScheme === 'dark'
  const colors = isDark ? darkColors : lightColors

  return (
    <ThemeContext.Provider
      value={{
        mode: 'system',
        setThemeMode: () => {},
        colors,
        isDark,
      }}
    >
      {children}
    </ThemeContext.Provider>
  )
}
