import React, { useState, useRef, useCallback } from 'react'
import { View, Text, TouchableOpacity, Alert, StyleSheet, ActivityIndicator } from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { Ionicons } from '@expo/vector-icons'
import { router } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, radii, typography } from '@/context/theme/tokens'
import { useTranslation } from 'react-i18next'
import { useWallet } from '@/context/WalletContext'
import { useLocalStorage } from '@/context/LocalStorageProvider'
import { parseShare, validateShareCompatibility, recoverKeyFromShares, ParsedShare } from '@/utils/backupShares'
import * as Haptics from 'expo-haptics'

export default function ScanSharesScreen() {
  const { t } = useTranslation()
  const { colors, isDark } = useTheme()
  const { buildWalletFromRecoveredKey } = useWallet()
  const { setRecoveredKey } = useLocalStorage()
  const [permission, requestPermission] = useCameraPermissions()

  const [scannedShares, setScannedShares] = useState<ParsedShare[]>([])
  const [threshold, setThreshold] = useState<number | null>(null)
  const [recovering, setRecovering] = useState(false)
  const [recovered, setRecovered] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Debounce scanning to prevent rapid-fire reads of the same QR code
  const lastScannedRef = useRef<string>('')
  const scanLockRef = useRef(false)

  const handleBarCodeScanned = useCallback(
    ({ data }: { data: string }) => {
      // Ignore if we're in the middle of processing or already recovered
      if (scanLockRef.current || recovered) return

      // Ignore duplicate sequential scans
      if (data === lastScannedRef.current) return
      lastScannedRef.current = data

      // Lock scanning while we process
      scanLockRef.current = true
      setError(null)

      const parsed = parseShare(data)
      if (!parsed) {
        setError(t('scan_shares_invalid_format'))
        scanLockRef.current = false
        return
      }

      // Validate compatibility with existing shares
      const compatError = validateShareCompatibility(parsed, scannedShares)
      if (compatError) {
        setError(compatError)
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)
        // Unlock after a brief delay so the same QR isn't re-read immediately
        setTimeout(() => {
          scanLockRef.current = false
        }, 1500)
        return
      }

      // Valid new share — haptic feedback
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)

      const updatedShares = [...scannedShares, parsed]
      setScannedShares(updatedShares)

      if (!threshold) {
        setThreshold(parsed.threshold)
      }

      // Check if we have enough shares to recover
      if (updatedShares.length >= parsed.threshold) {
        handleRecovery(updatedShares.map(s => s.raw))
      } else {
        // Unlock scanning for next share after a brief pause
        setTimeout(() => {
          lastScannedRef.current = ''
          scanLockRef.current = false
        }, 1500)
      }
    },
    [scannedShares, threshold, recovered, t]
  )

  const handleRecovery = async (shareStrings: string[]) => {
    setRecovering(true)
    try {
      const recoveredKey = recoverKeyFromShares(shareStrings)
      const wif = recoveredKey.toWif()

      setRecovered(true)

      // Store the recovered key and build the wallet
      await setRecoveredKey(wif)
      await buildWalletFromRecoveredKey(wif)

      // Navigate to the browser
      router.dismissAll()
      router.push('/')
    } catch (err: any) {
      console.error('[ScanShares] Recovery failed:', err)
      setError(err.message || t('scan_shares_recovery_failed'))
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)
      // Allow re-scanning
      setScannedShares([])
      setThreshold(null)
      lastScannedRef.current = ''
      scanLockRef.current = false
    } finally {
      setRecovering(false)
    }
  }

  // ── Permission not yet determined ───────────────────────────────────────
  if (!permission) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    )
  }

  // ── Permission denied ──────────────────────────────────────────────────
  if (!permission.granted) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.background }]}>
        <StatusBar style={isDark ? 'light' : 'dark'} />
        <View style={[styles.permIcon, { backgroundColor: colors.fillTertiary }]}>
          <Ionicons name="camera-outline" size={40} color={colors.accent} />
        </View>
        <Text style={[styles.permTitle, { color: colors.textPrimary }]}>{t('scan_shares_camera_needed')}</Text>
        <Text style={[styles.permBody, { color: colors.textSecondary }]}>{t('scan_shares_camera_description')}</Text>
        <TouchableOpacity
          style={[styles.permButton, { backgroundColor: colors.identityApproval }]}
          onPress={requestPermission}
          activeOpacity={0.75}
        >
          <Text style={[styles.permButtonText, { color: colors.textOnAccent }]}>{t('scan_shares_grant_camera')}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.backLink} onPress={() => router.back()} activeOpacity={0.6}>
          <Text style={[styles.backLinkText, { color: colors.textSecondary }]}>{t('go_back')}</Text>
        </TouchableOpacity>
      </View>
    )
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

  // ── Scanner ────────────────────────────────────────────────────────────
  const sharesNeeded = threshold ?? 2
  const sharesRemaining = sharesNeeded - scannedShares.length

  return (
    <View style={styles.container}>
      <StatusBar style="light" />
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={handleBarCodeScanned}
      />

      {/* Dark overlay with cutout */}
      <View style={styles.overlay}>
        {/* Top bar */}
        <View style={styles.overlayTop}>
          <TouchableOpacity style={styles.closeButton} onPress={() => router.back()}>
            <Ionicons name="close" size={28} color="#fff" />
          </TouchableOpacity>
        </View>

        {/* Center row with cutout */}
        <View style={styles.overlayMiddle}>
          <View style={styles.overlaySide} />
          <View style={styles.scanWindow}>
            {/* Corner marks */}
            <View style={[styles.corner, styles.cornerTL]} />
            <View style={[styles.corner, styles.cornerTR]} />
            <View style={[styles.corner, styles.cornerBL]} />
            <View style={[styles.corner, styles.cornerBR]} />
          </View>
          <View style={styles.overlaySide} />
        </View>

        {/* Bottom info */}
        <View style={styles.overlayBottom}>
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

          <Text style={styles.statusText}>
            {scannedShares.length === 0
              ? t('scan_shares_scan_first')
              : t('scan_shares_progress', {
                  scanned: scannedShares.length,
                  needed: sharesNeeded
                })}
          </Text>

          <Text style={styles.hintText}>
            {sharesRemaining > 0 ? t('scan_shares_remaining', { count: sharesRemaining }) : t('scan_shares_complete')}
          </Text>

          {error && (
            <View style={styles.errorBanner}>
              <Ionicons name="alert-circle" size={18} color="#FF453A" />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}
        </View>
      </View>
    </View>
  )
}

