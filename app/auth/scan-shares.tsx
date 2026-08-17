import React, { useState, useRef, useCallback } from 'react'
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { router } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, radii, typography } from '@/context/theme/tokens'
import { useTranslation } from 'react-i18next'
import { useWallet } from '@/context/WalletContext'
import { useLocalStorage } from '@/context/LocalStorageProvider'
import { parseShare, validateShareCompatibility, recoverSecretFromShares, ParsedShare } from '@/utils/backupShares'
import { Mnemonic, PrivateKey } from '@bsv/sdk'
import { showAlert } from '@/components/ui/AlertCard'
import { haptics } from '@/hooks/useHaptics'
import QRScanner from '@/components/QRScanner'
import Celebration from '@/components/ui/Celebration'

export default function ScanSharesScreen() {
  const { t } = useTranslation()
  const { colors, isDark } = useTheme()
  const { buildWalletFromRecoveredKey, buildWalletFromMnemonic } = useWallet()
  const { setRecoveredKey, setMnemonic, deleteRecoveredKey } = useLocalStorage()

  const [scannedShares, setScannedShares] = useState<ParsedShare[]>([])
  const [threshold, setThreshold] = useState<number | null>(null)
  const [recovering, setRecovering] = useState(false)
  const [recovered, setRecovered] = useState(false)
  const [celebrating, setCelebrating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Prevent re-processing the exact same QR content
  const lastScannedRef = useRef<string>('')

  const handleBarCodeScanned = useCallback(
    (data: string) => {
      // Ignore if already recovered
      if (recovered) return

      // Ignore duplicate sequential scans
      if (data === lastScannedRef.current) return
      lastScannedRef.current = data

      setError(null)

      const parsed = parseShare(data)
      if (!parsed) {
        setError(t('scan_shares_invalid_format'))
        return
      }

      // Validate compatibility with existing shares
      const compatError = validateShareCompatibility(parsed, scannedShares)
      if (compatError) {
        setError(compatError)
        haptics.error()
        return
      }

      const updatedShares = [...scannedShares, parsed]
      const isComplete = updatedShares.length >= parsed.threshold

      // Haptic for intermediate shares only — Celebration fires haptics.success() on completion
      if (!isComplete) {
        haptics.success()
      }

      setScannedShares(updatedShares)

      if (!threshold) {
        setThreshold(parsed.threshold)
      }

      // Check if we have enough shares to recover
      if (isComplete) {
        handleRecovery(updatedShares.map(s => s.raw))
      } else {
        // Clear last scanned so the next different share can be read
        lastScannedRef.current = ''
      }
    },
    [scannedShares, threshold, recovered, t]
  )

  /**
   * Two formats reach this point.
   *
   * Entropy shares (current) rebuild the phrase, so the wallet is stored as a
   * mnemonic wallet — identical to one that never lost its phone. Any stale
   * recoveredKey is removed afterwards so two secrets cannot coexist and
   * disagree; it is removed only AFTER the mnemonic write succeeds, because
   * setMnemonic sits behind a biometric prompt and a refusal between the two
   * would leave no wallet at all.
   *
   * Legacy shares carry the hardened primary key and cannot rebuild the
   * phrase, so they keep the old WIF path and the user is told what that costs.
   */
  const handleRecovery = async (shareStrings: string[]) => {
    setRecovering(true)
    try {
      const secret = recoverSecretFromShares(shareStrings)

      if (secret.kind === 'entropy') {
        const mnemonic = Mnemonic.fromEntropy(secret.entropy).toString()

        if (!(await setMnemonic(mnemonic))) return await retryOrReset(shareStrings)
        // Only after the phrase is safely stored: a refusal between the two
        // writes would otherwise leave the wallet with neither secret.
        await deleteRecoveredKey()
        await buildWalletFromMnemonic(mnemonic)
      } else {
        const wif = new PrivateKey(secret.primaryKey).toWif()

        if (!(await setRecoveredKey(wif))) return await retryOrReset(shareStrings)
        await buildWalletFromRecoveredKey(wif)

        await showAlert({
          title: t('scan_shares_legacy_title'),
          message: t('scan_shares_legacy_message'),
          buttons: [{ text: t('scan_shares_legacy_ack'), key: 'ok' }]
        })
      }

      setRecovered(true)
      setCelebrating(true)
    } catch (err: any) {
      console.error('[ScanShares] Recovery failed:', err)
      setError(err.message || t('scan_shares_recovery_failed'))
      haptics.error()
      // Allow re-scanning
      setRecovered(false)
      setScannedShares([])
      setThreshold(null)
      lastScannedRef.current = ''
    } finally {
      setRecovering(false)
    }
  }

  /**
   * Both formats store their secret behind the biometric latch, and both have
   * to survive a refusal the same way: offer a retry, or reset the scanner so
   * the user can start over.
   */
  const retryOrReset = async (shareStrings: string[]): Promise<void> => {
    const choice = await showAlert({
      title: t('scan_shares_biometric_title'),
      message: t('scan_shares_biometric_message'),
      buttons: [
        { text: t('cancel'), style: 'cancel', key: 'cancel' },
        { text: t('retry'), key: 'retry' },
      ],
    })
    if (choice === 'cancel') {
      setScannedShares([])
      setThreshold(null)
      lastScannedRef.current = ''
    } else {
      await handleRecovery(shareStrings)
    }
  }

  // ── Recovering state ───────────────────────────────────────────────────
  if (recovering) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.background }]}>
        <StatusBar style={isDark ? 'light' : 'dark'} />
        <ActivityIndicator size="large" color={colors.accent} />
        <Text style={[styles.recoveringText, { color: colors.textPrimary }]}>{t('scan_shares_recovering')}</Text>
      </View>
    )
  }

  // ── Celebration overlay (backup verified) ─────────────────────────────
  if (celebrating) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.background }]}>
        <StatusBar style={isDark ? 'light' : 'dark'} />
        <Celebration
          onDone={() => {
            router.dismissAll()
          }}
        />
      </View>
    )
  }

  // ── Scanner ────────────────────────────────────────────────────────────
  const sharesNeeded = threshold ?? 2
  const sharesRemaining = sharesNeeded - scannedShares.length

  return (
    <View style={styles.container}>
      <StatusBar style="light" />
      <QRScanner
        multiScan
        onScan={handleBarCodeScanned}
        onClose={() => router.back()}
        hintText={
          scannedShares.length === 0
            ? t('scan_shares_scan_first')
            : t('scan_shares_progress', {
                scanned: scannedShares.length,
                needed: sharesNeeded
              })
        }
        renderBottom={() => (
          <>
            {/* Progress indicators */}
            <View style={styles.progressRow}>
              {Array.from({ length: sharesNeeded }).map((_, i) => (
                <View
                  key={i}
                  style={[
                    styles.progressDot,
                    {
                      backgroundColor: i < scannedShares.length ? '#34C759' : 'rgba(255,255,255,0.3)'
                    }
                  ]}
                />
              ))}
            </View>

            <Text style={styles.statusHint}>
              {sharesRemaining > 0 ? t('scan_shares_remaining', { count: sharesRemaining }) : t('scan_shares_complete')}
            </Text>

            {error && (
              <View style={styles.errorBanner}>
                <Ionicons name="alert-circle" size={18} color="#FF453A" />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}
          </>
        )}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000'
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.xxxl
  },

  // ── Recovering ─────────────────────────────────────────────────────────
  recoveringText: {
    ...typography.headline,
    marginTop: spacing.lg
  },

  // ── Progress & status (rendered via QRScanner's renderBottom) ──────────
  progressRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: spacing.lg,
    marginTop: spacing.md
  },
  progressDot: {
    width: 12,
    height: 12,
    borderRadius: 6
  },
  statusHint: {
    ...typography.subhead,
    color: 'rgba(255,255,255,0.7)',
    textAlign: 'center'
  },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 69, 58, 0.15)',
    borderRadius: radii.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    marginTop: spacing.lg,
    gap: spacing.sm
  },
  errorText: {
    ...typography.footnote,
    color: '#FF453A',
    flex: 1
  }
})
