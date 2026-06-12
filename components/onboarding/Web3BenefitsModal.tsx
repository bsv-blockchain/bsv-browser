import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useTheme } from '@/context/theme/ThemeContext'
import { radii, spacing, typography } from '@/context/theme/tokens'
import Sheet from '@/components/ui/Sheet'
import PressableScale from '@/components/ui/PressableScale'

interface Web3BenefitsModalProps {
  visible: boolean
  onDismiss: () => void
  onContinueWithoutLogin: () => void
  onGoToLogin: () => void
}

const Web3BenefitsModal: React.FC<Web3BenefitsModalProps> = ({
  visible,
  onDismiss,
  onContinueWithoutLogin,
  onGoToLogin
}) => {
  const { colors } = useTheme()

  return (
    <Sheet visible={visible} onClose={onDismiss} title="Are you sure?" fitContent>
      {/* Content */}
      <View style={styles.content}>
        <Text style={[styles.intro, { color: colors.textPrimary }]}>
          A Web3 identity brings you:
        </Text>

        <Text style={[styles.benefitTitle, { color: colors.textPrimary }]}>Micropayments</Text>
        <Text style={[styles.benefitBody, { color: colors.textPrimary }]}>
          where creators to earn directly.
        </Text>
        <Text style={[styles.benefitTitle, { color: colors.textPrimary }]}>Private Identity</Text>
        <Text style={[styles.benefitBody, { color: colors.textPrimary }]}>
          with mutual auth means no signups or logins.
        </Text>
        <Text style={[styles.benefitTitle, { color: colors.textPrimary }]}>Data Sovereignty</Text>
        <Text style={[styles.benefitBody, { color: colors.textPrimary }]}>
          you&apos;re in control, with no 3rd party tracking.
        </Text>
      </View>

      <Text style={[styles.cta, { color: colors.textPrimary }]}>
        Become an early adopter and lead your peers to the future of everything.
      </Text>

      {/* Action Buttons */}
      <View style={styles.buttonContainer}>
        <PressableScale
          haptic="confirm"
          style={[styles.primaryButton, { backgroundColor: colors.accent }]}
          onPress={onGoToLogin}
        >
          <Text style={[styles.primaryButtonText, { color: colors.textOnAccent }]}>
            Get Started
          </Text>
        </PressableScale>

        <PressableScale
          style={[styles.secondaryButton, { borderColor: colors.separator }]}
          onPress={onContinueWithoutLogin}
        >
          <Text style={[styles.secondaryButtonText, { color: colors.textSecondary }]}>
            Maybe Later
          </Text>
        </PressableScale>
      </View>
    </Sheet>
  )
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  intro: {
    ...typography.callout,
    marginBottom: spacing.lg,
  },
  benefitTitle: {
    ...typography.headline,
  },
  benefitBody: {
    ...typography.subhead,
    lineHeight: 20,
    marginBottom: spacing.sm,
  },
  cta: {
    ...typography.headline,
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.lg,
  },
  buttonContainer: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xl,
  },
  primaryButton: {
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.xxl,
    borderRadius: radii.xl,
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  primaryButtonText: {
    ...typography.callout,
    fontWeight: '600',
  },
  secondaryButton: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    alignSelf: 'center',
    marginTop: spacing.sm,
    borderRadius: radii.xl,
    borderWidth: StyleSheet.hairlineWidth,
  },
  secondaryButtonText: {
    ...typography.subhead,
  },
})

export default Web3BenefitsModal