const SCAN_WINDOW_SIZE = 260
const CORNER_SIZE = 24
const CORNER_THICKNESS = 3

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

  // ── Permission screen ──────────────────────────────────────────────────
  permIcon: {
    width: 80,
    height: 80,
    borderRadius: radii.xl,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: spacing.xxl
  },
  permTitle: {
    ...typography.largeTitle,
    marginBottom: spacing.md,
    textAlign: 'center'
  },
  permBody: {
    ...typography.callout,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: spacing.xxl
  },
  permButton: {
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.xxxl,
    borderRadius: radii.md,
    minHeight: 50,
    justifyContent: 'center',
    alignItems: 'center'
  },
  permButtonText: {
    ...typography.headline
  },
  backLink: {
    marginTop: spacing.md,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.xl
  },
  backLinkText: {
    ...typography.subhead
  },

  // ── Recovering ─────────────────────────────────────────────────────────
  recoveringText: {
    ...typography.headline,
    marginTop: spacing.lg
  },

  // ── Scanner overlay ────────────────────────────────────────────────────
  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'space-between'
  },
  overlayTop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'flex-start',
    paddingTop: 60,
    paddingHorizontal: spacing.lg
  },
  closeButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center'
  },
  overlayMiddle: {
    flexDirection: 'row',
    height: SCAN_WINDOW_SIZE
  },
  overlaySide: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)'
  },
  scanWindow: {
    width: SCAN_WINDOW_SIZE,
    height: SCAN_WINDOW_SIZE
  },
  overlayBottom: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    paddingTop: spacing.xxl,
    paddingHorizontal: spacing.xl
  },

  // ── Corner marks ───────────────────────────────────────────────────────
  corner: {
    position: 'absolute',
    width: CORNER_SIZE,
    height: CORNER_SIZE
  },
  cornerTL: {
    top: 0,
    left: 0,
    borderTopWidth: CORNER_THICKNESS,
    borderLeftWidth: CORNER_THICKNESS,
    borderColor: '#fff'
  },
  cornerTR: {
    top: 0,
    right: 0,
    borderTopWidth: CORNER_THICKNESS,
    borderRightWidth: CORNER_THICKNESS,
    borderColor: '#fff'
  },
  cornerBL: {
    bottom: 0,
    left: 0,
    borderBottomWidth: CORNER_THICKNESS,
    borderLeftWidth: CORNER_THICKNESS,
    borderColor: '#fff'
  },
  cornerBR: {
    bottom: 0,
    right: 0,
    borderBottomWidth: CORNER_THICKNESS,
    borderRightWidth: CORNER_THICKNESS,
    borderColor: '#fff'
  },

  // ── Progress & status ──────────────────────────────────────────────────
  progressRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: spacing.lg
  },
  progressDot: {
    width: 12,
    height: 12,
    borderRadius: 6
  },
  statusText: {
    ...typography.headline,
    color: '#fff',
    textAlign: 'center',
    marginBottom: spacing.sm
  },
  hintText: {
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
