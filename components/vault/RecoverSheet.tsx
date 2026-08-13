/**
 * Recover-with-phrase sheet. The escape hatch when the YubiKey is lost or its
 * PIV applet is bricked: paste the 24-word backup phrase and the vault is swept
 * to the everyday balance with the phrase key directly — no YubiKey involved —
 * then the vault is cleared. `onRecover` throws on an invalid phrase or a
 * sweep failure; the sheet surfaces the error and stays open.
 */
import React, { useCallback, useState } from 'react'
import { View, Text, StyleSheet, TextInput, ActivityIndicator } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import Sheet from '@/components/ui/Sheet'
import PressableScale from '@/components/ui/PressableScale'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, radii, typography } from '@/context/theme/tokens'
import { haptics } from '@/hooks/useHaptics'
import i18n from '@/context/i18n/translations'

const t = (k: string) => i18n.t(k) as string

export const RecoverSheet: React.FC<{
  visible: boolean
  onClose: () => void
  onRecover: (phrase: string) => Promise<void>
}> = ({ visible, onClose, onRecover }) => {
  const { colors } = useTheme()
  const [phrase, setPhrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(async () => {
    const words = phrase.trim().split(/\s+/).filter(Boolean)
    if (words.length < 12) {
      setError(t('vault_recover_too_short'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onRecover(words.join(' '))
      setPhrase('')
    } catch {
      setError(t('vault_recover_failed'))
      haptics.error()
    } finally {
      setBusy(false)
    }
  }, [phrase, onRecover])

  return (
    <Sheet visible={visible} onClose={onClose} title={t('vault_recover_title')} fitContent>
      <View style={styles.body}>
        <Ionicons name="medkit-outline" size={40} color={colors.accent} />
        <Text style={[styles.sub, { color: colors.textSecondary }]}>{t('vault_recover_sub')}</Text>
        <TextInput
          style={[styles.input, { color: colors.textPrimary, backgroundColor: colors.backgroundSecondary }]}
          value={phrase}
          onChangeText={setPhrase}
          placeholder={t('vault_recover_placeholder')}
          placeholderTextColor={colors.textTertiary}
          autoCapitalize="none"
          autoCorrect={false}
          multiline
        />
        {error && <Text style={[styles.err, { color: colors.error }]}>{error}</Text>}
        <PressableScale
          haptic="confirm"
          onPress={run}
          disabled={busy}
          style={[styles.primary, { backgroundColor: colors.accent, opacity: busy ? 0.6 : 1 }]}
        >
          {busy ? (
            <ActivityIndicator color={colors.textOnAccent} />
          ) : (
            <Text style={[styles.primaryLabel, { color: colors.textOnAccent }]}>{t('vault_recover_cta')}</Text>
          )}
        </PressableScale>
      </View>
    </Sheet>
  )
}

const styles = StyleSheet.create({
  body: { padding: spacing.xl, gap: spacing.lg, alignItems: 'center' },
  sub: { ...typography.subhead, textAlign: 'center' },
  input: { width: '100%', minHeight: 96, borderRadius: radii.md, padding: spacing.lg, ...typography.body, textAlignVertical: 'top' },
  err: { ...typography.footnote, textAlign: 'center' },
  primary: { width: '100%', borderRadius: radii.md, paddingVertical: spacing.lg, alignItems: 'center' },
  primaryLabel: { ...typography.headline }
})
