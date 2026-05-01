import React, { useContext, useState, useEffect, useRef } from 'react'
import { View, TextInput, TouchableOpacity, Text, StyleSheet } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useTranslation } from 'react-i18next'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, typography, radii } from '@/context/theme/tokens'
import { useWallet } from '@/context/WalletContext'
import { ExchangeRateContext } from '@/context/ExchangeRateContext'
import { parseDisplayToSatoshis } from '@/utils/amountFormatHelpers'

export const SEND_MAX_VALUE = '2099999999999999'

interface AmountInputProps {
  value: string
  onChangeText: (text: string) => void
}

/**
 * Unit-aware amount input component.
 *
 * In BSV mode (default): accepts integer satoshis via number-pad.
 * In USD mode: accepts dollar amounts with up to 2 decimals via decimal-pad,
 * converts to satoshis internally.
 *
 * The `onChangeText` callback always emits satoshi integer strings.
 * The `value` prop is always satoshi integer strings.
 */
export const AmountInput: React.FC<AmountInputProps> = ({ value, onChangeText }) => {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const { settings } = useWallet()
  const { satoshisPerUSD } = useContext(ExchangeRateContext)

  const currency = settings?.currency || 'BSV'
  const isUSD = currency === 'USD'
  const isSendMax = value === SEND_MAX_VALUE

  // In USD mode, we maintain a separate display value (dollars) from the satoshi value
  const [usdDisplayValue, setUsdDisplayValue] = useState('')
  const lastEmittedSats = useRef('')

  // Sync USD display value when the satoshi value changes externally (e.g., cleared by parent)
  useEffect(() => {
    if (!isUSD) return
    // Avoid re-syncing when we caused the change ourselves
    if (value === lastEmittedSats.current) return

    if (!value || value === '0') {
      setUsdDisplayValue('')
    } else if (value === SEND_MAX_VALUE) {
      // Don't try to convert SEND_MAX_VALUE to USD
    } else {
      // Convert satoshis back to USD for display
      const sats = parseInt(value, 10)
      if (!isNaN(sats) && satoshisPerUSD > 0) {
        const usd = sats / satoshisPerUSD
        // Show up to 2 decimal places, trimming trailing zeros
        setUsdDisplayValue(usd % 1 === 0 ? usd.toFixed(0) : usd.toFixed(2).replace(/0+$/, '').replace(/\.$/, ''))
      }
    }
    lastEmittedSats.current = value
  }, [value, isUSD, satoshisPerUSD])

  const handleChangeText = (text: string) => {
    if (isUSD) {
      // Validate USD input: allow digits, one decimal point, up to 2 decimal places
      if (text && !/^\d*\.?\d{0,2}$/.test(text)) return
      setUsdDisplayValue(text)
      const sats = parseDisplayToSatoshis(text, 'USD', satoshisPerUSD)
      const satsStr = text ? String(sats) : ''
      lastEmittedSats.current = satsStr
      onChangeText(satsStr)
    } else {
      // BSV mode: integer satoshis passthrough
      onChangeText(text)
    }
  }

  if (isSendMax) {
    return (
      <View style={[styles.row, { backgroundColor: colors.backgroundSecondary, borderColor: colors.accent }]}>
        <View style={styles.sendMaxDisplay}>
          <Ionicons name="wallet-outline" size={18} color={colors.accent} />
          <Text style={[styles.sendMaxLabel, { color: colors.accent }]}>{t('entire_wallet_balance')}</Text>
        </View>
        <TouchableOpacity
          onPress={() => {
            if (isUSD) setUsdDisplayValue('')
            onChangeText('')
          }}
          style={[styles.clearButton, { backgroundColor: colors.accent + '15' }]}
        >
          <Ionicons name="close" size={16} color={colors.accent} />
        </TouchableOpacity>
      </View>
    )
  }

  const displayValue = isUSD ? usdDisplayValue : value
  const placeholder = isUSD ? '0.00' : '0'
  const keyboardType = isUSD ? ('decimal-pad' as const) : ('number-pad' as const)
  const unitLabel = isUSD ? 'USD' : 'satoshis'

  return (
    <View style={[styles.row, { backgroundColor: colors.backgroundSecondary, borderColor: colors.separator }]}>
      <TextInput
        value={displayValue}
        onChangeText={handleChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textTertiary}
        keyboardType={keyboardType}
        returnKeyType="done"
        style={[styles.input, { color: colors.textPrimary }]}
      />
      <Text style={[styles.unitLabel, { color: colors.textSecondary }]}>{unitLabel}</Text>
      <TouchableOpacity
        onPress={() => onChangeText(SEND_MAX_VALUE)}
        style={[styles.maxButton, { backgroundColor: colors.accent + '15' }]}
      >
        <Text style={[styles.maxText, { color: colors.accent }]}>{t('send_max')}</Text>
      </TouchableOpacity>
    </View>
  )
}

// Keep legacy export name for backward compatibility during migration
export const SatsAmountInput = AmountInput

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth
  },
  input: {
    ...typography.body,
    flex: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md
  },
  unitLabel: {
    ...typography.footnote,
    paddingRight: spacing.sm
  },
  maxButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.sm,
    marginRight: spacing.sm
  },
  maxText: {
    ...typography.footnote,
    fontWeight: '600'
  },
  sendMaxDisplay: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md
  },
  sendMaxLabel: {
    ...typography.body,
    fontWeight: '600'
  },
  clearButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.sm
  }
})
