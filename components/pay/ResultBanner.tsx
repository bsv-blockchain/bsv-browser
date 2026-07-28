/**
 * The inline success / error banner both handle cells use.
 *
 * Copied verbatim out of app/payments.tsx so the two cells report results the
 * same way the old screen did.
 */
import React from 'react'
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { spacing, typography, radii } from '@/context/theme/tokens'

interface ResultBannerProps {
  readonly result: { type: 'success' | 'error'; message: string }
  readonly onDismiss: () => void
  readonly colors: ReturnType<typeof import('@/context/theme/ThemeContext').useTheme>['colors']
}

export default function ResultBanner({ result, onDismiss, colors }: ResultBannerProps) {
  const isSuccess = result.type === 'success'
  const color = isSuccess ? colors.success : colors.error
  return (
    <View style={[styles.resultBanner, { backgroundColor: color + '15', borderColor: color }]}>
      <Ionicons name={isSuccess ? 'checkmark-circle' : 'alert-circle'} size={20} color={color} />
      <Text style={[styles.resultText, { color }]}>{result.message}</Text>
      <TouchableOpacity onPress={onDismiss} style={styles.resultDismiss}>
        <Ionicons name="close" size={18} color={color} />
      </TouchableOpacity>
    </View>
  )
}

const styles = StyleSheet.create({
  resultBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    marginTop: spacing.lg,
    marginBottom: spacing.lg
  },
  resultText: {
    ...typography.subhead,
    fontWeight: '500',
    flex: 1
  },
  resultDismiss: {
    padding: spacing.xs
  }
})
