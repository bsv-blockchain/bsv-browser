import React, { useState } from 'react'
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from '@/context/theme/ThemeContext'

interface QRScannerProps {
  onScan: (data: string) => void
  onClose: () => void
}

const FINDER_SIZE = 260

export default function QRScanner({ onScan, onClose }: QRScannerProps) {
  const { colors } = useTheme()
  const [permission, requestPermission] = useCameraPermissions()
  const [scanned, setScanned] = useState(false)

  if (!permission) {
    return <View style={styles.fill} />
  }

  if (!permission.granted) {
    return (
      <View style={[styles.fill, styles.centered, { backgroundColor: colors.background }]}>
        <Ionicons name="camera-outline" size={48} color={colors.textSecondary} style={{ marginBottom: 16 }} />
        <Text style={[styles.permText, { color: colors.textPrimary }]}>
          Camera access is required to scan QR codes
        </Text>
        <TouchableOpacity
          style={[styles.permBtn, { backgroundColor: colors.info }]}
          onPress={requestPermission}
        >
          <Text style={[styles.permBtnText, { color: colors.textOnAccent }]}>Allow Camera</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.cancelLink} onPress={onClose}>
          <Text style={{ color: colors.textSecondary, fontSize: 14 }}>Cancel</Text>
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
        onBarcodeScanned={scanned ? undefined : ({ data }) => {
          setScanned(true)
          onScan(data)
        }}
      />

      <View style={styles.overlay}>
        <TouchableOpacity style={styles.closeBtn} onPress={onClose}>
          <Ionicons name="close" size={28} color="#fff" />
        </TouchableOpacity>

        <View style={styles.finderBox} />

        <Text style={styles.hint}>Point at a wallet QR code</Text>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
  centered: {
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  permText: {
    fontSize: 16,
    textAlign: 'center',
    marginBottom: 24,
    lineHeight: 24,
  },
  permBtn: {
    paddingVertical: 14,
    paddingHorizontal: 32,
    borderRadius: 14,
    marginBottom: 16,
  },
  permBtnText: {
    fontWeight: '600',
    fontSize: 15,
  },
  cancelLink: {
    padding: 8,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeBtn: {
    position: 'absolute',
    top: 56,
    right: 20,
    padding: 8,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  finderBox: {
    width: FINDER_SIZE,
    height: FINDER_SIZE,
    borderWidth: 3,
    borderColor: '#fff',
    borderRadius: 16,
    backgroundColor: 'transparent',
  },
  hint: {
    marginTop: 24,
    color: '#fff',
    fontSize: 14,
    fontWeight: '500',
  },
})
