import React, { useState, useEffect, useRef, useMemo } from 'react'
import {
  View,
  Text,
  ScrollView,
  TextInput,
  ActivityIndicator,
  TouchableOpacity,
  StyleSheet,
  Linking,
  Platform
} from 'react-native'
import CustomSafeArea from '@bsv/expo-wallet-toolbox/ui/components/ui/CustomSafeArea'
import { router, useLocalSearchParams } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from '@bsv/expo-wallet-toolbox/core/theme/ThemeContext'
import { spacing, radii, typography } from '@bsv/expo-wallet-toolbox/core/theme/tokens'
import { useTranslation } from 'react-i18next'
import { useWallet } from '@bsv/expo-wallet-toolbox/core/context/WalletContext'
import { PrivateKey } from '@bsv/sdk'
import { generateMnemonicWallet, recoverMnemonicWallet, validateMnemonic } from '@bsv/expo-wallet-toolbox/core/mnemonicWallet'
import { backupAttestation, type BackupMedium } from '@bsv/expo-wallet-toolbox/core/services/vault/backupAttestation'
import { printRecoveryShares } from '@bsv/expo-wallet-toolbox/ui/printRecoveryShares'
import * as Clipboard from 'expo-clipboard'
import { Directory } from 'expo-file-system'
import { useLocalStorage } from '@bsv/expo-wallet-toolbox/core/context/LocalStorageProvider'
import { showAlert } from '@bsv/expo-wallet-toolbox/ui/components/ui/AlertCard'
import { showToast } from '@bsv/expo-wallet-toolbox/ui/components/ui/Toast'
import Celebration from '@bsv/expo-wallet-toolbox/ui/components/ui/Celebration'
import PressableScale from '@bsv/expo-wallet-toolbox/ui/components/ui/PressableScale'

type MnemonicMode = 'choose' | 'generate' | 'import'
const HANDWRITTEN_BACKUP_DELAY_MS = 15_000

type BackupSession = { identityKey: string }
type BackupProgress = { session: BackupSession; medium: BackupMedium; attested: boolean }
type BackupMaterial = {
  mnemonic: string | null
  recoveredKeyWif: string | null
  value: string
  identityKey: string
}

