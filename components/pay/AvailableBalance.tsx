/**
 * The "what can I actually send?" line every send surface opens with.
 *
 * One compact row — wallet glyph, the spendable figure, "available" — kept to
 * footnote weight so the form below stays the focal point (the wallet screen
 * owns the 44pt balance; here it is context, not headline). The figure runs
 * through AmountDisplay so it follows the user's BSV/fiat currency setting,
 * and the row renders nothing until a figure exists rather than flashing "0".
 */
import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useTranslation } from 'react-i18next'
import AmountDisplay from '@/components/wallet/AmountDisplay'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, typography } from '@/context/theme/tokens'
import { useSpendableBalance } from '@/hooks/useSpendableBalance'

export default function AvailableBalance() {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const balance = useSpendableBalance()

  if (balance == null) return null

  return (
    <View style={styles.row} accessibilityRole="text">
      <Ionicons name="wallet-outline" size={14} color={colors.textSecondary} />
      <Text style={[styles.text, { color: colors.textSecondary }]}>
        <Text style={[styles.figure, { color: colors.textPrimary }]}>
          <AmountDisplay>{balance}</AmountDisplay>
        </Text>{' '}
        {t('available')}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginBottom: spacing.lg
  },
  text: { ...typography.footnote },
  figure: { ...typography.footnote, fontWeight: '600', fontVariant: ['tabular-nums'] }
})
