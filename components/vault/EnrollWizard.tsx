/**
 * Vault enrollment wizard — intro → insert → (PIN change if factory) → generate
 * (touch) → show backup phrase once → confirm quiz → done.
 *
 * enrollVault() drives the YubiKey directly (getKeyInfo → PIN → generate); this
 * component supplies the PIN and pin-change prompts and renders the phase it
 * reports. The backup phrase is shown exactly once and gated behind a 3-word
 * confirmation quiz, mirroring app/auth/mnemonic.tsx — losing both the key and
 * the phrase means losing the vault.
 */
import React, { useCallback, useRef, useState } from 'react'
import { View, Text, StyleSheet, TextInput, ScrollView, ActivityIndicator } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import PressableScale from '@/components/ui/PressableScale'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, radii, typography } from '@/context/theme/tokens'
import { enrollVault } from '@/services/vault/VaultKeyService'
import { VaultError } from '@/services/vault/types'
import { sounds } from '@/hooks/useConfirmationSound'
import { haptics } from '@/hooks/useHaptics'
import { showToast } from '@/components/ui/Toast'
import i18n from '@/context/i18n/translations'

const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, o) as string

type Step = 'intro' | 'running' | 'backup' | 'confirm' | 'done'

// A deferred prompt the wizard resolves when the user submits the PIN.
interface PinRequest {
  kind: 'pin' | 'change'
  retries?: number
  resolve: (v: any) => void
  reject: (e: unknown) => void
}

