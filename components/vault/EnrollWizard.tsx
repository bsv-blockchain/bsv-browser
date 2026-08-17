/**
 * Vault enrollment wizard — intro → passphrase → PIN → tap → done.
 *
 * The vault key is derived from the wallet's EXISTING mnemonic plus a vault
 * passphrase, so there is no second phrase to write down and no confirmation
 * quiz. What replaces them is the passphrase step: a strength meter, because
 * the KDF is only 2048 rounds, and a confirm field, because BIP39 passphrases
 * have no checksum and a typo silently opens a different, empty vault.
 *
 * enrollVault() drives the YubiKey (getKeyInfo → PIN → generate). Every prompt
 * is gathered BEFORE the tap, since the NFC sheet covers the app.
 */
import React, { useCallback, useEffect, useState } from 'react'
import { View, Text, StyleSheet, TextInput, ScrollView, ActivityIndicator } from 'react-native'
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons'
import PressableScale from '@/components/ui/PressableScale'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, radii, typography } from '@/context/theme/tokens'
import { enrollVault, finalizeEnrollment } from '@/services/vault/VaultKeyService'
import { VaultError } from '@/services/vault/types'
import { PassphraseField } from './PassphraseField'
import { useLocalStorage } from '@/context/LocalStorageProvider'
import { printRecoveryShares } from '@/utils/printRecoveryShares'
import { sounds } from '@/hooks/useConfirmationSound'
import { haptics } from '@/hooks/useHaptics'
import { showToast } from '@/components/ui/Toast'
import i18n from '@/context/i18n/translations'
import { PhraseBackupSheet } from './PhraseBackupSheet'
import { backupAttestation, type BackupMedium } from '@/services/vault/backupAttestation'
import { useWallet } from '@/context/WalletContext'

const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, o) as string

type Step = 'backup' | 'phrase' | 'intro' | 'passphrase' | 'running' | 'done'

interface PinRequest {
  kind: 'pin' | 'change'
  retries?: number
  resolve: (v: any) => void
  reject: (e: unknown) => void
}