export default function MnemonicScreen() {
  const { t } = useTranslation()
  const { colors, isDark } = useTheme()
  const { buildWalletFromMnemonic, buildWalletFromRecoveredKey, rebuildWallet, backupRestore, getBackupRestore, walletBuilt, walletBuilding } =
    useWallet()
  const { setMnemonic: storeMnemonic, createMnemonic, getMnemonic, setRecoveredKey, getRecoveredKey, hasStoredIdentity, secretsReady, unlock } = useLocalStorage()
  const { flow } = useLocalSearchParams<{ flow?: 'backup' | 'import' }>()

  const [mode, setMode] = useState<MnemonicMode>(flow === 'backup' ? 'generate' : flow === 'import' ? 'import' : 'choose')
  const [mnemonic, setMnemonic] = useState<string>('')
  const [importedMnemonic, setImportedMnemonic] = useState<string>('')

  const [confirmationSession, setConfirmationSession] = useState<BackupSession | null>(null)
  const backupProgressRef = useRef<BackupProgress | null>(null)
  const copiedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [loading, setLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [copied, setCopied] = useState(false)
  const [isCopying, setIsCopying] = useState(false)
  const [isPrinting, setIsPrinting] = useState(false)
  const [celebrating, setCelebrating] = useState(false)
  const [hasExistingWallet, setHasExistingWallet] = useState<boolean | null>(null)
  const [backupMaterial, setBackupMaterial] = useState<BackupMaterial | null>(null)
  const [backupReadStatus, setBackupReadStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [backupReadAttempt, setBackupReadAttempt] = useState(0)
  const generatingRef = useRef(false)
  const confirmingRef = useRef(false)
  const exportingRef = useRef(false)
  const flowRef = useRef(flow)
  flowRef.current = flow
  const isCurrentBackupFlow = () => flowRef.current === 'backup'
  const isBackup = flow === 'backup'
  const isRecoveryKey = isBackup && !!backupMaterial?.recoveredKeyWif
  const recoveryValue = isBackup ? backupMaterial?.value ?? '' : mnemonic
  const backupBusy = loading || isPrinting || isSaving || isCopying
  // A new display of saved key material gets its own confirmation window.
  // Time spent migrating, unlocking, or creating an unsaved phrase never counts.
  const backupSession = useMemo<BackupSession | null>(() => {
    if (!secretsReady || !recoveryValue || celebrating ||
      (!isBackup && (mode !== 'generate' || hasExistingWallet !== true))) return null
    return { identityKey: isBackup ? backupMaterial!.identityKey : recoverMnemonicWallet(mnemonic).identityKey }
  }, [flow, isBackup, secretsReady, recoveryValue, celebrating, mode, hasExistingWallet, backupMaterial, mnemonic])
  const backupSessionRef = useRef(backupSession)
  backupSessionRef.current = backupSession
  const confirmationAvailable = backupSession !== null && confirmationSession === backupSession

  useEffect(() => {
    backupSessionRef.current = backupSession
    confirmingRef.current = false
    backupProgressRef.current = null
    setCopied(false)
    if (!backupSession) return
    const timer = setTimeout(() => {
      if (backupSessionRef.current === backupSession) setConfirmationSession(backupSession)
    }, HANDWRITTEN_BACKUP_DELAY_MS)
    return () => {
      clearTimeout(timer)
      if (copiedTimeoutRef.current) clearTimeout(copiedTimeoutRef.current)
      if (backupSessionRef.current === backupSession) backupSessionRef.current = null
    }
  }, [backupSession])

  // Expo Router can reuse this screen when only its flow parameter changes.
  useEffect(() => {
    setMode(flow === 'backup' ? 'generate' : flow === 'import' ? 'import' : 'choose')
    confirmingRef.current = false
    backupProgressRef.current = null
    setCelebrating(false)
  }, [flow])

  // Read the saved identity only after migration. Failed or cancelled unlocks
  // remain in this backup-only screen and can never fall through to creation.
  useEffect(() => {
    let cancelled = false
    setBackupMaterial(null)
    setBackupReadStatus('loading')
    backupProgressRef.current = null
    if (flow !== 'backup' || !secretsReady) return

    const readBackup = async () => {
      try {
        const phrase = await getMnemonic()
        if (cancelled) return
        let material: BackupMaterial
        if (phrase) {
          material = {
            mnemonic: phrase, recoveredKeyWif: null, value: phrase,
            identityKey: recoverMnemonicWallet(phrase).identityKey
          }
        } else {
          const wif = await getRecoveredKey()
          if (cancelled) return
          if (!wif) throw new Error('Recovery material unavailable')
          const key = PrivateKey.fromWif(wif)
          material = {
            mnemonic: null, recoveredKeyWif: wif, value: key.toHex(),
            identityKey: key.toPublicKey().toString()
          }
        }
        setBackupMaterial(material)
        setBackupReadStatus('ready')
      } catch {
        if (!cancelled) setBackupReadStatus('error')
      }
    }
    void readBackup()
    return () => { cancelled = true }
  }, [flow, secretsReady, getMnemonic, getRecoveredKey, backupReadAttempt])

  const handleRetryBackup = async () => {
    setBackupReadStatus('loading')
    try {
      await unlock()
      if (isCurrentBackupFlow()) setBackupReadAttempt(attempt => attempt + 1)
    } catch {
      setBackupReadStatus('error')
    }
  }

  // Existing keys can be present before the wallet manager finishes migrating,
  // unlocking, or building. Check storage before offering a new identity.
  useEffect(() => {
    if (!secretsReady || flow === 'backup') return
    let cancelled = false
    hasStoredIdentity().then(existing => {
      if (!cancelled) setHasExistingWallet(existing)
    }).catch(() => {
      if (!cancelled) {
        showToast('Unable to check existing wallet. Please try again.', { type: 'error' })
        router.back()
      }
    })
    return () => { cancelled = true }
  }, [flow, secretsReady, hasStoredIdentity])

  useEffect(() => {
    if (flow !== 'backup' && mode === 'choose' && hasExistingWallet) router.replace({ pathname: '/auth/mnemonic', params: { flow: 'backup' } })
  }, [flow, mode, hasExistingWallet])

  // Generate a new mnemonic and immediately build the wallet
  const handleGenerateNew = async () => {
    if (isCurrentBackupFlow() || generatingRef.current || !secretsReady || walletBuilding) return
    generatingRef.current = true
    setLoading(true)
    try {
      if (walletBuilt || await hasStoredIdentity()) {
        router.replace({ pathname: '/auth/mnemonic', params: { flow: 'backup' } })
        return
      }
      if (isCurrentBackupFlow()) return
      const wallet = generateMnemonicWallet()

      // Store and build the wallet immediately so it is ready by the time the
      // user finishes the save screen. (Print Recovery Shares no longer needs
      // this — it derives the identity key from the mnemonic itself.)
      console.log('[Mnemonic] Building wallet eagerly after mnemonic generation')
      const stored = await createMnemonic(wallet.mnemonic)
      if (!stored) {
        if (await hasStoredIdentity()) router.replace({ pathname: '/auth/mnemonic', params: { flow: 'backup' } })
        else showToast('Unable to create wallet. Please try again.', { type: 'error' })
        return
      }
      setMnemonic(wallet.mnemonic)
      setMode('generate')
      setHasExistingWallet(true)
      try {
        await backupAttestation.markPending(wallet.identityKey)
      } catch (error) {
        console.warn('[Mnemonic] Could not record pending backup reminder:', error)
      }
      await buildWalletFromMnemonic(wallet.mnemonic)
      console.log('[Mnemonic] Wallet built successfully during generate flow')
    } catch (error: any) {
      console.error('Error generating mnemonic:', error)
      showToast('Failed to generate mnemonic. Please try again.', { type: 'error' })
    } finally {
      generatingRef.current = false
      setLoading(false)
    }
  }

  // Completed exports count as a backup immediately. Platforms that only report
  // opening an export dialog reveal Confirm for the user to attest completion.
  const recordExport = async (session: BackupSession, medium: BackupMedium, attestImmediately = true) => {
    if (backupSessionRef.current !== session) return
    setConfirmationSession(session)
    const progress: BackupProgress = { session, medium, attested: false }
    backupProgressRef.current = progress
    if (!attestImmediately) return
    try {
      await backupAttestation.set(session.identityKey, medium)
      if (backupSessionRef.current === session && backupProgressRef.current === progress) progress.attested = true
    } catch {
      if (backupSessionRef.current === session) {
        showToast('Unable to save backup confirmation. Please try again.', { type: 'error' })
      }
    }
  }

  // Save to a user-selected folder. A dismissed share sheet does not prove a
  // file was saved, so attest only after writing and verifying the actual file.
  const handleSaveMnemonic = async () => {
    if (!backupSession || backupSessionRef.current !== backupSession || backupBusy || confirmingRef.current || exportingRef.current) return
    exportingRef.current = true
    setIsSaving(true)
    let directorySelected = false
    try {
      const directory = await Directory.pickDirectoryAsync()
      if (backupSessionRef.current !== backupSession) return
      directorySelected = true
      const filename = `wallet-recovery-${isRecoveryKey ? 'key' : 'phrase'}-${Date.now()}.txt`
      const file = directory.createFile(filename, 'text/plain')
      file.write(recoveryValue)
      if (await file.text() !== recoveryValue) throw new Error('Recovery file could not be verified')
      await recordExport(backupSession, 'phrase')
    } catch (error) {
      console.info('[Mnemonic] Saving recovery keys did not complete:', error instanceof Error ? error.message : error)
      if (directorySelected && backupSessionRef.current === backupSession) {
        showToast('Unable to save recovery keys. Please try again.', { type: 'error' })
      }
    } finally {
      exportingRef.current = false
      setIsSaving(false)
    }
  }

  const handleCopyMnemonic = async () => {
    if (!backupSession || backupSessionRef.current !== backupSession || backupBusy || confirmingRef.current || exportingRef.current) return
    exportingRef.current = true
    setIsCopying(true)
    try {
      const succeeded = await Clipboard.setStringAsync(recoveryValue)
      if (!succeeded || backupSessionRef.current !== backupSession) return
      setCopied(true)
      showToast('Copied', { type: 'success' })
      if (copiedTimeoutRef.current) clearTimeout(copiedTimeoutRef.current)
      copiedTimeoutRef.current = setTimeout(() => {
        if (backupSessionRef.current === backupSession) setCopied(false)
      }, 3000)
      await recordExport(backupSession, 'phrase')
    } catch (error) {
      console.info('[Mnemonic] Copying recovery keys did not complete:', error instanceof Error ? error.message : error)
    } finally {
      exportingRef.current = false
      setIsCopying(false)
    }
  }

  const handlePrintRecoveryShares = async () => {
    if (!backupSession || backupSessionRef.current !== backupSession || backupBusy || confirmingRef.current || exportingRef.current) return
    exportingRef.current = true
    setIsPrinting(true)
    try {
      const result = await printRecoveryShares({
        mnemonic: isBackup ? backupMaterial!.mnemonic : mnemonic,
        recoveredKeyWif: isBackup ? backupMaterial!.recoveredKeyWif : null,
        // Without this, generatePrintHTML falls back to "your wallet app" and
        // the printed sheet — a permanent offline artefact — never names the
        // app that can actually read it back.
        appName: 'BSV Browser'
      })
      if (backupSessionRef.current !== backupSession) return
      if (!result.ok) {
        showToast(
          result.reason === 'unsupported-word-count'
            ? t('vault_shares_word_count')
            : t('vault_shares_unavailable'),
          { type: 'error' }
        )
      } else {
        // Android resolves when the print dialog opens, so Confirm must attest
        // that printing completed. iOS reports completion or cancellation.
        await recordExport(backupSession, 'shares', Platform.OS !== 'android')
      }
    } catch (error: any) {
      console.info('[Mnemonic] Print recovery shares did not complete:', error?.message)
    } finally {
      exportingRef.current = false
      setIsPrinting(false)
    }
  }

  // Handwritten backups become eligible after the delay; elapsed time alone
  // never marks a wallet backed up. Export attestations need no duplicate write.
  const handleConfirmBackup = async () => {
    if (!backupSession || backupSessionRef.current !== backupSession || !confirmationAvailable || backupBusy || confirmingRef.current || exportingRef.current || flowRef.current !== flow) return
    confirmingRef.current = true
    setLoading(true)
    try {
      const progress = backupProgressRef.current?.session === backupSession ? backupProgressRef.current : null
      if (!progress?.attested) {
        const medium = progress?.medium ?? 'phrase'
        await backupAttestation.set(backupSession.identityKey, medium)
        if (backupSessionRef.current !== backupSession) return
        backupProgressRef.current = { session: backupSession, medium, attested: true }
      }
      if (backupSessionRef.current !== backupSession) return
      if (isBackup) {
        showToast('Backup confirmed', { type: 'success' })
        router.back()
      }
      else setCelebrating(true)
    } catch {
      confirmingRef.current = false
      if (backupSessionRef.current === backupSession) {
        showToast('Unable to save backup confirmation. Please try again.', { type: 'error' })
      }
    } finally {
      setLoading(false)
    }
  }

  // Validate and continue with imported mnemonic or hex private key
  const handleContinueWithImported = async () => {
    if (isCurrentBackupFlow()) return
    const trimmed = importedMnemonic.trim()

    // Detect 64-char hex string as a raw private key
    if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
      setLoading(true)
      try {
        const importedKey = PrivateKey.fromHex(trimmed)
        const wif = importedKey.toWif()
        // Computed directly from the key, not through the wallet: recording
        // this depended on the just-(re)built wallet's permissions manager
        // resolving getPublicKey, which is only ready once the build (and any
        // backup replay inside it) fully settles — an async chain with too
        // many places to silently miss. The identity key is exactly this
        // key's public key regardless, so write it before the wallet exists
        // at all.
        const identityKey = importedKey.toPublicKey().toString()
        const stored = await setRecoveredKey(wif)
        if (!stored) {
          const choice = await showAlert({
            title: 'Biometric Access Required',
            message: 'Biometric access is needed to protect your wallet keys. Please try again.',
            buttons: [
              { text: 'Cancel', style: 'cancel', key: 'cancel' },
              { text: 'Try Again', key: 'retry' },
            ],
          })
          if (choice === 'retry') await handleContinueWithImported()
          return
        }
        if (walletBuilt) {
          // Replacing the auto-created wallet from onboarding's backup
          // reminder — buildWalletFromRecoveredKey no-ops once a wallet is
          // already built, so tear it down and re-trigger the build instead.
          await rebuildWallet({ restoreFromBackup: true })
        } else {
          await buildWalletFromRecoveredKey(wif, { restoreFromBackup: true })
        }
        if (await handledRestoreFailure(() => handleContinueWithImported())) return
        // An imported key is, by definition, already backed up — the user just
        // proved they hold it. Recording this here means the reminder never
        // nags someone who imported instead of generating.
        await backupAttestation.set(identityKey, 'phrase')
        setCelebrating(true)
      } catch (error: any) {
        console.error('[Mnemonic] Error importing hex key:', error)
        showToast(`Invalid private key: ${error.message}`, { type: 'error' })
      } finally {
        setLoading(false)
      }
      return
    }

    if (!validateMnemonic(trimmed)) {
      await showAlert({
        title: 'Invalid Input',
        message: 'Please enter a valid recovery phrase (12–24 words) or a 64-character hex private key.',
      })
      return
    }

    await initializeWallet(trimmed, { restore: true })
  }

  /**
   * Deal with an import whose backup replay failed.
   *
   * Returns true when the failure was handled and the caller must NOT proceed to the
   * celebration: the wallet was deliberately not built, because a half-replayed database
   * presented as a working wallet is the one outcome worth blocking. `retry` re-runs the
   * same import; the alternative rebuilds without a restore, which yields a usable wallet
   * with no history.
   *
   * Reads getBackupRestore() rather than the `backupRestore` render value: this runs
   * immediately after the build's own await, where the captured value is still the
   * pre-build one.
   */
  const handledRestoreFailure = async (retry: () => Promise<void>): Promise<boolean> => {
    const state = getBackupRestore()
    if (state.phase !== 'failed') return false

    setLoading(false)
    const choice = await showAlert({
      title: t('restore_backup_failed_title'),
      message: `${t('restore_backup_failed_message')}${state.error ? `\n\n${state.error}` : ''}`,
      buttons: [
        { text: t('restore_backup_retry'), key: 'retry' },
        // Destructive, not cancel: abandoning the history forfeits past change
        // outputs whose derivation data only existed in the backup.
        { text: t('restore_backup_skip'), key: 'skip', style: 'destructive' }
      ]
    })

    if (choice === 'retry') {
      await retry()
      return true
    }

    // Without a restore: a working wallet, no past transactions, and past change outputs
    // that stay unspendable because their derivation data only ever existed in the backup.
    const trimmed = importedMnemonic.trim()
    if (validateMnemonic(trimmed)) await initializeWallet(trimmed, { restore: false })
    return true
  }

  // Initialize wallet with mnemonic
  const initializeWallet = async (mnemonicPhrase: string, opts?: { restore?: boolean }) => {
    if (isCurrentBackupFlow()) return
    setLoading(true)
    try {
      console.log('[Mnemonic] Starting wallet initialization with mnemonic')
      const stored = await storeMnemonic(mnemonicPhrase)
      if (!stored) {
        const choice = await showAlert({
          title: 'Biometric Access Required',
          message: 'Biometric access is needed to protect your wallet keys. Please try again.',
          buttons: [
            { text: 'Cancel', style: 'cancel', key: 'cancel' },
            { text: 'Try Again', key: 'retry' },
          ],
        })
        if (choice === 'retry') await initializeWallet(mnemonicPhrase, opts)
        return
      }
      // An imported phrase replays the encrypted backup log BEFORE the wallet becomes
      // usable — the phrase alone cannot rebuild change-output derivation data. A freshly
      // generated wallet passes no options and skips this entirely, since there is
      // nothing on the server under a brand-new seed.
      if (walletBuilt) {
        // Replacing the auto-created wallet from onboarding's backup reminder —
        // buildWalletFromMnemonic no-ops once a wallet is already built, so tear
        // it down and re-trigger the build instead.
        await rebuildWallet({ restoreFromBackup: opts?.restore === true })
      } else {
        await buildWalletFromMnemonic(mnemonicPhrase, { restoreFromBackup: opts?.restore === true })
      }
      if (opts?.restore === true && (await handledRestoreFailure(() => initializeWallet(mnemonicPhrase, opts)))) {
        return
      }
      // initializeWallet is only ever reached via the import path — an imported
      // phrase is by definition already backed up, so record it and skip the
      // nag. Computed directly from the phrase (recoverMnemonicWallet already
      // derives it) rather than through the wallet's getPublicKey — that
      // depended on the just-(re)built wallet's permissions manager being
      // ready, an async chain (rebuild → auto-build effect → possible backup
      // replay) with too many places to silently miss.
      await backupAttestation.set(recoverMnemonicWallet(mnemonicPhrase).identityKey, 'phrase')
      setCelebrating(true)
    } catch (error: any) {
      console.error('[Mnemonic] Error setting up wallet:', error)
      showToast(`Failed to set up wallet: ${error.message}`, { type: 'error' })
    } finally {
      setLoading(false)
    }
  }

  const backupBackHeader = (
    <View style={s.backupHeader}>
      <TouchableOpacity
        style={s.backButton}
        onPress={() => router.back()}
        accessibilityRole="button"
        accessibilityLabel={t('go_back')}
      >
        <Ionicons name="chevron-back" size={24} color={colors.textSecondary} />
      </TouchableOpacity>
    </View>
  )

  if (isBackup && (!secretsReady || backupReadStatus !== 'ready' || !backupMaterial)) {
    return (
      <CustomSafeArea style={[s.screen, { backgroundColor: colors.background }]}>
        {backupBackHeader}
        <View style={s.centeredContent}>
          {backupReadStatus === 'error' ? (
            <>
              <Text style={[s.bodyText, { color: colors.textPrimary }]}>
                Unable to access wallet keys. Unlock your wallet and try again.
              </Text>
              <PressableScale onPress={handleRetryBackup} style={s.textButton} haptic="tap">
                <Text style={[s.textButtonLabel, { color: colors.accent }]}>{t('retry')}</Text>
              </PressableScale>
            </>
          ) : <ActivityIndicator />}
        </View>
      </CustomSafeArea>
    )
  }

  if (!isBackup && (!secretsReady || hasExistingWallet === null || (mode === 'choose' && hasExistingWallet))) {
    return <CustomSafeArea style={[s.screen, { backgroundColor: colors.background }]}><ActivityIndicator /></CustomSafeArea>
  }

  // ─── Celebration overlay (wallet created) ────────────────────────────
  if (celebrating && !isBackup) {
    return (
      <View style={[s.screen, s.celebrationScreen, { backgroundColor: colors.background }]}>
        <StatusBar style={isDark ? 'light' : 'dark'} />
        <Celebration
          onDone={() => {
            // dismissAll() returns to the existing root /index (Browser). Do NOT push('/')
            // after — that mounts a SECOND Browser on top, leaking a duplicate that
            // re-renders forever (2x JS work on every nav/SSE tick).
            router.dismissAll()
          }}
        />
      </View>
    )
  }

  // ─── Choose mode ──────────────────────────────────────────────────────
  if (!isBackup && mode === 'choose') {
    return (
      <CustomSafeArea style={[s.screen, { backgroundColor: colors.background }]}>
        <StatusBar style={isDark ? 'light' : 'dark'} />
        <View style={s.centeredContent}>
          {/* Hero icon */}
          <View style={[s.heroIcon, { backgroundColor: colors.fillTertiary }]}>
            <Ionicons name="key-outline" size={40} color={colors.accent} />
          </View>

          <Text style={[s.largeTitle, { color: colors.textPrimary }]}>{t('wallet_data')}</Text>
          <Text style={[s.subtitle, { color: colors.textSecondary }]}>
            Your keys and transactions are stored on this device{' '}
            <Text style={{ fontWeight: 'bold', fontStyle: 'italic' }}>only</Text>. Expect occasional loss.{'\n\n'}
            Designed for p2p electronic cash.{'\n'}
            <Text style={{ fontWeight: 'bold' }}>Not life savings</Text>.
          </Text>

          {/* Actions */}
          <View style={s.actionArea}>
            <PressableScale
              style={[s.primaryButton, { backgroundColor: colors.accent }]}
              onPress={handleGenerateNew}
              disabled={loading || walletBuilding}
              haptic="confirm"
            >
              <Ionicons name="add-circle-outline" size={22} color={colors.textOnAccent} style={s.btnIcon} />
              <View style={s.btnTextGroup}>
                <Text style={[s.btnLabel, { color: colors.textOnAccent }]}>{t('create_new_wallet')}</Text>
                <Text style={[s.btnCaption, { color: colors.textOnAccent, opacity: 0.75 }]}>
                  {t('generate_recovery_phrase_caption')}
                </Text>
              </View>
            </PressableScale>

            <PressableScale
              style={[
                s.secondaryButton,
                {
                  backgroundColor: colors.fillTertiary,
                  borderColor: colors.separator
                }
              ]}
              onPress={() => setMode('import')}
              haptic="tap"
            >
              <Ionicons name="download-outline" size={22} color={colors.accent} style={s.btnIcon} />
              <View style={s.btnTextGroup}>
                <Text style={[s.btnLabel, { color: colors.textPrimary }]}>{t('import_existing_wallet')}</Text>
                <Text style={[s.btnCaption, { color: colors.textSecondary }]}>{t('paste_recovery_phrase')}</Text>
              </View>
            </PressableScale>
          </View>

          {/* Legal disclaimer */}
          <Text style={[s.legalText, { color: colors.textTertiary }]}>
            By continuing, you agree to our{' '}
            <Text
              style={[s.legalLink, { color: colors.textTertiary }]}
              onPress={() => Linking.openURL('https://mobile.bsvb.tech/privacy.html')}
            >
              privacy
            </Text>{' '}
            and{' '}
            <Text
              style={[s.legalLink, { color: colors.textTertiary }]}
              onPress={() => Linking.openURL('https://mobile.bsvb.tech/usage.html')}
            >
              usage
            </Text>{' '}
            policies.
          </Text>

          {/* Cancel */}
          <PressableScale style={s.textButton} onPress={() => router.back()} haptic="tap">
            <Text style={[s.textButtonLabel, { color: colors.textSecondary }]}>{t('cancel')}</Text>
          </PressableScale>
        </View>
      </CustomSafeArea>
    )
  }

  // ─── Generate mode ────────────────────────────────────────────────────
  if (isBackup || mode === 'generate') {
    return (
      <CustomSafeArea style={[s.screen, { backgroundColor: colors.background }]}>
        <StatusBar style={isDark ? 'light' : 'dark'} />
        {backupBackHeader}
        <ScrollView contentContainerStyle={[s.scrollContent, s.backupScrollContent]} showsVerticalScrollIndicator={false}>
          <Text style={[s.largeTitle, { color: colors.textPrimary, textAlign: 'left', marginTop: spacing.xl }]}>
            {isRecoveryKey ? t('save_recovery_phrase_heading') : 'Save these words'}
          </Text>

          {/* Mnemonic display — compact selectable block. Page-ground fill with
              a warning-colored border rather than the ordinary card styling:
              this is the one block of content the user actually has to act on,
              so it needs to read as distinct from the surrounding chrome, not
              blend into it. Carries the warning weight that a separate banner
              above the phrase used to. */}
          <View
            style={[
              s.mnemonicDisplay,
              {
                backgroundColor: colors.background,
                borderColor: colors.warning,
                borderWidth: 2
              }
            ]}
          >
            <Text style={[s.mnemonicDisplayText, { color: colors.textPrimary }]} selectable>
              {recoveryValue}
            </Text>
          </View>

          {/* Action buttons */}
          <View style={s.generateActions}>
            <View style={s.inlineButtonRow}>
              <PressableScale
                style={[s.inlineButton, { backgroundColor: colors.accent }]}
                onPress={handleSaveMnemonic}
                disabled={backupBusy}
                haptic="confirm"
              >
                <Ionicons name="share-outline" size={20} color={colors.textOnAccent} style={s.btnIcon} />
                <Text style={[s.btnLabel, { color: colors.textOnAccent }]}>{t('save')}</Text>
              </PressableScale>

              <PressableScale
                style={[s.inlineButton, { backgroundColor: colors.fillTertiary }]}
                onPress={handleCopyMnemonic}
                disabled={backupBusy}
                haptic="tap"
              >
                <Ionicons
                  name={copied ? 'checkmark' : 'copy-outline'}
                  size={20}
                  color={colors.accent}
                  style={s.btnIcon}
                />
                <Text style={[s.btnLabel, { color: colors.accent }]}>{copied ? t('copied') : t('copy')}</Text>
              </PressableScale>
            </View>

            {/* Print recovery shares is a distinct backup medium, not a step
                in saving the words above — a divider keeps it from reading
                as part of the same action. */}
            <View style={[s.divider, { backgroundColor: colors.separator }]} />

            <Text style={[s.printSectionTitle, { color: colors.textPrimary }]}>Distribute shares</Text>
            <Text style={[s.printExplainer, { color: colors.textSecondary }]}>
              Any 2 of the 3 pages can be used to recover your wallet.
            </Text>

            <PressableScale
              style={[s.primaryButton, { backgroundColor: colors.warning }]}
              onPress={handlePrintRecoveryShares}
              disabled={backupBusy}
              haptic="confirm"
            >
              {isPrinting ? (
                <ActivityIndicator color={colors.textOnAccent} style={s.btnIcon} />
              ) : (
                <Ionicons name="print-outline" size={20} color={colors.textOnAccent} style={s.btnIcon} />
              )}
              <Text style={[s.btnLabel, { color: colors.textOnAccent }]}>{t('print_recovery_shares')}</Text>
            </PressableScale>
          </View>

          {confirmationAvailable && (
            <View testID="backup-confirmation-section">
              <View testID="backup-confirmation-divider" style={[s.divider, { backgroundColor: colors.separator }]} />

              <Text style={[s.bodyText, { color: colors.textSecondary, textAlign: 'center', marginBottom: spacing.md }]}>
                Confirm that you have saved your recovery keys somewhere safe.
              </Text>

              {/* Confirm is the explicit backup acknowledgment, including handwritten copies. */}
              <PressableScale
                style={[
                  s.primaryButton,
                  s.confirmButton,
                  {
                    borderColor: colors.accent,
                    opacity: backupBusy || !recoveryValue ? 0.6 : 1
                  }
                ]}
                onPress={handleConfirmBackup}
                disabled={backupBusy || !recoveryValue}
                accessibilityRole="button"
                accessibilityLabel={t('confirm', { defaultValue: 'Confirm' })}
                accessibilityState={{ disabled: backupBusy || !recoveryValue, busy: backupBusy }}
                haptic="confirm"
              >
                {loading ? (
                  <ActivityIndicator color={colors.accent} />
                ) : (
                  <Text style={[s.btnLabel, { color: colors.accent }]}>
                    {t('confirm', { defaultValue: 'Confirm' })}
                  </Text>
                )}
              </PressableScale>
            </View>
          )}
        </ScrollView>
      </CustomSafeArea>
    )
  }

  // ─── Import mode ──────────────────────────────────────────────────────
  return (
    <CustomSafeArea style={[s.screen, { backgroundColor: colors.background }]}>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <ScrollView
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* Hero icon */}
        <View style={[s.heroIcon, { backgroundColor: colors.fillTertiary, alignSelf: 'flex-start' }]}>
          <Ionicons name="download-outline" size={36} color={colors.accent} />
        </View>

        <Text style={[s.largeTitle, { color: colors.textPrimary, textAlign: 'left' }]}>{t('import_wallet')}</Text>
        <Text style={[s.bodyText, { color: colors.textSecondary, marginBottom: spacing.xxl }]}>
          {t('restore_wallet_description')}
        </Text>

        <TextInput
          style={[
            s.mnemonicInput,
            {
              backgroundColor: colors.fillTertiary,
              borderColor: colors.separator,
              color: colors.textPrimary
            }
          ]}
          value={importedMnemonic}
          onChangeText={setImportedMnemonic}
          placeholder={t('enter_recovery_words')}
          placeholderTextColor={colors.textTertiary}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          textAlignVertical="top"
        />

        <PressableScale
          style={[
            s.primaryButton,
            {
              backgroundColor: importedMnemonic.trim() ? colors.accent : colors.fillSecondary,
              opacity: loading ? 0.6 : 1,
              marginTop: spacing.xxl
            }
          ]}
          onPress={handleContinueWithImported}
          disabled={!importedMnemonic.trim() || loading}
          haptic="confirm"
        >
          {loading ? (
            <ActivityIndicator color={colors.textOnAccent} />
          ) : (
            <Text
              style={[
                s.btnLabel,
                {
                  color: importedMnemonic.trim() ? colors.textOnAccent : colors.textTertiary
                }
              ]}
            >
              {t('import_wallet')}
            </Text>
          )}
        </PressableScale>

        {/* Restore progress. The import blocks on replaying the encrypted backup log, and
            a large history takes many chunks — a bare spinner would read as a hang. */}
        {(backupRestore.phase === 'checking' || backupRestore.phase === 'restoring') && (
          <Text
            style={[s.bodyText, { color: colors.textSecondary, marginTop: spacing.md, textAlign: 'center' }]}
          >
            {backupRestore.phase === 'checking' || backupRestore.total === 0
              ? t('restore_backup_checking')
              : t('restore_backup_progress', {
                  chunks: backupRestore.chunks,
                  total: backupRestore.total
                })}
          </Text>
        )}

        {/* ── Divider ── */}
        <View style={[s.orDivider, { marginTop: spacing.xl }]}>
          <View style={[s.orDividerLine, { backgroundColor: colors.separator }]} />
          <Text style={[s.orDividerText, { color: colors.textTertiary }]}>{t('or')}</Text>
          <View style={[s.orDividerLine, { backgroundColor: colors.separator }]} />
        </View>

        {/* ── Scan Backup Shares ── */}
        <PressableScale
          style={[
            s.secondaryButton,
            {
              backgroundColor: colors.fillTertiary,
              borderColor: colors.separator,
              marginTop: spacing.xl
            }
          ]}
          onPress={() => router.push('/auth/scan-shares')}
          haptic="tap"
        >
          <Ionicons name="scan-outline" size={22} color={colors.accent} style={s.btnIcon} />
          <View style={s.btnTextGroup}>
            <Text style={[s.btnLabel, { color: colors.textPrimary }]}>{t('scan_backup_shares')}</Text>
            <Text style={[s.btnCaption, { color: colors.textSecondary }]}>{t('scan_backup_shares_caption')}</Text>
          </View>
        </PressableScale>

        <PressableScale style={s.textButton} onPress={() => flow === 'import' ? router.back() : setMode('choose')} haptic="tap">
          <Text style={[s.textButtonLabel, { color: colors.textSecondary }]}>Go Back</Text>
        </PressableScale>
      </ScrollView>
    </CustomSafeArea>
  )
}