export const EnrollWizard: React.FC<{ onDone: () => void; onCancel: () => void }> = ({ onDone, onCancel }) => {
  const { colors } = useTheme()
  const [step, setStep] = useState<Step>('intro')
  const [nickname, setNickname] = useState('')
  const [phaseLabel, setPhaseLabel] = useState('')
  const [pinReq, setPinReq] = useState<PinRequest | null>(null)
  const [pinInput, setPinInput] = useState('')
  const [newPinInput, setNewPinInput] = useState('')
  const [mnemonic, setMnemonic] = useState('')
  const [quiz, setQuiz] = useState<{ index: number; answer: string }[]>([])
  const [quizInputs, setQuizInputs] = useState<Record<number, string>>({})
  const [error, setError] = useState<string | null>(null)
  const mnemonicRef = useRef('')

  const requestPin = useCallback(
    () => new Promise<string>((resolve, reject) => setPinReq({ kind: 'pin', resolve, reject })),
    []
  )
  const requestPinChange = useCallback(
    (retries: number) =>
      new Promise<{ oldPin: string; newPin: string }>((resolve, reject) =>
        setPinReq({ kind: 'change', retries, resolve, reject })
      ),
    []
  )

  const start = useCallback(async () => {
    setStep('running')
    setError(null)
    try {
      const { backupMnemonic } = await enrollVault({
        nickname: nickname.trim() || t('vault_default_nickname'),
        onPhase: p => setPhaseLabel(t(`vault_enroll_phase_${p}`)),
        getPin: requestPin,
        requestPinChange
      })
      mnemonicRef.current = backupMnemonic
      setMnemonic(backupMnemonic)
      // Pick 3 distinct word positions for the confirmation quiz.
      const words = backupMnemonic.split(' ')
      const idxs = new Set<number>()
      let guard = 0
      while (idxs.size < 3 && guard++ < 100) idxs.add(Math.floor((words.length * (idxs.size + 1)) / 4))
      setQuiz(Array.from(idxs).map(index => ({ index, answer: words[index] })))
      haptics.success()
      setStep('backup')
    } catch (e) {
      const msg = e instanceof VaultError ? t(`vault_err_${e.code.replace(/-/g, '_')}`, {}) : String(e)
      setError(msg || t('vault_err_generic'))
      haptics.error()
      setStep('intro')
    }
  }, [nickname, requestPin, requestPinChange])

  const submitPin = useCallback(() => {
    if (!pinReq) return
    if (pinReq.kind === 'change') {
      if (newPinInput.length < 6) return
      pinReq.resolve({ oldPin: '123456', newPin: newPinInput })
    } else {
      if (pinInput.length < 4) return
      pinReq.resolve(pinInput)
    }
    setPinReq(null)
    setPinInput('')
    setNewPinInput('')
  }, [pinReq, pinInput, newPinInput])

  const confirmQuiz = useCallback(() => {
    const ok = quiz.every(q => (quizInputs[q.index] ?? '').trim().toLowerCase() === q.answer.toLowerCase())
    if (!ok) {
      setError(t('vault_backup_quiz_wrong'))
      haptics.error()
      return
    }
    setMnemonic('')
    mnemonicRef.current = ''
    sounds.vaultOpen()
    haptics.success()
    showToast(t('vault_enrolled_toast'), { type: 'success' })
    setStep('done')
    onDone()
  }, [quiz, quizInputs, onDone])

  // ── render per step ─────────────────────────────────────────────────
  if (step === 'intro') {
    return (
      <ScrollView contentContainerStyle={styles.body}>
        <Ionicons name="lock-closed" size={48} color={colors.accent} style={styles.hero} />
        <Text style={[styles.h1, { color: colors.textPrimary }]}>{t('vault_enroll_title')}</Text>
        <Text style={[styles.p, { color: colors.textSecondary }]}>{t('vault_enroll_intro')}</Text>
        <TextInput
          style={[styles.input, { color: colors.textPrimary, backgroundColor: colors.backgroundSecondary }]}
          value={nickname}
          onChangeText={setNickname}
          placeholder={t('vault_nickname_placeholder')}
          placeholderTextColor={colors.textTertiary}
          maxLength={24}
        />
        {error && <Text style={[styles.err, { color: colors.error }]}>{error}</Text>}
        <PressableScale haptic="confirm" onPress={start} style={[styles.primary, { backgroundColor: colors.accent }]}>
          <Text style={[styles.primaryLabel, { color: colors.textOnAccent }]}>{t('vault_enroll_begin')}</Text>
        </PressableScale>
        <PressableScale onPress={onCancel} style={styles.secondary}>
          <Text style={[styles.secondaryLabel, { color: colors.textSecondary }]}>{t('vault_cancel')}</Text>
        </PressableScale>
      </ScrollView>
    )
  }

  if (step === 'running') {
    return (
      <View style={styles.body}>
        {pinReq ? (
          <>
            <Ionicons name="keypad-outline" size={40} color={colors.accent} style={styles.hero} />
            <Text style={[styles.h1, { color: colors.textPrimary }]}>
              {pinReq.kind === 'change' ? t('vault_set_new_pin') : t('vault_enter_pin')}
            </Text>
            {pinReq.kind === 'change' && <Text style={[styles.p, { color: colors.textSecondary }]}>{t('vault_default_pin_warning')}</Text>}
            <TextInput
              style={[styles.pin, { color: colors.textPrimary, backgroundColor: colors.backgroundSecondary }]}
              value={pinReq.kind === 'change' ? newPinInput : pinInput}
              onChangeText={pinReq.kind === 'change' ? setNewPinInput : setPinInput}
              placeholder="••••••"
              placeholderTextColor={colors.textTertiary}
              keyboardType="number-pad"
              secureTextEntry
              maxLength={8}
              autoFocus
            />
            <PressableScale haptic="confirm" onPress={submitPin} style={[styles.primary, { backgroundColor: colors.accent }]}>
              <Text style={[styles.primaryLabel, { color: colors.textOnAccent }]}>{t('vault_continue')}</Text>
            </PressableScale>
          </>
        ) : (
          <>
            <ActivityIndicator color={colors.accent} size="large" style={styles.hero} />
            <Text style={[styles.h1, { color: colors.textPrimary }]}>{phaseLabel || t('vault_reading_key')}</Text>
            <Text style={[styles.p, { color: colors.textSecondary }]}>{t('vault_touch_when_blinks')}</Text>
          </>
        )}
      </View>
    )
  }

  if (step === 'backup') {
    const words = mnemonic.split(' ')
    return (
      <ScrollView contentContainerStyle={styles.body}>
        <Ionicons name="key-outline" size={40} color={colors.warning} style={styles.hero} />
        <Text style={[styles.h1, { color: colors.textPrimary }]}>{t('vault_backup_title')}</Text>
        <Text style={[styles.p, { color: colors.error }]}>{t('vault_backup_warning')}</Text>
        <View style={styles.wordGrid}>
          {words.map((w, i) => (
            <View key={i} style={[styles.wordChip, { backgroundColor: colors.backgroundSecondary }]}>
              <Text style={[styles.wordIdx, { color: colors.textTertiary }]}>{i + 1}</Text>
              <Text style={[styles.word, { color: colors.textPrimary }]}>{w}</Text>
            </View>
          ))}
        </View>
        <PressableScale haptic="confirm" onPress={() => setStep('confirm')} style={[styles.primary, { backgroundColor: colors.accent }]}>
          <Text style={[styles.primaryLabel, { color: colors.textOnAccent }]}>{t('vault_backup_saved')}</Text>
        </PressableScale>
      </ScrollView>
    )
  }

  if (step === 'confirm') {
    return (
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={[styles.h1, { color: colors.textPrimary }]}>{t('vault_backup_confirm_title')}</Text>
        <Text style={[styles.p, { color: colors.textSecondary }]}>{t('vault_backup_confirm_sub')}</Text>
        {quiz.map(q => (
          <View key={q.index} style={styles.quizRow}>
            <Text style={[styles.quizLabel, { color: colors.textSecondary }]}>{t('vault_word_n', { n: q.index + 1 })}</Text>
            <TextInput
              style={[styles.input, { flex: 1, color: colors.textPrimary, backgroundColor: colors.backgroundSecondary }]}
              value={quizInputs[q.index] ?? ''}
              onChangeText={v => setQuizInputs(s => ({ ...s, [q.index]: v }))}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
        ))}
        {error && <Text style={[styles.err, { color: colors.error }]}>{error}</Text>}
        <PressableScale haptic="confirm" onPress={confirmQuiz} style={[styles.primary, { backgroundColor: colors.accent }]}>
          <Text style={[styles.primaryLabel, { color: colors.textOnAccent }]}>{t('vault_finish')}</Text>
        </PressableScale>
      </ScrollView>
    )
  }

  return null
}

