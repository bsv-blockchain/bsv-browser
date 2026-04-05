import React, { useRef, useCallback } from 'react'
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from '@/context/theme/ThemeContext'
import { useTranslation } from 'react-i18next'
import { spacing, typography } from '@/context/theme/tokens'

/* -------------------------------------------------------------------------- */
/*                                   Types                                    */
/* -------------------------------------------------------------------------- */

interface QRScannerProps {
  /** Called with the raw barcode string. Caller is responsible for validation. */
  onScan: (data: string) => void
  /** Dismiss the scanner. */
  onClose: () => void
  /** Hint text shown below the finder window. Falls back to a generic i18n key. */
  hintText?: string
  /**
   * When true the scanner keeps accepting barcodes after each `onScan` call
   * (e.g. for multi-share Shamir recovery or scans that need caller-side
   * validation before closing). When false (default) scanning is disabled
   * after the first successful read.
   */
  multiScan?: boolean
  /**
   * Optional render callback for extra content in the bottom overlay area,
   * rendered below the hint text. Useful for progress dots, error banners, etc.
   */
  renderBottom?: () => React.ReactNode
}

/* -------------------------------------------------------------------------- */
/*                                 Constants                                  */
/* -------------------------------------------------------------------------- */

const SCAN_WINDOW_SIZE = 260
const CORNER_SIZE = 24
const CORNER_THICKNESS = 3
const SCAN_LOCK_DELAY_MS = 1500

/* -------------------------------------------------------------------------- */
/*                                 Component                                  */
/* -------------------------------------------------------------------------- */

export default function QRScanner({ onScan, onClose, hintText, multiScan = false, renderBottom }: QRScannerProps) {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const [permission, requestPermission] = useCameraPermissions()

  // Prevent rapid-fire duplicate scans
  const scanLockRef = useRef(false)
  const stoppedRef = useRef(false)

  const handleBarCodeScanned = useCallback(
    ({ data }: { data: string }) => {
      if (scanLockRef.current || stoppedRef.current) return
      scanLockRef.current = true

      onScan(data)

      if (!multiScan) {
        // Single-scan mode: stop scanning permanently (caller should close)
        stoppedRef.current = true
      } else {
        // Multi-scan mode: re-enable after a brief delay
        setTimeout(() => {
          scanLockRef.current = false
        }, SCAN_LOCK_DELAY_MS)
      }
    },
    [onScan, multiScan]
  )

  /* ── Permission not yet determined ─────────────────────────────────────── */
  if (!permission) {
    return <View style={styles.fill} />
  }

  /* ── Permission denied / not yet granted ───────────────────────────────── */
  if (!permission.granted) {
    return (
      <View style={styles.permScreen}>
        <View style={styles.permIconWrap}>
          <Ionicons name="camera-outline" size={40} color="#fff" />
        </View>
        <Text style={styles.permTitle}>{t('scan_shares_camera_needed')}</Text>
        <Text style={styles.permBody}>{t('scan_shares_camera_description')}</Text>
        <TouchableOpacity style={styles.permBtn} onPress={requestPermission}>
          <Text style={styles.permBtnText}>{t('scan_shares_grant_camera')}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={{ marginTop: spacing.lg }} onPress={onClose}>
          <Text style={styles.permBack}>{t('go_back')}</Text>
        </TouchableOpacity>
      </View>
    )
  }

  /* ── Camera + overlay ──────────────────────────────────────────────────── */
  return (
    <View style={styles.fill}>
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
          <TouchableOpacity style={styles.closeButton} onPress={onClose}>
            <Ionicons name="close" size={26} color="#fff" />
          </TouchableOpacity>
        </View>

        {/* Center row with cutout */}
        <View style={styles.overlayMiddle}>
          <View style={styles.overlaySide} />
          <View style={styles.scanWindow}>
            <View style={[styles.corner, styles.cornerTL]} />
            <View style={[styles.corner, styles.cornerTR]} />
            <View style={[styles.corner, styles.cornerBL]} />
            <View style={[styles.corner, styles.cornerBR]} />
          </View>
          <View style={styles.overlaySide} />
        </View>

        {/* Bottom info */}
        <View style={styles.overlayBottom}>
          <Text style={styles.hintText}>{hintText ?? t('scan_qr_default_hint')}</Text>
          {renderBottom?.()}
        </View>
      </View>
    </View>
  )
}

/* -------------------------------------------------------------------------- */
/*                                  Styles                                    */
/* -------------------------------------------------------------------------- */

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    backgroundColor: '#000'
  },

  // ── Permission screen ──────────────────────────────────────────────────
  permScreen: {
    flex: 1,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xxxl
  },
  permIconWrap: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xxl
  },
  permTitle: {
    ...typography.headline,
    color: '#fff',
    textAlign: 'center',
    marginBottom: spacing.sm
  },
  permBody: {
    ...typography.subhead,
    color: 'rgba(255,255,255,0.6)',
    textAlign: 'center',
    marginBottom: spacing.xxl
  },
  permBtn: {
    backgroundColor: '#007AFF',
    borderRadius: 12,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xxxl
  },
  permBtnText: {
    ...typography.headline,
    color: '#fff'
  },
  permBack: {
    ...typography.subhead,
    color: 'rgba(255,255,255,0.5)'
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
    alignItems: 'center',
    justifyContent: 'center'
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

  // ── Hint text ──────────────────────────────────────────────────────────
  hintText: {
    ...typography.subhead,
    color: 'rgba(255,255,255,0.8)',
    textAlign: 'center'
  }
})