export const EnrollWizard: React.FC<{ onDone: () => void; onCancel: () => void }> = ({
  onDone,
  onCancel
}) => {
  const { colors } = useTheme()
  const { getMnemonic, getRecoveredKey } = useLocalStorage()
  const [step, setStep] = useState<Step>('backup')
  const [medium, setMedium] = useState<BackupMedium | null>(null)
  const [revealed, setRevealed] = useState<string | null>(null)
  const [nickname, setNickname] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [confirm, setConfirm] = useState('')
  const [passphraseOk, setPassphraseOk] = useState(false)
  const [phaseLabel, setPhaseLabel] = useState('')
  const [pinReq, setPinReq] = useState<PinRequest | null>(null)
  const [pinInput, setPinInput] = useState('')
  const [newPinInput, setNewPinInput] = useState('')
  const [printing, setPrinting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { managers, adminOriginator } = useWallet()

  /** The wallet identity is the attestation's scope key. */
  const identity = useCallback(async (): Promise<string | null> => {
    const r = await managers?.permissionsManager?.getPublicKey(
      { identityKey: true },
      adminOriginator
    )
    return r?.publicKey ?? null
  }, [managers, adminOriginator])

  // A user who already backed up on a previous visit should not be asked twice.
  useEffect(() => {
    let alive = true
    void (async () => {
      const key = await identity()
      if (!key) return
      const existing = await backupAttestation.get(key)
      if (alive && existing) setMedium(existing.medium)
    })()
    return () => {
      alive = false
    }
  }, [identity])

  const attest = useCallback(
    async (m: BackupMedium) => {
      const key = await identity()
      if (key) await backupAttestation.set(key, m)
      setMedium(m)
    },
    [identity]
  )

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

  const onPrintShares = useCallback(async () => {
    if (printing) return
    setPrinting(true)
    try {
      const result = await printRecoveryShares({
        mnemonic: await getMnemonic(),
        recoveredKeyWif: await getRecoveredKey?.()
      })
      if (result.ok) {
        // Only a resolved print sheet counts. A cancelled one produced no paper.
        await attest('shares')
      } else if (result.reason === 'unsupported-word-count') {
        showToast(t('vault_shares_word_count'), { type: 'error' })
      } else {
        showToast(t('vault_shares_unavailable'), { type: 'error' })
      }
    } catch {
      // Print sheet dismissed or unavailable — not an error worth blocking on.
    } finally {
      setPrinting(false)
    }
  }, [printing, getMnemonic, getRecoveredKey, attest])

  const onRevealPhrase = useCallback(async () => {
    setError(null)
    // getMnemonic() is behind the biometric latch, so the reveal is
    // re-authenticated without a second prompt of our own.
    const mnemonic = await getMnemonic()
    if (!mnemonic) {
      setError(t('vault_requires_mnemonic'))
      haptics.error()
      return
    }
    setRevealed(mnemonic)
    setStep('phrase')
  }, [getMnemonic])

  // Gate: a wallet restored from backup shares has no mnemonic, so it can
  // neither enroll nor ever recover a vault. Refuse rather than create a vault
  // with only one recovery path.
  const toPassphrase = useCallback(async () => {
    setError(null)
    const mnemonic = await getMnemonic()
    if (!mnemonic) {
      setError(t('vault_requires_mnemonic'))
      haptics.error()
      return
    }
    setStep('passphrase')
  }, [getMnemonic])

  const start = useCallback(async () => {
    setStep('running')
    setError(null)
    try {
      const mnemonic = await getMnemonic()
      if (!mnemonic) throw new VaultError('bad-mnemonic', t('vault_requires_mnemonic'))
      const { pending } = await enrollVault({
        nickname: nickname.trim() || t('vault_default_nickname'),
        mnemonic,
        passphrase,
        onPhase: p => setPhaseLabel(t(`vault_enroll_phase_${p}`)),
        getPin: requestPin,
        requestPinChange
      })
      await finalizeEnrollment(pending)
      setPassphrase('')
      setConfirm('')
      sounds.vaultOpen()
      haptics.success()
      showToast(t('vault_enrolled_toast'), { type: 'success' })
      setStep('done')
      onDone()
    } catch (e) {
      const msg =
        e instanceof VaultError ? t(`vault_err_${e.code.replace(/-/g, '_')}`, {}) : String(e)
      setError(msg || t('vault_err_generic'))
      haptics.error()
      setStep('passphrase')
    }
  }, [nickname, passphrase, getMnemonic, requestPin, requestPinChange, onDone])

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

  // ── backup (prerequisite) ───────────────────────────────────────────
  if (step === 'backup') {
    return (
      <ScrollView contentContainerStyle={styles.body}>
        <Ionicons
          name="shield-checkmark-outline"
          size={48}
          color={colors.textPrimary}
          style={styles.hero}
        />
        <Text style={[styles.h1, { color: colors.textPrimary }]}>{t('vault_backup_title')}</Text>
        <Text style={[styles.p, { color: colors.textSecondary }]}>{t('vault_backup_intro')}</Text>

        <BackupRow
          icon="document-text-outline"
          title={t('vault_backup_phrase_title')}
          subtitle={t('vault_backup_phrase_sub')}
          done={medium === 'phrase'}
          busy={false}
          onPress={onRevealPhrase}
        />
        <BackupRow
          icon="print-outline"
          title={t('vault_backup_shares_title')}
          subtitle={t('vault_backup_shares_sub')}
          done={medium === 'shares'}
          busy={printing}
          onPress={onPrintShares}
        />

        <Text style={[styles.fine, { color: colors.textTertiary }]}>
          {t('vault_backup_either_note')}
        </Text>

        {error && <Text style={[styles.err, { color: colors.error }]}>{error}</Text>}
        <PressableScale
          haptic="confirm"
          onPress={medium ? () => setStep('intro') : undefined}
          style={[
            styles.primary,
            {
              backgroundColor: medium ? colors.accent : colors.backgroundSecondary,
              opacity: medium ? 1 : 0.6
            }
          ]}
        >
          <Text
            style={[
              styles.primaryLabel,
              { color: medium ? colors.textOnAccent : colors.textTertiary }
            ]}
          >
            {t('vault_continue')}
          </Text>
        </PressableScale>
        <PressableScale onPress={onCancel} style={styles.secondary}>
          <Text style={[styles.secondaryLabel, { color: colors.textSecondary }]}>
            {t('vault_cancel')}
          </Text>
        </PressableScale>
      </ScrollView>
    )
  }

  // ── phrase reveal ───────────────────────────────────────────────────
  if (step === 'phrase' && revealed) {
    return (
      <PhraseBackupSheet
        mnemonic={revealed}
        onAttest={async () => {
          await attest('phrase')
          setRevealed(null)
          setStep('backup')
        }}
        onCancel={() => {
          setRevealed(null)
          setStep('backup')
        }}
      />
    )
  }

  // ── intro ───────────────────────────────────────────────────────────
  if (step === 'intro') {
    return (
      <ScrollView contentContainerStyle={styles.body}>
        <MaterialCommunityIcons name="safe" size={48} color={colors.textPrimary} style={styles.hero} />
        <Text style={[styles.h1, { color: colors.textPrimary }]}>{t('vault_enroll_title')}</Text>
        <Text style={[styles.p, { color: colors.textSecondary }]}>{t('vault_enroll_intro')}</Text>

        <TextInput
          style={[
            styles.input,
            { color: colors.textPrimary, backgroundColor: colors.backgroundSecondary }
          ]}
          value={nickname}
          onChangeText={setNickname}
          placeholder={t('vault_nickname_placeholder')}
          placeholderTextColor={colors.textTertiary}
          maxLength={24}
        />

        <RecoveryPaths />

        {error && <Text style={[styles.err, { color: colors.error }]}>{error}</Text>}
        <PressableScale
          haptic="confirm"
          onPress={toPassphrase}
          style={[styles.primary, { backgroundColor: colors.accent }]}
        >
          <Text style={[styles.primaryLabel, { color: colors.textOnAccent }]}>
            {t('vault_continue')}
          </Text>
        </PressableScale>
        <PressableScale onPress={() => setStep('backup')} style={styles.secondary}>
          <Text style={[styles.secondaryLabel, { color: colors.textSecondary }]}>
            {t('vault_back')}
          </Text>
        </PressableScale>
      </ScrollView>
    )
  }

  // ── passphrase ──────────────────────────────────────────────────────
  if (step === 'passphrase') {
    return (
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Text style={[styles.h1, { color: colors.textPrimary }]}>
          {t('vault_passphrase_title')}
        </Text>
        <Text style={[styles.p, { color: colors.textSecondary }]}>
          {t('vault_passphrase_intro')}
        </Text>

        <PassphraseField
          value={passphrase}
          onChangeText={setPassphrase}
          confirm={confirm}
          onChangeConfirm={setConfirm}
          onValidityChange={setPassphraseOk}
        />

        <View style={[styles.warnBox, { borderColor: colors.warning }]}>
          <Ionicons name="warning-outline" size={16} color={colors.warning} />
          <Text style={[styles.warnText, { color: colors.textSecondary }]}>
            {t('vault_passphrase_no_reset')}
          </Text>
        </View>

        {error && <Text style={[styles.err, { color: colors.error }]}>{error}</Text>}
        <PressableScale
          haptic="confirm"
          onPress={passphraseOk ? start : undefined}
          style={[
            styles.primary,
            {
              backgroundColor: passphraseOk ? colors.accent : colors.backgroundSecondary,
              opacity: passphraseOk ? 1 : 0.6
            }
          ]}
        >
          <Text
            style={[
              styles.primaryLabel,
              { color: passphraseOk ? colors.textOnAccent : colors.textTertiary }
            ]}
          >
            {t('vault_enroll_begin')}
          </Text>
        </PressableScale>
        <PressableScale onPress={() => setStep('intro')} style={styles.secondary}>
          <Text style={[styles.secondaryLabel, { color: colors.textSecondary }]}>
            {t('vault_back')}
          </Text>
        </PressableScale>
      </ScrollView>
    )
  }

  // ── running (PIN prompts + tap) ─────────────────────────────────────
  if (step === 'running') {
    return (
      <View style={styles.body}>
        {pinReq ? (
          <>
            <Ionicons name="keypad-outline" size={40} color={colors.textPrimary} style={styles.hero} />
            <Text style={[styles.h1, { color: colors.textPrimary }]}>
              {pinReq.kind === 'change' ? t('vault_set_new_pin') : t('vault_enter_pin')}
            </Text>
            {pinReq.kind === 'change' && (
              <Text style={[styles.p, { color: colors.textSecondary }]}>
                {t('vault_default_pin_warning')}
              </Text>
            )}
            <TextInput
              style={[
                styles.pin,
                { color: colors.textPrimary, backgroundColor: colors.backgroundSecondary }
              ]}
              value={pinReq.kind === 'change' ? newPinInput : pinInput}
              onChangeText={pinReq.kind === 'change' ? setNewPinInput : setPinInput}
              placeholder="••••••"
              placeholderTextColor={colors.textTertiary}
              keyboardType="number-pad"
              secureTextEntry
              maxLength={8}
              autoFocus
            />
            <PressableScale
              haptic="confirm"
              onPress={submitPin}
              style={[styles.primary, { backgroundColor: colors.accent }]}
            >
              <Text style={[styles.primaryLabel, { color: colors.textOnAccent }]}>
                {t('vault_continue')}
              </Text>
            </PressableScale>
          </>
        ) : (
          <>
            <ActivityIndicator color={colors.textPrimary} size="large" style={styles.hero} />
            <Text style={[styles.h1, { color: colors.textPrimary }]}>
              {phaseLabel || t('vault_reading_key')}
            </Text>
            <Text style={[styles.p, { color: colors.textSecondary }]}>
              {t('vault_touch_when_blinks')}
            </Text>
          </>
        )}
      </View>
    )
  }

  return null
}

/** One backup route: tappable, ticks when satisfied, stays tappable after. */
const BackupRow: React.FC<{
  icon: React.ComponentProps<typeof Ionicons>['name']
  title: string
  subtitle: string
  done: boolean
  busy: boolean
  onPress: () => void
}> = ({ icon, title, subtitle, done, busy, onPress }) => {
  const { colors } = useTheme()
  return (
    <PressableScale
      onPress={busy ? undefined : onPress}
      style={[styles.backupRow, { borderColor: done ? colors.success : colors.separator }]}
    >
      {busy ? (
        <ActivityIndicator color={colors.info} size="small" />
      ) : (
        <Ionicons name={icon} size={22} color={done ? colors.success : colors.info} />
      )}
      <View style={styles.backupRowText}>
        <Text style={[styles.backupRowTitle, { color: colors.textPrimary }]}>{title}</Text>
        <Text style={[styles.backupRowSub, { color: colors.textSecondary }]}>{subtitle}</Text>
      </View>
      {done && <Ionicons name="checkmark-circle" size={20} color={colors.success} />}
    </PressableScale>
  )
}

/**
 * The two ways to get vault funds back.
 *
 * Backup shares now split the mnemonic entropy (BRC-157), so paper reaches the
 * phrase path rather than being a dead end — the copy says "phrase or shares"
 * for that reason.
 */
const RecoveryPaths: React.FC = () => {
  const { colors } = useTheme()
  return (
    <View style={[styles.paths, { borderColor: colors.separator }]}>
      <Text style={[styles.pathsTitle, { color: colors.textPrimary }]}>
        {t('vault_recovery_paths_title')}
      </Text>
      <View style={styles.pathRow}>
        <Ionicons name="hardware-chip-outline" size={16} color={colors.textSecondary} />
        <Text style={[styles.pathText, { color: colors.textSecondary }]}>
          {t('vault_recovery_path_device')}
        </Text>
      </View>
      <View style={styles.pathRow}>
        <Ionicons name="document-text-outline" size={16} color={colors.textSecondary} />
        <Text style={[styles.pathText, { color: colors.textSecondary }]}>
          {t('vault_recovery_path_phrase')}
        </Text>
      </View>
      <Text style={[styles.pathsFine, { color: colors.textTertiary }]}>
        {t('vault_recovery_no_other')}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  body: { padding: spacing.xl, gap: spacing.lg },
  hero: { marginTop: spacing.lg, alignSelf: 'center' },
  h1: { ...typography.title2, textAlign: 'center' },
  p: { ...typography.subhead, textAlign: 'center' },
  input: {
    width: '100%',
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    ...typography.body
  },
  pin: {
    width: '70%',
    alignSelf: 'center',
    textAlign: 'center',
    ...typography.title2,
    letterSpacing: 8,
    borderRadius: radii.md,
    paddingVertical: spacing.md
  },
  primary: { width: '100%', borderRadius: radii.md, paddingVertical: spacing.lg, alignItems: 'center' },
  primaryLabel: { ...typography.headline },
  secondary: { paddingVertical: spacing.md, alignItems: 'center' },
  secondaryLabel: { ...typography.body },
  err: { ...typography.footnote, textAlign: 'center' },
  fine: { ...typography.caption2, textAlign: 'center' },
  ghost: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.md
  },
  ghostLabel: { ...typography.footnote, fontWeight: '600' },
  backupRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.lg
  },
  backupRowText: { flex: 1, gap: spacing.xs },
  backupRowTitle: { ...typography.headline },
  backupRowSub: { ...typography.footnote },
  paths: {
    width: '100%',
    gap: spacing.sm,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.lg
  },
  pathsTitle: { ...typography.footnote, fontWeight: '600' },
  pathRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  pathText: { ...typography.footnote, flex: 1 },
  pathsFine: { ...typography.caption2 },
  warnBox: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'flex-start',
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.md
  },
  warnText: { ...typography.footnote, flex: 1 }
})