const styles = StyleSheet.create({
  body: { padding: spacing.xl, gap: spacing.lg, alignItems: 'center' },
  hero: { marginTop: spacing.lg },
  h1: { ...typography.title2, textAlign: 'center' },
  p: { ...typography.subhead, textAlign: 'center' },
  input: { width: '100%', borderRadius: radii.md, paddingVertical: spacing.md, paddingHorizontal: spacing.lg, ...typography.body },
  pin: { width: '70%', textAlign: 'center', ...typography.title2, letterSpacing: 8, borderRadius: radii.md, paddingVertical: spacing.md },
  primary: { width: '100%', borderRadius: radii.md, paddingVertical: spacing.lg, alignItems: 'center' },
  primaryLabel: { ...typography.headline },
  secondary: { paddingVertical: spacing.md, alignItems: 'center' },
  secondaryLabel: { ...typography.body },
  err: { ...typography.footnote, textAlign: 'center' },
  wordGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, justifyContent: 'center' },
  wordChip: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingVertical: spacing.sm, paddingHorizontal: spacing.md, borderRadius: radii.sm, minWidth: 96 },
  wordIdx: { ...typography.caption2 },
  word: { ...typography.body },
  quizRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, width: '100%' },
  quizLabel: { ...typography.subhead, width: 72 }
})
