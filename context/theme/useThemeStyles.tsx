import { StyleSheet } from 'react-native'
import { useTheme } from './ThemeContext'
import { spacing, radii, typography } from './tokens'

// This hook creates commonly used styles based on the current theme
export const useThemeStyles = () => {
  const { colors } = useTheme()

  return StyleSheet.create({
    // Container styles
    container: {
      flex: 1,
      backgroundColor: colors.background
    },
    contentContainer: {
      flex: 1,
      padding: spacing.xl,
      justifyContent: 'center',
      alignItems: 'center'
    },
    card: {
      backgroundColor: colors.backgroundElevated,
      borderRadius: radii.lg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.separator,
      padding: spacing.lg,
      marginVertical: spacing.sm
    },

    // Text styles
    title: {
      ...typography.title1,
      color: colors.textPrimary,
      marginBottom: spacing.md,
      textAlign: 'center'
    },
    subtitle: {
      ...typography.callout,
      color: colors.textSecondary,
      marginBottom: spacing.xxxl,
      textAlign: 'center'
    },
    text: {
      ...typography.body,
      color: colors.textPrimary
    },
    textSecondary: {
      ...typography.subhead,
      color: colors.textSecondary
    },

    // Button styles
    button: {
      backgroundColor: colors.accent,
      paddingVertical: spacing.lg,
      paddingHorizontal: spacing.xxxl,
      borderRadius: radii.md,
      width: '100%',
      alignItems: 'center',
      marginBottom: spacing.xl
    },
    buttonText: {
      ...typography.headline,
      color: colors.textOnAccent
    },
    buttonDisabled: {
      backgroundColor: colors.buttonBackgroundDisabled
    },
    buttonTextDisabled: {
      color: colors.buttonTextDisabled
    },
    // Secondary button styles (transparent with border)
    buttonSecondary: {
      backgroundColor: 'transparent',
      paddingVertical: 13,
      paddingHorizontal: 38,
      borderRadius: radii.md,
      width: '100%',
      alignItems: 'center',
      marginBottom: spacing.xl,
      borderWidth: 2,
      borderColor: colors.accent
    },
    buttonSecondaryText: {
      ...typography.headline,
      color: colors.textPrimary
    },
    buttonSecondaryDisabled: {
      borderColor: colors.buttonBackgroundDisabled
    },

    // Input styles
    inputContainer: {
      width: '100%',
      marginBottom: spacing.xxxl
    },
    input: {
      flexDirection: 'row',
      width: '100%',
      height: 50,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.separator,
      borderRadius: radii.md,
      backgroundColor: colors.fillTertiary,
      marginBottom: spacing.lg,
      alignItems: 'center'
    },
    inputText: {
      flex: 1,
      ...typography.body,
      paddingHorizontal: spacing.lg,
      color: colors.textPrimary
    },
    inputLabel: {
      ...typography.subhead,
      color: colors.textSecondary,
      marginBottom: spacing.xs
    },

    // Icon styles
    icon: {
      padding: spacing.md,
      color: colors.textSecondary
    },

    // Validation styles
    validationError: {
      ...typography.caption1,
      color: colors.error,
      marginBottom: spacing.lg,
      marginTop: -spacing.md
    },

    // Link styles
    link: {
      color: colors.accent,
      fontWeight: '500'
    },

    // Other common styles
    row: {
      flexDirection: 'row',
      alignItems: 'center'
    },
    center: {
      justifyContent: 'center',
      alignItems: 'center'
    },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: colors.separator,
      width: '100%',
      marginVertical: spacing.lg
    }
  })
}
