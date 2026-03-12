import React, { useState, useEffect } from 'react'
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  Alert,
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
import * as Clipboard from 'expo-clipboard'
import * as Print from 'expo-print'
import { Paths, File as ExpoFile } from 'expo-file-system'
import * as Sharing from 'expo-sharing'
import { useLocalStorage } from '@/context/LocalStorageProvider'

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
      await storeMnemonic(wallet.mnemonic)
      await buildWalletFromMnemonic(wallet.mnemonic)
      console.log('[Mnemonic] Wallet built successfully during generate flow')
    } catch (error: any) {
      console.error('Error generating mnemonic:', error)
      Alert.alert('Error', 'Failed to generate mnemonic. Please try again.')
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
    await Clipboard.setStringAsync(mnemonic)
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
    router.dismissAll()
    router.push('/')
  }

  // Validate and continue with imported mnemonic or hex private key
  const handleContinueWithImported = async () => {
    const trimmed = importedMnemonic.trim()

    // Detect 64-char hex string as a raw private key
    if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
      setLoading(true)
      try {
        const wif = PrivateKey.fromHex(trimmed).toWif()
        await setRecoveredKey(wif)
        await buildWalletFromRecoveredKey(wif)
        router.dismissAll()
        router.push('/')
      } catch (error: any) {
        console.error('[Mnemonic] Error importing hex key:', error)
        Alert.alert('Error', `Invalid private key: ${error.message}`)
      } finally {
        setLoading(false)
      }
      return
    }

    if (!validateMnemonic(trimmed)) {
      Alert.alert(
        'Invalid Input',
        'Please enter a valid recovery phrase (12–24 words) or a 64-character hex private key.'
      )
      return
    }

    await initializeWallet(trimmed)
  }

  // Initialize wallet with mnemonic
  const initializeWallet = async (mnemonicPhrase: string) => {
    setLoading(true)
    try {
      console.log('[Mnemonic] Starting wallet initialization with mnemonic')
      await storeMnemonic(mnemonicPhrase)
      await buildWalletFromMnemonic(mnemonicPhrase)
      console.log('[Mnemonic] Wallet setup complete, navigating to browser')
      router.dismissAll()
      router.push('/')
    } catch (error: any) {
      console.error('[Mnemonic] Error setting up wallet:', error)
      Alert.alert('Error', `Failed to set up wallet: ${error.message}`)
    } finally {
      setLoading(false)
    }
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
            <TouchableOpacity
              style={[s.primaryButton, { backgroundColor: colors.identityApproval }]}
              onPress={handleGenerateNew}
              activeOpacity={0.75}
            >
              <Ionicons name="add-circle-outline" size={22} color={colors.textOnAccent} style={s.btnIcon} />
              <View style={s.btnTextGroup}>
                <Text style={[s.btnLabel, { color: colors.textOnAccent }]}>{t('create_new_wallet')}</Text>
                <Text style={[s.btnCaption, { color: colors.textOnAccent, opacity: 0.75 }]}>
                  {t('generate_recovery_phrase_caption')}
                </Text>
              </View>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                s.secondaryButton,
                {
                  backgroundColor: colors.fillTertiary,
                  borderColor: colors.separator
                }
              ]}
              onPress={() => setMode('import')}
              activeOpacity={0.75}
            >
              <Ionicons name="download-outline" size={22} color={colors.accent} style={s.btnIcon} />
              <View style={s.btnTextGroup}>
                <Text style={[s.btnLabel, { color: colors.textPrimary }]}>{t('import_existing_wallet')}</Text>
                <Text style={[s.btnCaption, { color: colors.textSecondary }]}>{t('paste_recovery_phrase')}</Text>
              </View>
            </TouchableOpacity>
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
          <TouchableOpacity style={s.textButton} onPress={() => router.back()} activeOpacity={0.6}>
            <Text style={[s.textButtonLabel, { color: colors.textSecondary }]}>{t('cancel')}</Text>
          </TouchableOpacity>
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

          {/* Mnemonic display */}
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
              <TouchableOpacity
                style={[s.inlineButton, { backgroundColor: colors.protocolApproval }]}
                onPress={handleShareMnemonic}
                activeOpacity={0.75}
              >
                <Ionicons name="share-outline" size={20} color={colors.textOnAccent} style={s.btnIcon} />
                <Text style={[s.btnLabel, { color: colors.textOnAccent }]}>{t('save')}</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[s.inlineButton, { backgroundColor: colors.fillTertiary }]}
                onPress={handleCopyMnemonic}
                activeOpacity={0.75}
              >
                <Ionicons
                  name={copied ? 'checkmark' : 'copy-outline'}
                  size={20}
                  color={colors.accent}
                  style={s.btnIcon}
                />
                <Text style={[s.btnLabel, { color: colors.accent }]}>{copied ? t('copied') : t('copy')}</Text>
              </TouchableOpacity>
            </View>

            <TouchableOpacity
              style={[s.primaryButton, { backgroundColor: '#5856D6' }]}
              onPress={handlePrintRecoveryShares}
              disabled={isPrinting}
              activeOpacity={0.75}
            >
              {isPrinting ? (
                <ActivityIndicator color="#FFFFFF" style={s.btnIcon} />
              ) : (
                <Ionicons name="print-outline" size={20} color="#FFFFFF" style={s.btnIcon} />
              )}
              <Text style={[s.btnLabel, { color: '#FFFFFF' }]}>{t('print_recovery_shares')}</Text>
            </TouchableOpacity>
          </View>

          {/* Acknowledgment */}
          <TouchableOpacity
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
            activeOpacity={0.7}
          >
            <Ionicons
              name={hasAcknowledged ? 'checkmark-circle' : 'ellipse-outline'}
              size={24}
              color={hasAcknowledged ? colors.accent : colors.textTertiary}
              style={{ marginRight: spacing.md }}
            />
            <Text style={[s.acknowledgmentText, { color: colors.textPrimary }]}>{t('acknowledgment_text')}</Text>
          </TouchableOpacity>

          {/* Continue */}
          <TouchableOpacity
            style={[
              s.primaryButton,
              {
                backgroundColor: hasAcknowledged ? colors.identityApproval : colors.fillSecondary,
                opacity: loading ? 0.6 : 1
              }
            ]}
            onPress={handleContinueWithGenerated}
            disabled={!hasAcknowledged || loading}
            activeOpacity={0.75}
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
          </TouchableOpacity>

          {/* Back link */}
          <TouchableOpacity
            style={s.textButton}
            onPress={() => {
              setMode('choose')
              setHasAcknowledged(false)
            }}
            activeOpacity={0.6}
          >
            <Text style={[s.textButtonLabel, { color: colors.textSecondary }]}>{t('go_back')}</Text>
          </TouchableOpacity>
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

        <TouchableOpacity
          style={[
            s.primaryButton,
            {
              backgroundColor: importedMnemonic.trim() ? colors.identityApproval : colors.fillSecondary,
              opacity: loading ? 0.6 : 1,
              marginTop: spacing.xxl
            }
          ]}
          onPress={handleContinueWithImported}
          disabled={!importedMnemonic.trim() || loading}
          activeOpacity={0.75}
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
        </TouchableOpacity>

        {/* ── Divider ── */}
        <View style={[s.orDivider, { marginTop: spacing.xl }]}>
          <View style={[s.orDividerLine, { backgroundColor: colors.separator }]} />
          <Text style={[s.orDividerText, { color: colors.textTertiary }]}>{t('or')}</Text>
          <View style={[s.orDividerLine, { backgroundColor: colors.separator }]} />
        </View>

        {/* ── Scan Backup Shares ── */}
        <TouchableOpacity
          style={[
            s.secondaryButton,
            {
              backgroundColor: colors.fillTertiary,
              borderColor: colors.separator,
              marginTop: spacing.xl
            }
          ]}
          onPress={() => router.push('/auth/scan-shares')}
          activeOpacity={0.75}
        >
          <Ionicons name="scan-outline" size={22} color={colors.accent} style={s.btnIcon} />
          <View style={s.btnTextGroup}>
            <Text style={[s.btnLabel, { color: colors.textPrimary }]}>{t('scan_backup_shares')}</Text>
            <Text style={[s.btnCaption, { color: colors.textSecondary }]}>{t('scan_backup_shares_caption')}</Text>
          </View>
        </TouchableOpacity>

        <TouchableOpacity style={s.textButton} onPress={() => setMode('choose')} activeOpacity={0.6}>
          <Text style={[s.textButtonLabel, { color: colors.textSecondary }]}>Go Back</Text>
        </TouchableOpacity>
      </ScrollView>
    </CustomSafeArea>
  )
}

// ─── Static Styles ────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  screen: {
    flex: 1
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
    paddingTop: spacing.xxxl,
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
    textAlign: 'center'
  },
  subtitle: {
    ...typography.callout,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: spacing.xxxl + spacing.sm
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
    borderRadius: radii.md,
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
    borderRadius: radii.md,
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
