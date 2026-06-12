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
import { parseShare, validateShareCompatibility, recoverKeyFromShares, ParsedShare } from '@/utils/backupShares'
import { showAlert } from '@/components/ui/AlertCard'
import { haptics } from '@/hooks/useHaptics'
import QRScanner from '@/components/QRScanner'
import Celebration from '@/components/ui/Celebration'

export default function ScanSharesScreen() {
  const { t } = useTranslation()
  const { colors, isDark } = useTheme()
  const { buildWalletFromRecoveredKey } = useWallet()
  const { setRecoveredKey } = useLocalStorage()

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

  const handleRecovery = async (shareStrings: string[]) => {
    setRecovering(true)
    try {
      const recoveredKey = recoverKeyFromShares(shareStrings)
      const wif = recoveredKey.toWif()

      // Store the recovered key and build the wallet
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
        if (choice === 'cancel') {
          setScannedShares([])
          setThreshold(null)
          lastScannedRef.current = ''
        } else {
          await handleRecovery(shareStrings)
        }
        return
      }

      setRecovered(true)
      await buildWalletFromRecoveredKey(wif)
      setCelebrating(true)
    } catch (err: any) {
      console.error('[ScanShares] Recovery failed:', err)
      setError(err.message || t('scan_shares_recovery_failed'))
      haptics.error()
      // Allow re-scanning
      setScannedShares([])
      setThreshold(null)
      lastScannedRef.current = ''
    } finally {
      setRecovering(false)
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
            router.push('/')
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
