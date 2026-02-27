import React, { useState } from 'react'
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  Alert,
  TextInput,
  ActivityIndicator,
  Share,
  StyleSheet,
  Linking
} from 'react-native'
import CustomSafeArea from '@/components/ui/CustomSafeArea'
import { router } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, radii, typography } from '@/context/theme/tokens'
import { useWallet } from '@/context/WalletContext'
import {
  generateMnemonicWallet,
  validateMnemonic,
} from '@/utils/mnemonicWallet'
import * as Clipboard from 'expo-clipboard'
import { useLocalStorage } from '@/context/LocalStorageProvider'

type MnemonicMode = 'choose' | 'generate' | 'import'

export default function MnemonicScreen() {
  const { colors, isDark } = useTheme()
  const { buildWalletFromMnemonic } = useWallet()
  const { setMnemonic: storeMnemonic } = useLocalStorage()

  const [mode, setMode] = useState<MnemonicMode>('choose')
  const [mnemonic, setMnemonic] = useState<string>('')
  const [importedMnemonic, setImportedMnemonic] = useState<string>('')

  const [hasAcknowledged, setHasAcknowledged] = useState(false)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)

  // Generate a new mnemonic
  const handleGenerateNew = () => {
    try {
      const wallet = generateMnemonicWallet()
      setMnemonic(wallet.mnemonic)
      setMode('generate')
    } catch (error: any) {
      console.error('Error generating mnemonic:', error)
      Alert.alert('Error', 'Failed to generate mnemonic. Please try again.')
    }
  }

  // Share mnemonic as text file via system share dialog
  const handleShareMnemonic = async () => {
    try {
      const result = await Share.share({
        message: mnemonic,
        title: `Save Your Recovery Phrase`
      })
      if (result.action === Share.sharedAction) {
        setHasAcknowledged(true)
      }
    } catch (error) {
      console.error('Error sharing mnemonic:', error)
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

  // Continue with generated mnemonic after acknowledgment
  const handleContinueWithGenerated = async () => {
    if (!hasAcknowledged) return
    await initializeWallet(mnemonic)
  }

  // Validate and continue with imported mnemonic
  const handleContinueWithImported = async () => {
    const trimmedMnemonic = importedMnemonic.trim()

    if (!validateMnemonic(trimmedMnemonic)) {
      Alert.alert('Invalid Mnemonic', 'Please enter a valid 12, 15, 18, 21, or 24 word mnemonic phrase.')
      return
    }

    await initializeWallet(trimmedMnemonic)
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

          <Text style={[s.largeTitle, { color: colors.textPrimary }]}>
            Wallet Data
          </Text>
          <Text style={[s.subtitle, { color: colors.textSecondary }]}>
            Your keys and transactions are stored on this device <Text style={{ fontWeight: 'bold', fontStyle: 'italic' }}>only</Text>. Expect occasional loss.{'\n\n'}Designed for p2p electronic cash.{'\n'}<Text style={{ fontWeight: 'bold' }}>Not life savings</Text>.
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
                <Text style={[s.btnLabel, { color: colors.textOnAccent }]}>
                  Create New Wallet
                </Text>
                <Text style={[s.btnCaption, { color: colors.textOnAccent, opacity: 0.75 }]}>
                  Generate a new recovery phrase
                </Text>
              </View>
            </TouchableOpacity>

            <TouchableOpacity
              style={[s.secondaryButton, {
                backgroundColor: colors.fillTertiary,
                borderColor: colors.separator,
              }]}
              onPress={() => setMode('import')}
              activeOpacity={0.75}
            >
              <Ionicons name="download-outline" size={22} color={colors.accent} style={s.btnIcon} />
              <View style={s.btnTextGroup}>
                <Text style={[s.btnLabel, { color: colors.textPrimary }]}>
                  Import Existing Wallet
                </Text>
                <Text style={[s.btnCaption, { color: colors.textSecondary }]}>
                  Paste your recovery phrase
                </Text>
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
            </Text>
            {' '}and{' '}
            <Text
              style={[s.legalLink, { color: colors.textTertiary }]}
              onPress={() => Linking.openURL('https://mobile.bsvb.tech/usage.html')}
            >
              usage
            </Text>
            {' '}policies.
          </Text>

          {/* Cancel */}
          <TouchableOpacity
            style={s.textButton}
            onPress={() => router.back()}
            activeOpacity={0.6}
          >
            <Text style={[s.textButtonLabel, { color: colors.textSecondary }]}>
              Cancel
            </Text>
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
        <ScrollView
          contentContainerStyle={s.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          <Text style={[s.largeTitle, { color: colors.textPrimary, textAlign: 'left' }]}>
            Save Your{'\n'}Recovery Phrase
          </Text>

          {/* Warning banner */}
          <View style={[s.warningBanner, {
            backgroundColor: isDark ? 'rgba(255, 69, 58, 0.12)' : 'rgba(255, 59, 48, 0.08)',
            borderColor: isDark ? 'rgba(255, 69, 58, 0.25)' : 'rgba(255, 59, 48, 0.2)',
          }]}>
            <Ionicons
              name="shield-checkmark-outline"
              size={22}
              color={colors.error}
              style={{ marginRight: spacing.md }}
            />
            <Text style={[s.warningText, { color: colors.textPrimary }]}>
              Write down these 12 words. This is the{' '}
              <Text style={{ fontWeight: '700' }}>only way</Text>
              {' '}to recover your wallet.
            </Text>
          </View>

          {/* Mnemonic display */}
          <View style={[s.mnemonicDisplay, {
            backgroundColor: colors.fillTertiary,
            borderColor: colors.separator,
          }]}>
            <Text style={[s.mnemonicDisplayText, { color: colors.textPrimary }]} selectable>
              {mnemonic}
            </Text>
          </View>

          {/* Action buttons */}
          <View style={s.generateActions}>
            <TouchableOpacity
              style={[s.primaryButton, { backgroundColor: colors.protocolApproval }]}
              onPress={handleShareMnemonic}
              activeOpacity={0.75}
            >
              <Ionicons name="share-outline" size={20} color={colors.textOnAccent} style={s.btnIcon} />
              <Text style={[s.btnLabel, { color: colors.textOnAccent }]}>
                Save Recovery Phrase
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[s.tertiaryButton, {
                backgroundColor: colors.fillTertiary,
              }]}
              onPress={handleCopyMnemonic}
              activeOpacity={0.75}
            >
              <Ionicons name={copied ? 'checkmark' : 'copy-outline'} size={20} color={colors.accent} style={s.btnIcon} />
              <Text style={[s.btnLabel, { color: colors.accent }]}>
                {copied ? 'Copied' : 'Copy to Clipboard'}
              </Text>
            </TouchableOpacity>
          </View>

          {/* Acknowledgment */}
          <TouchableOpacity
            style={[s.acknowledgment, {
              backgroundColor: hasAcknowledged ? (isDark ? 'rgba(10, 132, 255, 0.1)' : 'rgba(0, 122, 255, 0.06)') : colors.fillTertiary,
              borderColor: hasAcknowledged ? colors.accent : colors.separator,
            }]}
            onPress={() => setHasAcknowledged(!hasAcknowledged)}
            activeOpacity={0.7}
          >
            <Ionicons
              name={hasAcknowledged ? 'checkmark-circle' : 'ellipse-outline'}
              size={24}
              color={hasAcknowledged ? colors.accent : colors.textTertiary}
              style={{ marginRight: spacing.md }}
            />
            <Text style={[s.acknowledgmentText, { color: colors.textPrimary }]}>
              I have saved my recovery phrase and understand that losing it will result in total and permanent loss of all associated funds, tokens, and certificates.
            </Text>
          </TouchableOpacity>

          {/* Continue */}
          <TouchableOpacity
            style={[s.primaryButton, {
              backgroundColor: hasAcknowledged ? colors.identityApproval : colors.fillSecondary,
              opacity: loading ? 0.6 : 1,
            }]}
            onPress={handleContinueWithGenerated}
            disabled={!hasAcknowledged || loading}
            activeOpacity={0.75}
          >
            {loading ? (
              <ActivityIndicator color={colors.textOnAccent} />
            ) : (
              <Text style={[s.btnLabel, {
                color: hasAcknowledged ? colors.textOnAccent : colors.textTertiary,
              }]}>
                Continue
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
            <Text style={[s.textButtonLabel, { color: colors.textSecondary }]}>
              Go Back
            </Text>
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

        <Text style={[s.largeTitle, { color: colors.textPrimary, textAlign: 'left' }]}>
          Import Wallet
        </Text>
        <Text style={[s.bodyText, { color: colors.textSecondary, marginBottom: spacing.xxl }]}>
          Enter your recovery phrase to restore an existing wallet.
        </Text>

        <TextInput
          style={[s.mnemonicInput, {
            backgroundColor: colors.fillTertiary,
            borderColor: colors.separator,
            color: colors.textPrimary,
          }]}
          value={importedMnemonic}
          onChangeText={setImportedMnemonic}
          placeholder="Enter your recovery words separated by spaces..."
          placeholderTextColor={colors.textTertiary}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          textAlignVertical="top"
        />

        <TouchableOpacity
          style={[s.primaryButton, {
            backgroundColor: importedMnemonic.trim() ? colors.identityApproval : colors.fillSecondary,
            opacity: loading ? 0.6 : 1,
            marginTop: spacing.xxl,
          }]}
          onPress={handleContinueWithImported}
          disabled={!importedMnemonic.trim() || loading}
          activeOpacity={0.75}
        >
          {loading ? (
            <ActivityIndicator color={colors.textOnAccent} />
          ) : (
            <Text style={[s.btnLabel, {
              color: importedMnemonic.trim() ? colors.textOnAccent : colors.textTertiary,
            }]}>
              Import Wallet
            </Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={s.textButton}
          onPress={() => setMode('choose')}
          activeOpacity={0.6}
        >
          <Text style={[s.textButtonLabel, { color: colors.textSecondary }]}>
            Go Back
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </CustomSafeArea>
  )
}

// ─── Static Styles ────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  screen: {
    flex: 1,
  },

  // Centered layout for the choose screen
  centeredContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.xxxl,
  },

  // Scrollable layout for generate / import
  scrollContent: {
    paddingHorizontal: spacing.xxl,
    paddingTop: spacing.xxxl,
    paddingBottom: 60,
  },

  // ─── Hero icon ──────────────────────────────────────────────────────
  heroIcon: {
    width: 80,
    height: 80,
    borderRadius: radii.xl,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: spacing.xxl,
  },

  // ─── Typography ─────────────────────────────────────────────────────
  largeTitle: {
    ...typography.largeTitle,
    marginBottom: spacing.md,
    textAlign: 'center',
  },
  subtitle: {
    ...typography.callout,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: spacing.xxxl + spacing.sm,
  },
  bodyText: {
    ...typography.body,
    lineHeight: 24,
  },

  // ─── Warning banner ────────────────────────────────────────────────
  warningBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.xxl,
  },
  warningText: {
    ...typography.subhead,
    flex: 1,
    lineHeight: 21,
  },

  // ─── Mnemonic display ──────────────────────────────────────────────
  mnemonicDisplay: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    padding: spacing.lg,
    marginBottom: spacing.xxl,
  },
  mnemonicDisplayText: {
    ...typography.callout,
    fontFamily: 'monospace',
    lineHeight: 24,
    textAlign: 'center',
  },

  // ─── Buttons ────────────────────────────────────────────────────────
  actionArea: {
    width: '100%',
    gap: spacing.md,
    marginBottom: spacing.xxl,
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.xl,
    borderRadius: radii.md,
    minHeight: 50,
  },
  secondaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.xl,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    minHeight: 50,
  },
  tertiaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.xl,
    borderRadius: radii.md,
    minHeight: 50,
  },
  generateActions: {
    gap: spacing.sm,
    marginBottom: spacing.xxl,
  },
  btnIcon: {
    marginRight: spacing.sm,
  },
  btnTextGroup: {
    flex: 1,
  },
  btnLabel: {
    ...typography.headline,
  },
  btnCaption: {
    ...typography.footnote,
    marginTop: 2,
  },
  legalText: {
    ...typography.caption2,
    textAlign: 'center',
    lineHeight: 16,
  },
  legalLink: {
    ...typography.caption2,
    textDecorationLine: 'underline',
  },
  textButton: {
    alignSelf: 'center',
    marginTop: spacing.md,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.xl,
  },
  textButtonLabel: {
    ...typography.subhead,
  },

  // ─── Acknowledgment ────────────────────────────────────────────────
  acknowledgment: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    padding: spacing.lg,
    marginBottom: spacing.xl,
  },
  acknowledgmentText: {
    ...typography.subhead,
    flex: 1,
    lineHeight: 21,
  },

  // ─── Import text input ─────────────────────────────────────────────
  mnemonicInput: {
    ...typography.body,
    minHeight: 140,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    padding: spacing.lg,
    paddingTop: spacing.lg,
    lineHeight: 26,
  },
})
