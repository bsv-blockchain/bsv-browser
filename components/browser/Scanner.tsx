import { BarcodeScanningResult, Camera, CameraView, PermissionStatus } from 'expo-camera'
import React, { useEffect, useState } from 'react'
import { Alert, StyleSheet, Text, View } from 'react-native'

interface ScannerProps {
  setScannedData: (data: string | null) => void
}

const Scanner: React.FC<ScannerProps> = ({ setScannedData }) => {
  const [hasPermission, setHasPermission] = useState<boolean | null>(null)

  useEffect(() => {
    ;(async () => {
      const { status } = await Camera.requestCameraPermissionsAsync()
      setHasPermission(status === PermissionStatus.GRANTED)
      if (status !== PermissionStatus.GRANTED) {
        Alert.alert('Camera Permission Denied', 'Please enable camera access in Settings to use the scanner.')
      }
    })()
  }, [])

  const handleBarCodeScanned = (data: string) => {
    setScannedData(data)
    console.log(`Scanned: ${data}`)
  }

  if (hasPermission === null) {
    return <Text>Loading...</Text>
  }
  if (hasPermission === false) {
    return <Text>No camera access granted.</Text>
  }

  return (
    <View style={styles.container}>
      <CameraView
        style={styles.camera}
        onBarcodeScanned={({ data }: BarcodeScanningResult) => handleBarCodeScanned(data)}
        barcodeScannerSettings={{
          barcodeTypes: ['qr']
        }}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    height: 300
  },
  camera: {
    flex: 1
  },
  preview: {
    flex: 1
  },
  overlay: {
    position: 'absolute',
    top: 50,
    left: 0,
    right: 0,
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 10
  },
  text: {
    color: '#fff',
    fontSize: 16
  },
  titleContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8
  },
  stepContainer: {
    gap: 8,
    marginBottom: 8
  }
})

export default Scanner
