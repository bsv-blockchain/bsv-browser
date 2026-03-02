import React from 'react'
import { View, TextInput, TouchableOpacity, Text, StyleSheet } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, typography, radii } from '@/context/theme/tokens'

export const SEND_MAX_VALUE = '20999999.99999999'

interface BsvAmountInputProps {
  value: string
  onChangeText: (text: string) => void
}

export const BsvAmountInput: React.FC<BsvAmountInputProps> = ({ value, onChangeText }) => {
  const { colors } = useTheme()
  const isSendMax = value === SEND_MAX_VALUE

  if (isSendMax) {
    return (
      <View style={[styles.row, { backgroundColor: colors.backgroundSecondary, borderColor: colors.accent }]}>
        <View style={styles.sendMaxDisplay}>
          <Ionicons name="wallet-outline" size={18} color={colors.accent} />
          <Text style={[styles.sendMaxLabel, { color: colors.accent }]}>
            Entire wallet balance
          </Text>
        </View>
        <TouchableOpacity
          onPress={() => onChangeText('')}
          style={[styles.clearButton, { backgroundColor: colors.accent + '15' }]}
        >
          <Ionicons name="close" size={16} color={colors.accent} />
        </TouchableOpacity>
      </View>
    )
  }

  return (
    <View style={[styles.row, { backgroundColor: colors.backgroundSecondary, borderColor: colors.separator }]}>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder="0.00000000"
        placeholderTextColor={colors.textTertiary}
        keyboardType="decimal-pad"
        returnKeyType="done"
        style={[styles.input, { color: colors.textPrimary }]}
      />
      <TouchableOpacity
        onPress={() => onChangeText(SEND_MAX_VALUE)}
        style={[styles.maxButton, { backgroundColor: colors.accent + '15' }]}
      >
        <Text style={[styles.maxText, { color: colors.accent }]}>Send Max</Text>
      </TouchableOpacity>
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  input: {
    ...typography.body,
    flex: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  maxButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.sm,
    marginRight: spacing.sm,
  },
  maxText: {
    ...typography.footnote,
    fontWeight: '600',
  },
  sendMaxDisplay: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  sendMaxLabel: {
    ...typography.body,
    fontWeight: '600',
  },
  clearButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.sm,
  },
})