// ─── Static Styles ────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  screen: {
    flex: 1
  },
  celebrationScreen: {
    alignItems: 'center',
    justifyContent: 'center'
  },

  backupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.md
  },
  backButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center'
  },
  backupScrollContent: {
    paddingTop: spacing.md
  },

  // Centered layout for the choose screen
  centeredContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.xxxl
  },

  // Scrollable layout for generate / import
  scrollContent: {
    paddingHorizontal: spacing.xxl,
    paddingTop: spacing.xxxl + spacing.xl,
    paddingBottom: 60
  },

  // ─── Hero icon ──────────────────────────────────────────────────────
  heroIcon: {
    width: 80,
    height: 80,
    borderRadius: radii.xl,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: spacing.xxl
  },

  // ─── Typography ─────────────────────────────────────────────────────
  largeTitle: {
    ...typography.largeTitle,
    marginBottom: spacing.md,
    textAlign: 'center',
    marginTop: spacing.xl
  },
  subtitle: {
    ...typography.subhead,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: spacing.xxxl + spacing.sm
  },
  bodyText: {
    ...typography.body,
    lineHeight: 24
  },

  // ─── Mnemonic display ──────────────────────────────────────────────
  mnemonicDisplay: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    padding: spacing.lg,
    marginBottom: spacing.xxl
  },
  mnemonicDisplayText: {
    ...typography.callout,
    fontFamily: 'monospace',
    lineHeight: 24,
    textAlign: 'center'
  },

  // ─── Buttons ────────────────────────────────────────────────────────
  actionArea: {
    width: '100%',
    gap: spacing.md,
    marginBottom: spacing.xxl
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.xl,
    borderRadius: radii.lg,
    minHeight: 50
  },
  secondaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.xl,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    minHeight: 50
  },
  tertiaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.xl,
    borderRadius: radii.md,
    minHeight: 50
  },
  generateActions: {
    gap: spacing.sm,
    marginBottom: spacing.xxl
  },
  inlineButtonRow: {
    flexDirection: 'row',
    gap: spacing.sm
  },
  inlineButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.md,
    borderRadius: radii.lg,
    minHeight: 50
  },
  btnIcon: {
    marginRight: spacing.sm
  },
  btnTextGroup: {
    flex: 1
  },
  btnLabel: {
    ...typography.headline
  },
  btnCaption: {
    ...typography.footnote,
    marginTop: 2
  },
  legalText: {
    ...typography.caption2,
    textAlign: 'center',
    lineHeight: 16
  },
  legalLink: {
    ...typography.caption2,
    textDecorationLine: 'underline'
  },
  textButton: {
    alignSelf: 'center',
    marginTop: spacing.md,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.xl
  },
  textButtonLabel: {
    ...typography.subhead
  },

  confirmButton: {
    borderWidth: 2
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginVertical: 20
  },
  printSectionTitle: {
    ...typography.largeTitle
  },
  printExplainer: {
    ...typography.footnote,
    lineHeight: 18,
    marginBottom: spacing.xs
  },

  // ─── Import text input ─────────────────────────────────────────────
  mnemonicInput: {
    ...typography.body,
    minHeight: 140,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    padding: spacing.lg,
    paddingTop: spacing.lg,
    lineHeight: 26
  },

  // ─── Or divider ───────────────────────────────────────────────────
  orDivider: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%'
  },
  orDividerLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth
  },
  orDividerText: {
    ...typography.footnote,
    marginHorizontal: spacing.md,
    textTransform: 'uppercase'
  }
})
