import React, { useState, useEffect } from 'react'
import {
  View,
  Text,
  ScrollView,
  TextInput,
  ActivityIndicator,
  StyleSheet,
  Linking
} from 'react-native'
import CustomSafeArea from '@/components/ui/CustomSafeArea'
import { router } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, radii, typography } from '@/context/theme/tokens'
import { useTranslation } from 'react-i18next'
import { useWallet } from '@/context/WalletContext'
import { PrivateKey } from '@bsv/sdk'
import { generateMnemonicWallet, validateMnemonic, recoverMnemonicWallet } from '@/utils/mnemonicWallet'
import { generateBackupShares, generatePrintHTML } from '@/utils/backupShares'
import { copySecretToClipboard } from '@/utils/secureClipboard'
import * as Print from 'expo-print'
import { Paths, File as ExpoFile } from 'expo-file-system'
import * as Sharing from 'expo-sharing'
import { useLocalStorage } from '@/context/LocalStorageProvider'
import { showAlert } from '@/components/ui/AlertCard'
import { showToast } from '@/components/ui/Toast'
import Celebration from '@/components/ui/Celebration'
import PressableScale from '@/components/ui/PressableScale'

type MnemonicMode = 'choose' | 'generate' | 'import'

export default function MnemonicScreen() {
  const { t } = useTranslation()
  const { colors, isDark } = useTheme()
  const { buildWalletFromMnemonic, buildWalletFromRecoveredKey, managers, adminOriginator } = useWallet()
  const { setMnemonic: storeMnemonic, setRecoveredKey } = useLocalStorage()

  const [mode, setMode] = useState<MnemonicMode>('choose')
  const [mnemonic, setMnemonic] = useState<string>('')
  const [importedMnemonic, setImportedMnemonic] = useState<string>('')

  const [hasAcknowledged, setHasAcknowledged] = useState(false)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [isPrinting, setIsPrinting] = useState(false)
  const [identityKey, setIdentityKey] = useState('')
  const [celebrating, setCelebrating] = useState(false)

  // Fetch identity key (needed for print recovery shares)
  useEffect(() => {
    managers?.permissionsManager
      ?.getPublicKey({ identityKey: true }, adminOriginator)
      .then(r => r && setIdentityKey(r.publicKey))
  }, [managers, adminOriginator])

  // Generate a new mnemonic and immediately build the wallet
  const handleGenerateNew = async () => {
    try {
      const wallet = generateMnemonicWallet()
      setMnemonic(wallet.mnemonic)
      setMode('generate')

      // Store and build the wallet immediately so that managers/identityKey
      // are available for Print Recovery Shares on the save screen.
      console.log('[Mnemonic] Building wallet eagerly after mnemonic generation')
      const stored = await storeMnemonic(wallet.mnemonic)
      if (!stored) {
        const choice = await showAlert({
          title: 'Biometric Access Required',
          message: 'Biometric access is needed to protect your wallet keys. Please try again.',
          buttons: [
            { text: 'Cancel', style: 'cancel', key: 'cancel' },
            { text: 'Try Again', key: 'retry' },
          ],
        })
        if (choice === 'cancel') setMode('choose')
        else handleGenerateNew()
        return
      }
      await buildWalletFromMnemonic(wallet.mnemonic)
      console.log('[Mnemonic] Wallet built successfully during generate flow')
    } catch (error: any) {
      console.error('Error generating mnemonic:', error)
      showToast('Failed to generate mnemonic. Please try again.', { type: 'error' })
    }
  }

  // Share mnemonic as text file via system share dialog
  const handleShareMnemonic = async () => {
    const timestamp = Math.floor(Date.now() / 1000)
    const filename = `wallet-recovery-phrase-${timestamp}.txt`
    const file = new ExpoFile(Paths.cache, filename)
    try {
      file.write(mnemonic)
      await Sharing.shareAsync(file.uri, {
        mimeType: 'text/plain',
        UTI: 'public.plain-text',
        dialogTitle: 'Save Your Recovery Phrase'
      })
      setHasAcknowledged(true)
    } catch (error) {
      console.error('Error sharing mnemonic:', error)
    } finally {
      if (file.exists) {
        file.delete()
      }
    }
  }

  // Copy mnemonic to clipboard
  const handleCopyMnemonic = async () => {
    await copySecretToClipboard(mnemonic)
    showToast(t('clipboard_will_clear'), { type: 'success' })
    setCopied(true)
    setTimeout(() => {
      setCopied(false)
      setHasAcknowledged(true)
    }, 3000)
  }

  // Print recovery shares (same as Settings page)
  const handlePrintRecoveryShares = async () => {
    if (isPrinting) return
    setIsPrinting(true)
    try {
      const { primaryKey } = recoverMnemonicWallet(mnemonic)
      const shares = generateBackupShares(primaryKey)
      const html = await generatePrintHTML(shares, identityKey)
      await Print.printAsync({ html })
      setHasAcknowledged(true)
    } catch (error: any) {
      console.info('[Mnemonic] Print recovery shares did not complete:', error?.message)
    } finally {
      setIsPrinting(false)
    }
  }

  // Continue with generated mnemonic after acknowledgment
  // Wallet was already built in handleGenerateNew, so just navigate.
  const handleContinueWithGenerated = () => {
    if (!hasAcknowledged) return
    setCelebrating(true)
  }

  // Validate and continue with imported mnemonic or hex private key
  const handleContinueWithImported = async () => {
    const trimmed = importedMnemonic.trim()

    // Detect 64-char hex string as a raw private key
    if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
      setLoading(true)
      try {
        const wif = PrivateKey.fromHex(trimmed).toWif()
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
        await buildWalletFromRecoveredKey(wif)
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

    await initializeWallet(trimmed)
  }

  // Initialize wallet with mnemonic
  const initializeWallet = async (mnemonicPhrase: string) => {
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
        if (choice === 'retry') await initializeWallet(mnemonicPhrase)
        return
      }
      await buildWalletFromMnemonic(mnemonicPhrase)
      setCelebrating(true)
    } catch (error: any) {
      console.error('[Mnemonic] Error setting up wallet:', error)
      showToast(`Failed to set up wallet: ${error.message}`, { type: 'error' })
    } finally {
      setLoading(false)
    }
  }

  // ─── Celebration overlay (wallet created) ────────────────────────────
  if (celebrating) {
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
  if (mode === 'choose') {
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
  if (mode === 'generate') {
    return (
      <CustomSafeArea style={[s.screen, { backgroundColor: colors.background }]}>
        <StatusBar style={isDark ? 'light' : 'dark'} />
        <ScrollView contentContainerStyle={s.scrollContent} showsVerticalScrollIndicator={false}>
          <Text style={[s.largeTitle, { color: colors.textPrimary, textAlign: 'left' }]}>
            {t('save_recovery_phrase_heading')}
          </Text>
          <Text style={[s.sectionSubtitle, { color: colors.textSecondary }]}>
            Write down these words in order and keep them somewhere safe.
          </Text>

          {/* Warning banner */}
          <View
            style={[
              s.warningBanner,
              {
                backgroundColor: isDark ? 'rgba(255, 69, 58, 0.12)' : 'rgba(255, 59, 48, 0.08)',
                borderColor: isDark ? 'rgba(255, 69, 58, 0.25)' : 'rgba(255, 59, 48, 0.2)'
              }
            ]}
          >
            <Ionicons
              name="shield-checkmark-outline"
              size={22}
              color={colors.error}
              style={{ marginRight: spacing.md }}
            />
            <Text style={[s.warningText, { color: colors.textPrimary }]}>
              Write down these 12 words. This is the <Text style={{ fontWeight: '700' }}>only way</Text> to recover your
              wallet.
            </Text>
          </View>

          {/* Mnemonic display — compact selectable block */}
          <View
            style={[
              s.mnemonicDisplay,
              {
                backgroundColor: colors.fillTertiary,
                borderColor: colors.separator
              }
            ]}
          >
            <Text style={[s.mnemonicDisplayText, { color: colors.textPrimary }]} selectable>
              {mnemonic}
            </Text>
          </View>

          {/* Action buttons */}
          <View style={s.generateActions}>
            <View style={s.inlineButtonRow}>
              <PressableScale
                style={[s.inlineButton, { backgroundColor: colors.accent }]}
                onPress={handleShareMnemonic}
                haptic="confirm"
              >
                <Ionicons name="share-outline" size={20} color={colors.textOnAccent} style={s.btnIcon} />
                <Text style={[s.btnLabel, { color: colors.textOnAccent }]}>{t('save')}</Text>
              </PressableScale>

              <PressableScale
                style={[s.inlineButton, { backgroundColor: colors.fillTertiary }]}
                onPress={handleCopyMnemonic}
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

            <PressableScale
              style={[s.primaryButton, { backgroundColor: colors.info }]}
              onPress={handlePrintRecoveryShares}
              disabled={isPrinting}
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

          {/* Biometric protection note */}
          <View style={[s.biometricNote, { backgroundColor: colors.fillTertiary, borderColor: colors.separator }]}>
            <Ionicons name="finger-print" size={32} color={colors.textSecondary} style={s.biometricIcon} />
            <Text style={[s.biometricText, { color: colors.textSecondary }]}>
              Your recovery phrase is protected by Face ID / device biometrics.
            </Text>
          </View>

          {/* Acknowledgment */}
          <PressableScale
            style={[
              s.acknowledgment,
              {
                backgroundColor: hasAcknowledged
                  ? isDark
                    ? 'rgba(10, 132, 255, 0.1)'
                    : 'rgba(0, 122, 255, 0.06)'
                  : colors.fillTertiary,
                borderColor: hasAcknowledged ? colors.accent : colors.separator
              }
            ]}
            onPress={() => setHasAcknowledged(!hasAcknowledged)}
            haptic="tap"
          >
            <Ionicons
              name={hasAcknowledged ? 'checkmark-circle' : 'ellipse-outline'}
              size={24}
              color={hasAcknowledged ? colors.accent : colors.textTertiary}
              style={{ marginRight: spacing.md }}
            />
            <Text style={[s.acknowledgmentText, { color: colors.textPrimary }]}>{t('acknowledgment_text')}</Text>
          </PressableScale>

          {/* Continue */}
          <PressableScale
            style={[
              s.primaryButton,
              {
                backgroundColor: hasAcknowledged ? colors.accent : colors.fillSecondary,
                opacity: loading ? 0.6 : 1
              }
            ]}
            onPress={handleContinueWithGenerated}
            disabled={!hasAcknowledged || loading}
            haptic="confirm"
          >
            {loading ? (
              <ActivityIndicator color={colors.textOnAccent} />
            ) : (
              <Text
                style={[
                  s.btnLabel,
                  {
                    color: hasAcknowledged ? colors.textOnAccent : colors.textTertiary
                  }
                ]}
              >
                {t('continue')}
              </Text>
            )}
          </PressableScale>

          {/* Back link */}
          <PressableScale
            style={s.textButton}
            onPress={() => {
              setMode('choose')
              setHasAcknowledged(false)
            }}
            haptic="tap"
          >
            <Text style={[s.textButtonLabel, { color: colors.textSecondary }]}>{t('go_back')}</Text>
          </PressableScale>
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

        <PressableScale style={s.textButton} onPress={() => setMode('choose')} haptic="tap">
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
  sectionSubtitle: {
    ...typography.subhead,
    marginBottom: spacing.xxl,
    lineHeight: 20
  },
  bodyText: {
    ...typography.body,
    lineHeight: 24
  },

  // ─── Warning banner ────────────────────────────────────────────────
  warningBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.xxl
  },
  warningText: {
    ...typography.subhead,
    flex: 1,
    lineHeight: 21
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

  // ─── Biometric note ────────────────────────────────────────────────
  biometricNote: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.xl,
    gap: spacing.md
  },
  biometricIcon: {
    flexShrink: 0
  },
  biometricText: {
    ...typography.footnote,
    flex: 1,
    lineHeight: 18
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

  // ─── Acknowledgment ────────────────────────────────────────────────
  acknowledgment: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    padding: spacing.lg,
    marginBottom: spacing.xl
  },
  acknowledgmentText: {
    ...typography.subhead,
    flex: 1,
    lineHeight: 21
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
