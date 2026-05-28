# Plan: Unify QR Scanner Component

## Goal

Replace 4 separate QR scanner implementations with a single reusable `<QRScanner>` component, eliminating ~300 lines of duplicated code while maintaining all existing functionality.

## Current State

- `components/QRScanner.tsx` — KJR's component (simple, inconsistent UI, no i18n, broken one-shot scan)
- `app/payments.tsx` — inline scanner (~150 lines of JSX + styles) for scanning identity public keys
- `app/legacy-payments.tsx` — inline scanner (~130 lines of JSX + styles) for scanning BSV addresses
- `app/auth/scan-shares.tsx` — full-page scanner with multi-scan, progress dots, error banners, haptics

The 3 existing inline scanners share an identical visual pattern (dimmed overlay, corner marks, permission screen) that KJR's component doesn't match.

---

## Task 1: Rewrite `components/QRScanner.tsx`

### New Props Interface

```typescript
interface QRScannerProps {
  onScan: (data: string) => void // Raw barcode data; caller validates
  onClose: () => void // Dismiss the scanner
  hintText?: string // Bottom hint text (i18n'd by caller)
  multiScan?: boolean // Keep scanning after first hit (default: false)
  renderBottom?: () => React.ReactNode // Custom content below hint (progress dots, errors)
}
```

### Visual Changes

