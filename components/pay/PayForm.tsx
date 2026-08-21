/**
 * The shared pay-form vocabulary.
 *
 * The three rails grew up separately, and it showed: each hand-rolled its own
 * field labels, amount prompt, warning note and submit button, so the same
 * question read differently depending on how the counterparty was identified.
 * These components are the fix — a rail composes them and inherits the one
 * agreed rendering of each question. If a screen needs to ask for an amount,
 * it uses PayAmountField; there is no second way to ask.
 *
 * Everything here is presentational. Validation, sending and money movement
 * stay in the rails — proven logic this refactor deliberately does not touch.
 */
import React from 'react'
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useTranslation } from 'react-i18next'

import AvailableBalance from '@/components/pay/AvailableBalance'
import PressableScale from '@/components/ui/PressableScale'
import { AmountInput } from '@/components/wallet/AmountInput'
import { useTheme } from '@/context/theme/ThemeContext'
import { radii, spacing, typography } from '@/context/theme/tokens'

/** One field section: the uppercase caption, then whatever asks the question. */
export function PayField({ labelKey, children }: { labelKey: string; children: React.ReactNode }) {
  const { t } = useTranslation()
  const { colors } = useTheme()
  return (
    <View style={styles.fieldGroup}>
      <Text style={[styles.fieldLabel, { color: colors.textTertiary }]}>{t(labelKey)}</Text>
      {children}
    </View>
  )
}

/**
 * THE amount question. Same label, same balance line, same input on every
 * screen that asks it. `showBalance` is false only when the person typing is
 * not the one paying (a payee naming a request) — their balance is meaningless
 * to the payer and showing it would imply otherwise.
 */
export function PayAmountField({
  value,
  onChangeText,
  showMax = true,
  showBalance = true
}: {
  value: string
  onChangeText: (text: string) => void
  showMax?: boolean
  showBalance?: boolean
}) {
  return (
    <PayField labelKey="amount">
      {showBalance && <AvailableBalance />}
      <AmountInput value={value} onChangeText={onChangeText} showMax={showMax} />
    </PayField>
  )
}

/** The consequence, before the button — not after. Boxed so it reads as fact,
 * not fine print. */
export function ConsequenceNote({ textKey }: { textKey: string }) {
  const { t } = useTranslation()
  const { colors } = useTheme()
  return (
    <View style={[styles.consequence, { backgroundColor: colors.fillTertiary, borderColor: colors.separator }]}>
      <Ionicons name="information-circle-outline" size={16} color={colors.textSecondary} />
      <Text style={[styles.consequenceText, { color: colors.textSecondary }]}>{t(textKey)}</Text>
    </View>
  )
}

/** The submit button every rail sends with. */
export function PayCta({
  onPress,
  disabled,
  busy,
  labelKey = 'pay',
  icon = 'arrow-up'
}: {
  onPress: () => void
  disabled: boolean
  busy: boolean
  labelKey?: string
  icon?: keyof typeof Ionicons.glyphMap
}) {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const enabled = !disabled
  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled}
      haptic="confirm"
      style={[styles.cta, { backgroundColor: enabled ? colors.accent : colors.fill }]}
      accessibilityRole="button"
      accessibilityLabel={t(labelKey)}
      accessibilityState={{ disabled }}
    >
      {busy ? (
        <ActivityIndicator size="small" color={enabled ? colors.background : colors.textTertiary} />
      ) : (
        <>
          <Ionicons name={icon} size={20} color={enabled ? colors.textOnAccent : colors.textTertiary} />
          <Text style={[styles.ctaText, { color: enabled ? colors.textOnAccent : colors.textTertiary }]}>
            {t(labelKey)}
          </Text>
        </>
      )}
    </PressableScale>
  )
}

/**
 * The resolved counterparty, shown the same way on every rail: avatar, the
 * RECIPIENT caption, the name, and (when the name is not itself the key) the
 * abbreviated key or address underneath.
 */
export function RecipientSummary({
  name,
  detail,
  icon = 'person'
}: {
  name: string
  detail?: string
  icon?: keyof typeof Ionicons.glyphMap
}) {
  const { t } = useTranslation()
  const { colors } = useTheme()
  return (
    <View style={[styles.idCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.separator }]}>
      <View style={[styles.avatar, { backgroundColor: colors.fillTertiary }]}>
        <Ionicons name={icon} size={20} color={colors.textSecondary} />
      </View>
      <View style={styles.idText}>
        <Text style={[styles.idLabel, { color: colors.textTertiary }]}>{t('recipient')}</Text>
        <Text style={[styles.idName, { color: colors.textPrimary }]} numberOfLines={1}>
          {name}
        </Text>
        {!!detail && (
          <Text style={[styles.idKey, { color: colors.textTertiary }]} numberOfLines={1} ellipsizeMode="middle">
            {detail}
          </Text>
        )}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  fieldGroup: { marginBottom: spacing.xl },
  fieldLabel: {
    ...typography.caption2,
    fontWeight: '600',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginBottom: spacing.sm
  },
  consequence: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.lg
  },
  consequenceText: { ...typography.footnote, flex: 1 },
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md + 2,
    borderRadius: radii.md
  },
  ctaText: { ...typography.subhead, fontWeight: '600' },
  idCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    padding: spacing.md
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center'
  },
  idText: { flex: 1, gap: 2 },
  idLabel: {
    ...typography.caption2,
    fontWeight: '600',
    letterSpacing: 0.8,
    textTransform: 'uppercase'
  },
  idName: { ...typography.body, fontWeight: '600' },
  idKey: { ...typography.caption1 }
})
