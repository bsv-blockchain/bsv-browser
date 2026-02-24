import React, { useEffect } from 'react'
import { View, ActivityIndicator } from 'react-native'
import { router } from 'expo-router'
import { useTheme } from '@/context/theme/ThemeContext'

// Config screen now auto-redirects to mnemonic onboarding.
// In local-only mode, config is auto-applied on first launch.
// This screen exists as a passthrough for navigation compatibility.
const ConfigScreen = () => {
  const { colors } = useTheme()

  useEffect(() => {
    // Redirect straight to mnemonic onboarding
    router.replace('/auth/mnemonic')
  }, [])

  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.background }}>
      <ActivityIndicator size="large" color={colors.primary} />
    </View>
  )
}

export default ConfigScreen