- Adopt 3-section dimmed overlay (top/middle/bottom) with `rgba(0,0,0,0.55)` background
- 260x260 cutout window with 4 white corner marks (24x24, 3px border)
- Close button: top-left, 44x44 circle, `rgba(0,0,0,0.4)` bg
- Dark (#000) permission screen with circular icon wrap, i18n text, blue CTA, "Go back" link
- Default hint text from i18n if none provided

### Scan Behavior

- Use `scanLockRef` with 1500ms auto-unlock (replacing broken `scanned` boolean)
- Single-scan mode (default): after `onScan` fires, stop scanning permanently (caller closes modal)
- Multi-scan mode: after `onScan`, re-enable after 1500ms delay

### Imports needed

- Add: `useTranslation` from `react-i18next`, `spacing`, `typography` from `@/context/theme/tokens`
- Keep: `CameraView`, `useCameraPermissions`, `Ionicons`, `useTheme`
- Remove: `useState` (no longer needs `scanned` state), add `useRef`, `useCallback`

### Full implementation (replace entire file)

```tsx
import React, { useRef, useCallback } from 'react'
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from '@/context/theme/ThemeContext'
import { useTranslation } from 'react-i18next'
import { spacing, typography } from '@/context/theme/tokens'

interface QRScannerProps {
  onScan: (data: string) => void
  onClose: () => void
  hintText?: string
  multiScan?: boolean
  renderBottom?: () => React.ReactNode
}

const SCAN_WINDOW_SIZE = 260
const CORNER_SIZE = 24
const CORNER_THICKNESS = 3
const SCAN_LOCK_DELAY_MS = 1500

export default function QRScanner({ onScan, onClose, hintText, multiScan = false, renderBottom }: QRScannerProps) {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const [permission, requestPermission] = useCameraPermissions()
  const scanLockRef = useRef(false)
  const stoppedRef = useRef(false)

  const handleBarCodeScanned = useCallback(
    ({ data }: { data: string }) => {
      if (scanLockRef.current || stoppedRef.current) return
      scanLockRef.current = true
      onScan(data)
      if (!multiScan) {
        stoppedRef.current = true
      } else {
        setTimeout(() => {
          scanLockRef.current = false
        }, SCAN_LOCK_DELAY_MS)
      }
    },
    [onScan, multiScan]
  )

  if (!permission) return <View style={styles.fill} />

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

  return (
    <View style={styles.fill}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={handleBarCodeScanned}
      />
      <View style={styles.overlay}>
        <View style={styles.overlayTop}>
          <TouchableOpacity style={styles.closeButton} onPress={onClose}>
            <Ionicons name="close" size={26} color="#fff" />
          </TouchableOpacity>
        </View>
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
        <View style={styles.overlayBottom}>
          <Text style={styles.hintText}>{hintText ?? t('scan_qr_default_hint')}</Text>
          {renderBottom?.()}
        </View>
      </View>
    </View>
  )
}

// Styles: adopt the established pattern from payments.tsx/scan-shares.tsx
const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#000' },
  // Permission screen
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
  permTitle: { ...typography.headline, color: '#fff', textAlign: 'center', marginBottom: spacing.sm },
  permBody: { ...typography.subhead, color: 'rgba(255,255,255,0.6)', textAlign: 'center', marginBottom: spacing.xxl },
  permBtn: {
    backgroundColor: '#007AFF',
    borderRadius: 12,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xxxl
  },
  permBtnText: { ...typography.headline, color: '#fff' },
  permBack: { ...typography.subhead, color: 'rgba(255,255,255,0.5)' },
  // Overlay
  overlay: { ...StyleSheet.absoluteFillObject, justifyContent: 'space-between' },
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
  overlayMiddle: { flexDirection: 'row', height: SCAN_WINDOW_SIZE },
  overlaySide: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' },
  scanWindow: { width: SCAN_WINDOW_SIZE, height: SCAN_WINDOW_SIZE },
  overlayBottom: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    paddingTop: spacing.xxl,
    paddingHorizontal: spacing.xl
  },
  // Corner marks
  corner: { position: 'absolute', width: CORNER_SIZE, height: CORNER_SIZE },
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
  // Hint
  hintText: { ...typography.subhead, color: 'rgba(255,255,255,0.8)', textAlign: 'center' }
})
```

---

## Task 2: Add i18n keys

Add `scan_qr_default_hint` to each language in `context/i18n/translations.tsx`:

| Language | Key                    | Value                                   |
| -------- | ---------------------- | --------------------------------------- |
| en       | `scan_qr_default_hint` | `'Point the camera at a QR code'`       |
| zh       | `scan_qr_default_hint` | `'将相机对准二维码'`                    |
| hi       | `scan_qr_default_hint` | `'कैमरे को QR कोड पर लगाएं'`            |
| es       | `scan_qr_default_hint` | `'Apunte la cámara hacia un código QR'` |
| fr       | `scan_qr_default_hint` | `'Pointez la caméra vers un code QR'`   |
| ar       | `scan_qr_default_hint` | `'وجّه الكاميرا نحو رمز QR'`            |
| pt       | `scan_qr_default_hint` | `'Aponte a câmera para um código QR'`   |
| bn       | `scan_qr_default_hint` | `'QR কোডে ক্যামেরা তাক করুন'`           |
| ru       | `scan_qr_default_hint` | `'Направьте камеру на QR-код'`          |
| id       | `scan_qr_default_hint` | `'Arahkan kamera ke kode QR'`           |

Also add `scan_wallet_qr_hint` for the connections scanner (KJR's use case):

| Language | Key                   | Value                                                     |
| -------- | --------------------- | --------------------------------------------------------- |
| en       | `scan_wallet_qr_hint` | `'Point the camera at a wallet pairing QR code'`          |
| zh       | `scan_wallet_qr_hint` | `'将相机对准钱包配对二维码'`                              |
| hi       | `scan_wallet_qr_hint` | `'कैमरे को वॉलेट पेयरिंग QR कोड पर लगाएं'`                |
| es       | `scan_wallet_qr_hint` | `'Apunte la cámara hacia un código QR de emparejamiento'` |
| fr       | `scan_wallet_qr_hint` | `"Pointez la caméra vers un code QR d'appariement"`       |
| ar       | `scan_wallet_qr_hint` | `'وجّه الكاميرا نحو رمز QR لإقران المحفظة'`               |
| pt       | `scan_wallet_qr_hint` | `'Aponte a câmera para um código QR de emparelhamento'`   |
| bn       | `scan_wallet_qr_hint` | `'ওয়ালেট পেয়ারিং QR কোডে ক্যামেরা তাক করুন'`            |
| ru       | `scan_wallet_qr_hint` | `'Направьте камеру на QR-код сопряжения кошелька'`        |
| id       | `scan_wallet_qr_hint` | `'Arahkan kamera ke kode QR pemasangan dompet'`           |

Insert each key right after the existing `scan_identity_key_hint` line in each language block.

---

## Task 3: Refactor `app/connections.tsx`

**Minimal changes** — already uses `<QRScanner>`:

1. Add `hintText` prop:

```tsx
<QRScanner onScan={handleScan} onClose={() => setScanning(false)} hintText={t('scan_wallet_qr_hint')} />
```

2. Add `useTranslation` import if not already present.

That's it — the `handleScan` validation logic stays as-is.

---

## Task 4: Refactor `app/payments.tsx`

### Remove from `useIdentitySearch` hook (lines 112-114):

- `const [scannerVisible, setScannerVisible] = useState(false)` — KEEP (controls Modal visibility)
- `const [cameraPermission, requestCameraPermission] = useCameraPermissions()` — REMOVE (QRScanner handles internally)
- `const scanLockRef = useRef(false)` — REMOVE (QRScanner handles internally)

### Simplify `handleQRScanned` (lines 170-187):

The QRScanner now calls `onScan(data)` once and stops. The handler just needs to validate and act:

```tsx
const handleQRScanned = useCallback((data: string) => {
  const raw = data.trim()
  try {
    PublicKey.fromString(raw)
    setSearchQuery(raw)
    setRecipientKey(raw)
    setSelectedIdentity(null)
    setSearchResults([])
    setScannerVisible(false)
  } catch {
    // Not a valid key — scanner will re-enable after delay
  }
}, [])
```

Wait — there's a subtlety. In single-scan mode, the scanner fires `onScan` once and stops. But if the QR code is invalid (not a public key), we want to retry. So we need `multiScan` here, since the component doesn't know about validation.

**Revised approach**: Use `multiScan` for payments and legacy-payments too, since the caller needs to validate before deciding whether to close. The scanner's internal lock handles the 1500ms delay automatically.

```tsx
<QRScanner
  multiScan
  onScan={handleQRScanned}
  onClose={() => setScannerVisible(false)}
  hintText={t('scan_identity_key_hint')}
/>
```

### Simplify `openScanner` (lines 189-193):

No longer needs to check/request camera permission (QRScanner does it):

```tsx
const openScanner = useCallback(() => {
  setScannerVisible(true)
}, [])
```

### Update return from hook:

Remove: `cameraPermission`, `requestCameraPermission`, `handleQRScanned` (the raw handler signature changes)
The hook still returns: `scannerVisible`, `setScannerVisible`, `handleQRScanned`, `openScanner`

### Replace inline scanner JSX (lines 1150-1202):

Replace the entire `{/* ── QR Scanner Modal ─── */}` block with:

```tsx
<Modal
  visible={scannerVisible}
  animationType="slide"
  onRequestClose={() => setScannerVisible(false)}
  statusBarTranslucent
>
  <StatusBar style="light" />
  <QRScanner
    multiScan
    onScan={handleQRScanned}
    onClose={() => setScannerVisible(false)}
    hintText={t('scan_identity_key_hint')}
  />
</Modal>
```

### Remove styles (lines 1590-1689):

Delete all scanner-related styles: `scannerRoot`, `scanOverlay`, `scanTop`, `scanClose`, `scanMiddle`, `scanSide`, `scanWindow`, `scanBottom`, `scanHint`, `corner`, `cTL`, `cTR`, `cBL`, `cBR`, `permScreen`, `permIconWrap`, `permTitle`, `permBody`, `permBtn`, `permBtnText`, `permBack`.

### Remove unused imports:

- Remove `CameraView`, `useCameraPermissions` from `expo-camera` import
- Add `import QRScanner from '@/components/QRScanner'`

---

## Task 5: Refactor `app/legacy-payments.tsx`

Same pattern as payments.tsx:

### Remove from component (around line 405-450):

- Remove `cameraPermission`, `requestCameraPermission` state (lines using `useCameraPermissions`)
- Remove `scanLockRef`
- Keep `scannerVisible`, `setScannerVisible`

### Simplify `handleQRScanned`:

```tsx
const handleQRScanned = useCallback(
  (data: string) => {
    const raw = data
      .replace(/^bitcoin:/i, '')
      .split('?')[0]
      .trim()
    if (validateAddress(raw)) {
      setRecipientAddress(raw)
      setAddressError(null)
      setScannerVisible(false)
    }
    // Invalid scan — QRScanner's multiScan will auto-retry after 1500ms
  },
  [validateAddress]
)
```

### Simplify `openScanner`:

```tsx
const openScanner = useCallback(() => {
  setScannerVisible(true)
}, [])
```

### Replace inline scanner JSX (lines 830-882):

```tsx
<Modal
  visible={scannerVisible}
  animationType="slide"
  onRequestClose={() => setScannerVisible(false)}
  statusBarTranslucent
>
  <StatusBar style="light" />
  <QRScanner
    multiScan
    onScan={handleQRScanned}
    onClose={() => setScannerVisible(false)}
    hintText={t('scan_bsv_address_hint')}
  />
</Modal>
```

### Remove scanner styles (same set as payments.tsx):

Delete: `scannerRoot`, `scanOverlay`, `scanTop`, `scanClose`, `scanMiddle`, `scanSide`, `scanWindow`, `scanBottom`, `scanHint`, `corner`, `cTL`-`cBR`, `permScreen`, `permIconWrap`, `permTitle`, `permBody`, `permBtn`, `permBtnText`, `permBack`.

### Remove unused imports:

- Remove `CameraView`, `useCameraPermissions` from `expo-camera`
- Add `import QRScanner from '@/components/QRScanner'`

---

## Task 6: Refactor `app/auth/scan-shares.tsx`

This is the most complex migration because of multi-scan, progress dots, error banners, and haptics.

### Strategy

Keep scan-shares' own state management (shares, threshold, error, recovering) and use `<QRScanner>` for only the camera + overlay rendering. The progress dots, status text, and error banner go into the `renderBottom` callback.

### Changes to the component:

**Remove** the inline CameraView and overlay JSX (lines 186-256) and replace the scanner section with:

```tsx
<QRScanner
  multiScan
  onScan={data => handleBarCodeScanned({ data })}
  onClose={() => router.back()}
  hintText={
    scannedShares.length === 0
      ? t('scan_shares_scan_first')
      : t('scan_shares_progress', { scanned: scannedShares.length, needed: sharesNeeded })
  }
  renderBottom={() => (
    <>
      {/* Progress dots */}
      <View style={styles.progressRow}>
        {Array.from({ length: sharesNeeded }).map((_, i) => (
          <View
            key={i}
            style={[
              styles.progressDot,
              { backgroundColor: i < scannedShares.length ? '#34C759' : 'rgba(255,255,255,0.3)' }
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
```

**Important:** scan-shares has its own `scanLockRef` + `lastScannedRef` for handling duplicate detection and compatibility validation. But QRScanner also has a `scanLockRef` in multi-scan mode. These could conflict — QRScanner's lock prevents the same code from firing `onScan` within 1500ms, which is actually what we want. However, scan-shares also needs `lastScannedRef` to prevent re-processing the exact same QR data.

**Solution:** Keep `lastScannedRef` in scan-shares' `handleBarCodeScanned`. Remove `scanLockRef` from scan-shares since QRScanner's internal lock handles the timing. The flow:

1. QRScanner fires `onScan(data)` (its own lock prevents rapid-fire)
2. scan-shares' handler checks `lastScannedRef` for duplicate content
3. scan-shares validates, does haptics, updates state

### Remove from scan-shares:

- `CameraView`, `useCameraPermissions` imports
- `const [permission, requestPermission] = useCameraPermissions()` — QRScanner handles this
- `scanLockRef` — QRScanner handles this
- Permission screen JSX (lines 147-167) — QRScanner handles this
- Scanner overlay JSX (lines 185-256) — replaced by `<QRScanner>`
- Scanner overlay styles: `overlay`, `overlayTop`, `closeButton`, `overlayMiddle`, `overlaySide`, `scanWindow`, `overlayBottom`, `corner`, `cornerTL`-`cornerBR`, `hintText`, `statusText`
- Permission styles: `permIcon`, `permTitle`, `permBody`, `permButton`, `permButtonText`, `backLink`, `backLinkText`

### Keep in scan-shares:

- `handleBarCodeScanned` callback (minus `scanLockRef` checks)
- `handleRecovery`
- All share-related state (`scannedShares`, `threshold`, `recovering`, `recovered`, `error`)
- `lastScannedRef` for duplicate content detection
- Haptic feedback calls
- `progressRow`, `progressDot`, `errorBanner`, `errorText` styles
- `centered`, `recoveringText` styles (for the recovering spinner state)
- `container` style
- The recovering state screen (lines 171-179)

### Updated render logic:

```tsx
if (recovering) {
  return (/* recovering spinner — same as current */)
}

return (
  <View style={styles.container}>
    <StatusBar style="light" />
    <QRScanner ... />
  </View>
)
```

Note: The `!permission` early return (line 138-143) is no longer needed since QRScanner handles loading state. The `!permission.granted` screen (lines 147-167) is also handled by QRScanner.

---

## Summary of net changes

| File                            | Lines removed (approx) | Lines added (approx)                |
| ------------------------------- | ---------------------- | ----------------------------------- |
| `components/QRScanner.tsx`      | 123 (full rewrite)     | ~165                                |
| `app/connections.tsx`           | 0                      | +2 (hintText prop)                  |
| `app/payments.tsx`              | ~150                   | ~15                                 |
| `app/legacy-payments.tsx`       | ~130                   | ~15                                 |
| `app/auth/scan-shares.tsx`      | ~120                   | ~35                                 |
| `context/i18n/translations.tsx` | 0                      | ~20 (2 keys × 10 languages)         |
| **Net**                         | ~523 removed           | ~252 added = **~270 lines reduced** |

## Notes

- The `multiScan` prop is needed for payments, legacy-payments, and scan-shares (anywhere the caller validates and may need retries)
- Only connections.tsx can use default single-scan mode since it navigates on scan regardless of validity (it shows an Alert on error)
- The `renderBottom` slot keeps scan-shares' custom bottom area flexible without bloating the generic component
