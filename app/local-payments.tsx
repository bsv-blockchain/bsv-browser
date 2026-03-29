/**
 * Local Payments Screen — BLE P2P Payment Transfer
 *
 * Allows two nearby phones to exchange BSV payment data over Bluetooth LE.
 * - "Request Payment" → advertises as BLE peripheral, waits for sender
 * - "Send Payment" → scans for nearby receivers, shows list, user picks one,
 *   builds transaction, sends via BLE
 */

import React, { useState, useCallback, useEffect, useRef } from 'react'
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Image,
  Platform,
  PermissionsAndroid
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { router } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTranslation } from 'react-i18next'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, typography, radii } from '@/context/theme/tokens'
import { useWallet } from '@/context/WalletContext'
import { SatsAmountInput } from '@/components/wallet/SatsAmountInput'
import AmountDisplay from '@/components/wallet/AmountDisplay'
import { useBLETransfer } from '@/hooks/useBLETransfer'
import { IdentityClient, createNonce, PublicKey, P2PKH } from '@bsv/sdk'

import type { BLEPaymentPayload, PeerDisplayIdentity } from '@/utils/ble/types'
import { PEERPAY_PROTOCOL_ID, PEERPAY_LABEL, PEERPAY_DESCRIPTION } from '@/utils/ble/constants'

// ── Discovered Receiver (from BLE scan) ──

interface DiscoveredReceiver {
  deviceId: string
  identityKey: string
  name: string | null
  rssi: number | null
  identity: PeerDisplayIdentity | null
  resolving: boolean
}

// ── Payment Token Creation ──

async function createBLEPaymentToken(
  wallet: any,
  recipientKey: string,
  amount: number,
  senderIdentityKey: string,
  originator?: string
): Promise<BLEPaymentPayload> {
  const derivationPrefix = await createNonce(wallet, 'self', originator)
  const derivationSuffix = await createNonce(wallet, 'self', originator)

  const { publicKey: derivedKeyResult } = await wallet.getPublicKey(
    {
      protocolID: PEERPAY_PROTOCOL_ID,
      keyID: `${derivationPrefix} ${derivationSuffix}`,
      counterparty: recipientKey
    },
    originator
  )

  if (!derivedKeyResult?.trim()) throw new Error('Failed to derive recipient public key')

  const lockingScript = new P2PKH().lock(PublicKey.fromString(derivedKeyResult).toAddress()).toHex()

  const paymentAction = await wallet.createAction(
    {
      description: PEERPAY_DESCRIPTION,
      labels: [PEERPAY_LABEL],
      outputs: [
        {
          satoshis: amount,
          lockingScript,
          customInstructions: JSON.stringify({ derivationPrefix, derivationSuffix, payee: recipientKey }),
          outputDescription: 'BLE local payment'
        }
      ],
      options: { randomizeOutputs: false }
    },
    originator
  )

  if (!paymentAction.tx) throw new Error('Transaction creation failed')

  return {
    version: 1,
    senderIdentityKey,
    token: {
      customInstructions: { derivationPrefix, derivationSuffix },
      transaction: Array.from(paymentAction.tx),
      amount
    }
  }
}

// ── Identity Resolution Helper ──

async function resolveIdentity(idClient: IdentityClient, identityKey: string): Promise<PeerDisplayIdentity | null> {
  try {
    const results = await idClient.resolveByIdentityKey({ identityKey, seekPermission: false })
    if (results.length > 0) {
      const r = results[0]
      return {
        name: r.name,
        avatarURL: r.avatarURL,
        abbreviatedKey: r.abbreviatedKey,
        identityKey: r.identityKey,
        badgeIconURL: r.badgeIconURL,
        badgeLabel: r.badgeLabel
      }
    }
  } catch {
    /* best-effort */
  }
  return null
}

// ── Main Screen ──

export default function LocalPaymentsScreen() {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const { managers, adminOriginator } = useWallet()
  const wallet = managers?.permissionsManager

  const ble = useBLETransfer()
  const { state, logs } = ble

  const [sendAmount, setSendAmount] = useState('')
  const [identityKey, setIdentityKey] = useState('')
  const [showLogs, setShowLogs] = useState(true) // Default open for debugging

  // Debug BLE state
  const [debugLogs, setDebugLogs] = useState<string[]>([])
  const [debugAdvertising, setDebugAdvertising] = useState(false)
  const [debugScanning, setDebugScanning] = useState(false)
  const debugCleanupRef = useRef<Array<() => void>>([])
  const lastBsvDeviceRef = useRef<{ id: string; name: string | null } | null>(null)
  const bleManagerRef = useRef<any>(null) // react-native-ble-plx BleManager instance

  const dlog = useCallback((msg: string) => {
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false, fractionalSecondDigits: 1 })
    setDebugLogs(prev => [...prev.slice(-80), `[${ts}] ${msg}`])
  }, [])

  // Sender discovery state
  const [isScanning, setIsScanning] = useState(false)
  const [discoveredReceivers, setDiscoveredReceivers] = useState<DiscoveredReceiver[]>([])
  const [isBuildingTx, setIsBuildingTx] = useState(false)
  const [selectedReceiver, setSelectedReceiver] = useState<DiscoveredReceiver | null>(null)
  const scanCleanupRef = useRef<(() => void) | null>(null)
  const identityClientRef = useRef<IdentityClient | null>(null)

  // Fetch own identity key on mount
  useEffect(() => {
    wallet
      ?.getPublicKey({ identityKey: true }, adminOriginator)
      .then((r: any) => r && setIdentityKey(r.publicKey))
      .catch(() => {})
  }, [wallet, adminOriginator])

  // Initialize identity client
  useEffect(() => {
    if (!wallet) return
    try {
      identityClientRef.current = new IdentityClient(wallet as any, undefined, adminOriginator)
    } catch {
      /* ignore */
    }
  }, [wallet, adminOriginator])

  // Resolve peer identity when we get their key (for receiver mode)
  useEffect(() => {
    if (!state.peerIdentityKey || !identityClientRef.current) return
    resolveIdentity(identityClientRef.current, state.peerIdentityKey).then(identity => ble.setPeerIdentity(identity))
  }, [state.peerIdentityKey])

  // ── Handlers ──

  const handleRequestPayment = useCallback(async () => {
    if (!identityKey) return
    await ble.startReceiver(identityKey)
  }, [identityKey, ble])

  /** Start scanning for nearby receivers — populate discoveredReceivers list */
  const handleStartScanning = useCallback(async () => {
    if (!wallet || !identityKey) return
    const sats = Math.round(Number(sendAmount))
    if (isNaN(sats) || sats <= 0) return

    const {
      addDeviceFoundListener,
      isBluetoothEnabled,
      requestBluetoothPermission,
      startScan: rawStartScan,
      stopScan: rawStopScan,
      connect: rawConnect,
      disconnect: rawDisconnect,
      discoverServices,
      readCharacteristic
    } = await import('munim-bluetooth')
    const { BSV_PAYMENT_SERVICE_UUID: svcUUID, IDENTITY_CHARACTERISTIC_UUID } = await import('@/utils/ble/constants')

    // Request permissions (Android runtime)
    if (Platform.OS === 'android' && Platform.Version >= 31) {
      const results = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE
      ])
      const allGranted = Object.values(results).every(r => r === PermissionsAndroid.RESULTS.GRANTED)
      if (!allGranted) return
    } else if (Platform.OS === 'ios') {
      const granted = await requestBluetoothPermission()
      if (!granted) return
    }

    const enabled = await isBluetoothEnabled()
    if (!enabled) return

    // Reset state
    ble.cancel()
    setDiscoveredReceivers([])
    setSelectedReceiver(null)
    setIsScanning(true)

    // Track seen device IDs to avoid duplicate connect attempts
    const seenDevices = new Set<string>()

    const removeListener = addDeviceFoundListener(async device => {
      // Only process devices advertising our BSV service UUID
      const hasService = device.serviceUUIDs?.some(u => u?.toUpperCase().includes('B5A1E000'))
      if (!hasService || seenDevices.has(device.id)) return
      seenDevices.add(device.id)

      dlog(`BSV device found: ${device.name ?? device.id} — connecting to read identity...`)

      // Add placeholder to list immediately
      const placeholderId = device.id
      setDiscoveredReceivers(prev => [
        ...prev,
        {
          deviceId: device.id,
          identityKey: '',
          name: device.name ?? null,
          rssi: device.rssi ?? null,
          identity: null,
          resolving: true
        }
      ])

      try {
        // Connect to read the identity characteristic
        await rawConnect(device.id)
        await discoverServices(device.id)

        // Read the identity key from the GATT characteristic
        const identityHex = await readCharacteristic(device.id, svcUUID, IDENTITY_CHARACTERISTIC_UUID)
        // identityHex is the hex-encoded identity key string
        const identityKey = typeof identityHex === 'string' ? identityHex : String.fromCharCode(...(identityHex as any))

        dlog(`Identity key read: ${identityKey.substring(0, 16)}...`)

        // Disconnect — we just needed to read the key
        try {
          rawDisconnect(device.id)
        } catch {
          /* ignore */
        }

        if (!identityKey || identityKey.length < 66) {
          dlog(`Invalid identity key length: ${identityKey.length}`)
          setDiscoveredReceivers(prev => prev.filter(r => r.deviceId !== placeholderId))
          return
        }

        // Update the placeholder with the real identity key
        setDiscoveredReceivers(prev =>
          prev.map(r => (r.deviceId === placeholderId ? { ...r, identityKey, resolving: true } : r))
        )

        // Resolve display identity via IdentityClient
        if (identityClientRef.current) {
          resolveIdentity(identityClientRef.current, identityKey).then(identity => {
            setDiscoveredReceivers(prev =>
              prev.map(r => (r.deviceId === placeholderId ? { ...r, identity, resolving: false } : r))
            )
          })
        } else {
          setDiscoveredReceivers(prev => prev.map(r => (r.deviceId === placeholderId ? { ...r, resolving: false } : r)))
        }
      } catch (e: any) {
        dlog(`Failed to read identity from ${device.id}: ${e.message}`)
        // Remove the placeholder
        setDiscoveredReceivers(prev => prev.filter(r => r.deviceId !== placeholderId))
        try {
          rawDisconnect(device.id)
        } catch {
          /* ignore */
        }
      }
    })

    rawStartScan({
      serviceUUIDs: [svcUUID],
      allowDuplicates: false,
      scanMode: 'balanced'
    })

    // Store cleanup
    scanCleanupRef.current = () => {
      removeListener()
      try {
        rawStopScan()
      } catch {
        /* ignore */
      }
    }

    // Auto-stop scanning after 30 seconds
    setTimeout(() => {
      if (scanCleanupRef.current) {
        scanCleanupRef.current()
        scanCleanupRef.current = null
      }
      setIsScanning(false)
    }, 30_000)
  }, [wallet, identityKey, sendAmount, ble])

  /** Stop scanning manually */
  const handleStopScanning = useCallback(() => {
    if (scanCleanupRef.current) {
      scanCleanupRef.current()
      scanCleanupRef.current = null
    }
    setIsScanning(false)
  }, [])

  /** User picked a receiver — build TX and transfer */
  const handleSelectReceiver = useCallback(
    async (receiver: DiscoveredReceiver) => {
      if (!wallet || !identityKey) return
      const sats = Math.round(Number(sendAmount))
      if (isNaN(sats) || sats <= 0) return

      // Stop scanning
      handleStopScanning()
      setSelectedReceiver(receiver)
      setIsBuildingTx(true)

      try {
        // Build the real payment transaction targeting this specific receiver
        const payload = await createBLEPaymentToken(wallet, receiver.identityKey, sats, identityKey, adminOriginator)
        setIsBuildingTx(false)

        // Hand off to the BLE hook for connection + chunked transfer
        await ble.startSender(payload)
      } catch (error: any) {
        setIsBuildingTx(false)
        setSelectedReceiver(null)
      }
    },
    [wallet, identityKey, sendAmount, adminOriginator, ble, handleStopScanning]
  )

  /** Cancel entire send flow and return to idle */
  const handleCancelSend = useCallback(() => {
    handleStopScanning()
    setDiscoveredReceivers([])
    setSelectedReceiver(null)
    setIsBuildingTx(false)
    ble.cancel()
  }, [handleStopScanning, ble])

  // ── Internalize received payment ──

  const handleAcceptPayment = useCallback(async () => {
    if (!wallet || !state.receivedPayload) return
    try {
      const payload = state.receivedPayload
      await wallet.internalizeAction(
        {
          tx: payload.token.transaction,
          outputs: [
            {
              paymentRemittance: {
                derivationPrefix: payload.token.customInstructions.derivationPrefix,
                derivationSuffix: payload.token.customInstructions.derivationSuffix,
                senderIdentityKey: payload.senderIdentityKey
              },
              outputIndex: payload.token.outputIndex ?? 0,
              protocol: 'wallet payment'
            }
          ],
          labels: [PEERPAY_LABEL],
          description: PEERPAY_DESCRIPTION
        },
        adminOriginator
      )
    } catch {
      /* show error in UI */
    }
  }, [wallet, state.receivedPayload, adminOriginator])

  // ── Raw Debug BLE Handlers ──

  const handleDebugAdvertise = useCallback(async () => {
    try {
      const {
        requestBluetoothPermission,
        isBluetoothEnabled,
        setServices,
        startAdvertising,
        stopAdvertising,
        addEventListener
      } = await import('munim-bluetooth')
      const { BSV_PAYMENT_SERVICE_UUID, WRITE_CHARACTERISTIC_UUID, NOTIFY_CHARACTERISTIC_UUID, LOCAL_NAME_PREFIX } =
        await import('@/utils/ble/constants')

      if (debugAdvertising) {
        // Stop
        try {
          stopAdvertising()
        } catch {}
        setDebugAdvertising(false)
        dlog('STOPPED advertising')
        return
      }

      dlog('Requesting BLE permissions...')
      if (Platform.OS === 'android' && Platform.Version >= 31) {
        const results = await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE
        ])
        dlog(`Android permissions: ${JSON.stringify(results)}`)
      } else {
        const ok = await requestBluetoothPermission()
        dlog(`requestBluetoothPermission: ${ok}`)
      }

      const enabled = await isBluetoothEnabled()
      dlog(`isBluetoothEnabled: ${enabled}`)
      if (!enabled) {
        dlog('ERROR: Bluetooth not enabled')
        return
      }

      // Set up minimal GATT service
      dlog('Setting up GATT service...')
      try {
        setServices([
          {
            uuid: BSV_PAYMENT_SERVICE_UUID,
            characteristics: [
              { uuid: WRITE_CHARACTERISTIC_UUID, properties: ['write', 'writeWithoutResponse'], value: '' },
              { uuid: NOTIFY_CHARACTERISTIC_UUID, properties: ['read', 'notify'], value: '' }
            ]
          }
        ])
        dlog(`GATT service set: ${BSV_PAYMENT_SERVICE_UUID}`)
      } catch (e: any) {
        dlog(`ERROR setServices: ${e.message}`)
        return
      }

      // Listen for ANY events
      const events = ['deviceFound', 'connectionStateChanged', 'characteristicValueChanged']
      for (const evt of events) {
        const cleanup = addEventListener(evt, (data: any) => {
          dlog(`EVENT[${evt}]: ${JSON.stringify(data).substring(0, 200)}`)
        })
        debugCleanupRef.current.push(cleanup)
      }

      // Advertise
      const localName = LOCAL_NAME_PREFIX + (identityKey || 'test1234')
      dlog(`Starting advertising: localName="${localName.substring(0, 30)}..."`)
      try {
        startAdvertising({
          serviceUUIDs: [BSV_PAYMENT_SERVICE_UUID],
          localName
        })
        setDebugAdvertising(true)
        dlog('Advertising STARTED')
      } catch (e: any) {
        dlog(`ERROR startAdvertising: ${e.message}`)
      }
    } catch (e: any) {
      dlog(`EXCEPTION: ${e.message}`)
    }
  }, [debugAdvertising, identityKey, dlog])

  const handleDebugFind = useCallback(async () => {
    try {
      const { BleManager } = await import('react-native-ble-plx')
      const { BSV_PAYMENT_SERVICE_UUID } = await import('@/utils/ble/constants')

      if (debugScanning) {
        bleManagerRef.current?.stopDeviceScan()
        setDebugScanning(false)
        dlog('STOPPED scanning')
        return
      }

      // Create BLE manager if needed
      if (!bleManagerRef.current) {
        bleManagerRef.current = new BleManager()
        dlog('BleManager created (react-native-ble-plx)')
      }
      const mgr = bleManagerRef.current

      dlog('Requesting BLE permissions...')
      if (Platform.OS === 'android' && Platform.Version >= 31) {
        const results = await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE
        ])
        dlog(`Android permissions: ${JSON.stringify(results)}`)
      }

      let bsvCount = 0
      let totalCount = 0

      // ble-plx scan: callback per device, filter by service UUID
      dlog(`Scanning for service ${BSV_PAYMENT_SERVICE_UUID.substring(0, 12)}...`)
      setDebugScanning(true)

      mgr.startDeviceScan(
        [BSV_PAYMENT_SERVICE_UUID], // Filter by our service UUID
        { allowDuplicates: false },
        (error: any, device: any) => {
          if (error) {
            dlog(`SCAN ERROR: ${error.message}`)
            setDebugScanning(false)
            return
          }
          if (!device) return
          totalCount++
          bsvCount++
          const name = device.localName || device.name || '(no name)'
          dlog(`BSV DEVICE #${bsvCount}: name="${name}" id=${device.id.substring(0, 16)}... rssi=${device.rssi ?? '?'}`)
          dlog(`  localName="${device.localName}" name="${device.name}"`)
          dlog(`  serviceUUIDs=${JSON.stringify(device.serviceUUIDs)}`)
          // Store for Connect button
          lastBsvDeviceRef.current = { id: device.id, name: name }
          dlog(`  >> Tap "Connect" to read identity from this device`)
        }
      )

      // Auto-stop after 20s
      setTimeout(() => {
        mgr.stopDeviceScan()
        setDebugScanning(false)
        dlog(`Scan stopped. Found ${bsvCount} BSV device(s)`)
      }, 20_000)
    } catch (e: any) {
      dlog(`EXCEPTION: ${e.message}`)
    }
  }, [debugScanning, dlog])

  const handleDebugClear = useCallback(() => {
    if (debugAdvertising) {
      import('munim-bluetooth').then(m => {
        try {
          m.stopAdvertising()
        } catch {}
      })
      setDebugAdvertising(false)
    }
    if (debugScanning) {
      bleManagerRef.current?.stopDeviceScan()
      setDebugScanning(false)
    }
    for (const fn of debugCleanupRef.current) {
      try {
        fn()
      } catch {}
    }
    debugCleanupRef.current = []
    setDebugLogs([])
    dlog('Cleared')
  }, [debugAdvertising, debugScanning, dlog])

  const handleDebugConnect = useCallback(async () => {
    const target = lastBsvDeviceRef.current
    if (!target) {
      dlog('No BSV device found yet — tap Find first')
      return
    }

    try {
      const { BSV_PAYMENT_SERVICE_UUID, IDENTITY_CHARACTERISTIC_UUID } = await import('@/utils/ble/constants')

      if (!bleManagerRef.current) {
        const { BleManager } = await import('react-native-ble-plx')
        bleManagerRef.current = new BleManager()
      }
      const mgr = bleManagerRef.current

      // Stop scanning if still running
      mgr.stopDeviceScan()
      setDebugScanning(false)

      dlog(`Connecting to ${target.name ?? target.id}...`)
      const device = await mgr.connectToDevice(target.id)
      dlog('Connected!')

      dlog('Discovering all services and characteristics...')
      await device.discoverAllServicesAndCharacteristics()
      dlog('Discovery complete')

      // List all services
      const services = await device.services()
      dlog(`Found ${services.length} service(s):`)
      for (const svc of services) {
        dlog(`  Service: ${svc.uuid}`)
        const chars = await svc.characteristics()
        for (const char of chars) {
          dlog(
            `    Char: ${char.uuid} readable=${char.isReadable} writable=${char.isWritableWithResponse || char.isWritableWithoutResponse}`
          )
        }
      }

      // Read the identity characteristic
      dlog(`Reading identity char ${IDENTITY_CHARACTERISTIC_UUID.substring(0, 12)}...`)
      try {
        const char = await device.readCharacteristicForService(BSV_PAYMENT_SERVICE_UUID, IDENTITY_CHARACTERISTIC_UUID)
        const base64Value = char.value
        dlog(`Raw value (base64): ${base64Value}`)

        if (base64Value) {
          // ble-plx returns base64 — decode to string
          const decoded = atob(base64Value)
          dlog(`Decoded value: ${decoded.substring(0, 80)}`)
          dlog(`Length: ${decoded.length} chars`)

          if (decoded.length >= 66) {
            dlog('SUCCESS — valid identity key read!')
            if (identityClientRef.current) {
              dlog('Resolving identity via IdentityClient...')
              const identity = await resolveIdentity(identityClientRef.current, decoded.substring(0, 66))
              if (identity) {
                dlog(`IDENTITY: ${identity.name} (${identity.abbreviatedKey})`)
                if (identity.badgeLabel) dlog(`  Badge: ${identity.badgeLabel}`)
              } else {
                dlog('No identity found for this key')
              }
            }
          }
        } else {
          dlog('Characteristic value is empty/null')
        }
      } catch (e: any) {
        dlog(`ERROR reading characteristic: ${e.message}`)
      }

      dlog('Disconnecting...')
      await device.cancelConnection()
      dlog('Done!')
    } catch (e: any) {
      dlog(`ERROR: ${e.message}`)
      try {
        bleManagerRef.current?.cancelDeviceConnection(lastBsvDeviceRef.current?.id ?? '')
      } catch {}
    }
  }, [dlog])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (scanCleanupRef.current) {
        scanCleanupRef.current()
        scanCleanupRef.current = null
      }
      for (const fn of debugCleanupRef.current) {
        try {
          fn()
        } catch {}
      }
      debugCleanupRef.current = []
      if (bleManagerRef.current) {
        bleManagerRef.current.stopDeviceScan()
        bleManagerRef.current.destroy()
        bleManagerRef.current = null
      }
    }
  }, [])

  // ── Render Helpers ──

  const isIdle =
    state.phase === 'idle' && !isScanning && discoveredReceivers.length === 0 && !isBuildingTx && !selectedReceiver
  const isSendFlow = isScanning || discoveredReceivers.length > 0 || isBuildingTx
  const canSend = sendAmount.length > 0 && Number(sendAmount) > 0 && !!wallet

  return (
    <View style={[styles.container, { backgroundColor: colors.backgroundSecondary, paddingTop: insets.top }]}>
      {/* ── Header ── */}
      <View style={[styles.header, { borderBottomColor: colors.separator }]}>
        <TouchableOpacity
          onPress={() => {
            handleCancelSend()
            router.back()
          }}
          style={styles.headerButton}
        >
          <Ionicons name="chevron-back" size={24} color={colors.accent} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.textPrimary }]}>{t('local_payments')}</Text>
        <TouchableOpacity onPress={() => setShowLogs(v => !v)} style={styles.headerButton}>
          <Ionicons
            name={showLogs ? 'code-slash' : 'code-slash-outline'}
            size={20}
            color={showLogs ? colors.info : colors.textSecondary}
          />
        </TouchableOpacity>
      </View>

      <ScrollView
        style={{ flex: 1, backgroundColor: colors.background }}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {/* ── BLE Debug Panel (always visible) ── */}
        <View
          style={[styles.debugPanel, { backgroundColor: colors.backgroundTertiary, borderColor: colors.separator }]}
        >
          <Text style={[styles.debugTitle, { color: colors.textPrimary }]}>BLE Debug</Text>
          <View style={styles.debugButtonRow}>
            <TouchableOpacity
              style={[styles.debugButton, { backgroundColor: debugAdvertising ? colors.error : colors.info }]}
              onPress={handleDebugAdvertise}
            >
              <Ionicons name={debugAdvertising ? 'stop' : 'radio-outline'} size={16} color="#fff" />
              <Text style={styles.debugButtonText}>{debugAdvertising ? 'Stop Ad' : 'Advertise'}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.debugButton, { backgroundColor: debugScanning ? colors.error : colors.success }]}
              onPress={handleDebugFind}
            >
              <Ionicons name={debugScanning ? 'stop' : 'search'} size={16} color="#fff" />
              <Text style={styles.debugButtonText}>{debugScanning ? 'Stop' : 'Find'}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.debugButton, { backgroundColor: colors.warning }]}
              onPress={handleDebugConnect}
            >
              <Ionicons name="link" size={16} color="#fff" />
              <Text style={styles.debugButtonText}>Connect</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.debugButton, { backgroundColor: colors.textTertiary }]}
              onPress={handleDebugClear}
            >
              <Ionicons name="trash-outline" size={16} color="#fff" />
              <Text style={styles.debugButtonText}>Clear</Text>
            </TouchableOpacity>
          </View>
          {debugLogs.length > 0 && (
            <ScrollView style={styles.debugLogScroll} nestedScrollEnabled>
              {debugLogs.map((line, i) => (
                <Text
                  key={i}
                  style={[
                    styles.debugLogLine,
                    {
                      color:
                        line.includes('ERROR') || line.includes('EXCEPTION')
                          ? colors.error
                          : line.includes('FOUND')
                            ? colors.success
                            : line.includes('STARTED') || line.includes('EVENT')
                              ? colors.info
                              : colors.textSecondary
                    }
                  ]}
                  selectable
                >
                  {line}
                </Text>
              ))}
            </ScrollView>
          )}
        </View>

        {/* ── Idle State ── */}
        {isIdle && (
          <>
            <View style={styles.iconContainer}>
              <View style={[styles.iconCircle, { backgroundColor: colors.info + '15' }]}>
                <Ionicons name="bluetooth" size={48} color={colors.info} />
              </View>
              <Text style={[styles.subtitle, { color: colors.textSecondary }]}>{t('local_payments_subtitle')}</Text>
            </View>

            <View style={styles.fieldGroup}>
              <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>{t('amount_sats')}</Text>
              <SatsAmountInput value={sendAmount} onChangeText={setSendAmount} />
            </View>

            <View style={styles.buttonRow}>
              <TouchableOpacity
                style={[styles.actionButton, { backgroundColor: colors.accent }]}
                onPress={handleRequestPayment}
                disabled={!identityKey}
              >
                <Ionicons name="download-outline" size={22} color={colors.background} />
                <Text style={[styles.actionButtonText, { color: colors.background }]}>{t('request_payment')}</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.actionButton, { backgroundColor: canSend ? colors.success : colors.success + '40' }]}
                onPress={handleStartScanning}
                disabled={!canSend}
              >
                <Ionicons name="send-outline" size={22} color="#fff" />
                <Text style={[styles.actionButtonText, { color: '#fff' }]}>{t('send_payment')}</Text>
              </TouchableOpacity>
            </View>
          </>
        )}

        {/* ── Sender: Scanning / Discovered Receivers ── */}
        {isSendFlow && state.phase === 'idle' && !isBuildingTx && (
          <View>
            {/* Scanning header */}
            <View style={styles.scanHeader}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.scanTitle, { color: colors.textPrimary }]}>{t('searching_receiver')}</Text>
                <Text style={[styles.scanSubtitle, { color: colors.textSecondary }]}>
                  {discoveredReceivers.length === 0
                    ? t('scanning_status')
                    : `${discoveredReceivers.length} device${discoveredReceivers.length !== 1 ? 's' : ''} found`}
                </Text>
              </View>
              {isScanning && <ActivityIndicator color={colors.info} />}
            </View>

            {/* Amount badge */}
            <View
              style={[
                styles.amountBadge,
                { backgroundColor: colors.success + '15', borderColor: colors.success + '30' }
              ]}
            >
              <Text style={[styles.amountBadgeText, { color: colors.success }]}>Sending: {sendAmount} sats</Text>
            </View>

            {/* Discovered receivers list */}
            {discoveredReceivers.length > 0 && (
              <View style={[styles.receiverList, { borderColor: colors.separator }]}>
                {discoveredReceivers.map((receiver, idx) => (
                  <TouchableOpacity
                    key={receiver.identityKey}
                    style={[
                      styles.receiverRow,
                      { borderBottomColor: colors.separator },
                      idx === discoveredReceivers.length - 1 && { borderBottomWidth: 0 }
                    ]}
                    onPress={() => handleSelectReceiver(receiver)}
                    activeOpacity={0.6}
                  >
                    {/* Avatar */}
                    {receiver.identity?.avatarURL ? (
                      <Image source={{ uri: receiver.identity.avatarURL }} style={styles.receiverAvatar} />
                    ) : (
                      <View style={[styles.receiverAvatarPlaceholder, { backgroundColor: colors.info + '15' }]}>
                        <Ionicons name="person" size={20} color={colors.info} />
                      </View>
                    )}

                    {/* Info */}
                    <View style={styles.receiverInfo}>
                      {receiver.resolving ? (
                        <Text style={[styles.receiverName, { color: colors.textSecondary }]}>Resolving...</Text>
                      ) : receiver.identity ? (
                        <>
                          <Text style={[styles.receiverName, { color: colors.textPrimary }]} numberOfLines={1}>
                            {receiver.identity.name}
                          </Text>
                          {receiver.identity.badgeLabel ? (
                            <Text style={[styles.receiverBadgeLabel, { color: colors.info }]} numberOfLines={1}>
                              {receiver.identity.badgeLabel}
                            </Text>
                          ) : null}
                        </>
                      ) : (
                        <Text style={[styles.receiverName, { color: colors.textPrimary }]}>Unknown</Text>
                      )}
                      <Text
                        style={[styles.receiverKey, { color: colors.textTertiary }]}
                        numberOfLines={1}
                        ellipsizeMode="middle"
                      >
                        {receiver.identity?.abbreviatedKey || receiver.identityKey}
                      </Text>
                    </View>

                    {/* RSSI indicator + arrow */}
                    <View style={styles.receiverTrailing}>
                      {receiver.rssi != null && (
                        <Ionicons
                          name={
                            receiver.rssi > -60 ? 'wifi' : receiver.rssi > -80 ? 'wifi-outline' : 'cellular-outline'
                          }
                          size={14}
                          color={colors.textTertiary}
                        />
                      )}
                      <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
                    </View>
                  </TouchableOpacity>
                ))}
              </View>
            )}

            {/* Empty state during scan */}
            {discoveredReceivers.length === 0 && isScanning && (
              <View style={styles.emptyState}>
                <Ionicons name="radio-outline" size={40} color={colors.textTertiary} />
                <Text style={[styles.emptyStateText, { color: colors.textTertiary }]}>{t('scanning_status')}</Text>
              </View>
            )}

            {/* No results after scan finished */}
            {discoveredReceivers.length === 0 && !isScanning && (
              <View style={styles.emptyState}>
                <Ionicons name="alert-circle-outline" size={40} color={colors.textTertiary} />
                <Text style={[styles.emptyStateText, { color: colors.textTertiary }]}>
                  No nearby receivers found. Make sure the other device is in "Request Payment" mode.
                </Text>
              </View>
            )}

            {/* Scan controls */}
            <View style={[styles.buttonRow, { marginTop: spacing.lg }]}>
              <TouchableOpacity
                style={[styles.cancelButton, { borderColor: colors.separator, flex: 1 }]}
                onPress={handleCancelSend}
              >
                <Text style={[styles.cancelButtonText, { color: colors.textSecondary }]}>{t('cancel')}</Text>
              </TouchableOpacity>
              {!isScanning && (
                <TouchableOpacity
                  style={[styles.actionButton, { backgroundColor: colors.info, flex: 1 }]}
                  onPress={handleStartScanning}
                >
                  <Ionicons name="refresh" size={18} color="#fff" />
                  <Text style={[styles.actionButtonText, { color: '#fff' }]}>Rescan</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        )}

        {/* ── Sender: Building Transaction ── */}
        {isBuildingTx && (
          <StatusDisplay
            icon="construct-outline"
            iconColor={colors.info}
            title={t('building_transaction')}
            subtitle={
              selectedReceiver?.identity?.name
                ? `Payment to ${selectedReceiver.identity.name}`
                : `Payment to ${selectedReceiver?.identityKey.substring(0, 12)}...`
            }
            colors={colors}
            showSpinner
            peerIdentity={selectedReceiver?.identity}
          />
        )}

        {/* ── BLE Hook States ── */}
        {state.phase === 'requesting_permission' && (
          <StatusDisplay
            icon="bluetooth"
            iconColor={colors.info}
            title={t('checking_bluetooth')}
            subtitle={state.statusText}
            colors={colors}
            showSpinner
          />
        )}

        {state.phase === 'permission_denied' && (
          <StatusDisplay
            icon="close-circle"
            iconColor={colors.error}
            title={t('bluetooth_unavailable')}
            subtitle={state.errorMessage ?? ''}
            colors={colors}
          >
            <TouchableOpacity style={[styles.retryButton, { backgroundColor: colors.accent }]} onPress={ble.reset}>
              <Text style={[styles.retryButtonText, { color: colors.background }]}>{t('go_back')}</Text>
            </TouchableOpacity>
          </StatusDisplay>
        )}

        {state.phase === 'advertising' && (
          <StatusDisplay
            icon="radio-outline"
            iconColor={colors.info}
            title={t('waiting_for_sender')}
            subtitle={t('advertising_status')}
            colors={colors}
            showSpinner
          >
            <TouchableOpacity style={[styles.cancelButton, { borderColor: colors.separator }]} onPress={ble.cancel}>
              <Text style={[styles.cancelButtonText, { color: colors.textSecondary }]}>{t('cancel')}</Text>
            </TouchableOpacity>
          </StatusDisplay>
        )}

        {state.phase === 'scanning' && (
          <StatusDisplay
            icon="search"
            iconColor={colors.info}
            title={t('searching_receiver')}
            subtitle={t('scanning_status')}
            colors={colors}
            showSpinner
          >
            <TouchableOpacity style={[styles.cancelButton, { borderColor: colors.separator }]} onPress={ble.cancel}>
              <Text style={[styles.cancelButtonText, { color: colors.textSecondary }]}>{t('cancel')}</Text>
            </TouchableOpacity>
          </StatusDisplay>
        )}

        {(state.phase === 'connecting' || state.phase === 'connected') && (
          <StatusDisplay
            icon={state.phase === 'connecting' ? 'link' : 'checkmark-circle'}
            iconColor={state.phase === 'connecting' ? colors.info : colors.success}
            title={state.phase === 'connecting' ? t('connecting_peer') : t('connected')}
            subtitle={state.statusText}
            colors={colors}
            showSpinner={state.phase === 'connecting'}
            peerIdentity={state.peerIdentity ?? selectedReceiver?.identity}
          />
        )}

        {state.phase === 'transferring' && (
          <StatusDisplay
            icon="swap-horizontal"
            iconColor={colors.info}
            title={state.role === 'sender' ? t('sending_payment') : t('receiving_payment')}
            subtitle={`${state.progress}%`}
            colors={colors}
            peerIdentity={state.peerIdentity ?? selectedReceiver?.identity}
          >
            <View style={[styles.progressTrack, { backgroundColor: colors.separator }]}>
              <View style={[styles.progressFill, { backgroundColor: colors.info, width: `${state.progress}%` }]} />
            </View>
            <TouchableOpacity
              style={[styles.cancelButton, { borderColor: colors.separator, marginTop: spacing.md }]}
              onPress={ble.cancel}
            >
              <Text style={[styles.cancelButtonText, { color: colors.textSecondary }]}>{t('cancel')}</Text>
            </TouchableOpacity>
          </StatusDisplay>
        )}

        {state.phase === 'complete' && (
          <StatusDisplay
            icon="checkmark-circle"
            iconColor={colors.success}
            title={state.role === 'sender' ? t('payment_sent') : t('payment_received')}
            subtitle=""
            colors={colors}
            peerIdentity={state.peerIdentity ?? selectedReceiver?.identity}
          >
            {state.amount != null && (
              <Text style={[styles.completedAmount, { color: colors.textPrimary }]}>
                <AmountDisplay>{state.amount}</AmountDisplay>
              </Text>
            )}
            {state.peerIdentityKey && (
              <Text
                style={[styles.peerKeyText, { color: colors.textSecondary }]}
                numberOfLines={1}
                ellipsizeMode="middle"
              >
                {state.role === 'sender' ? 'To: ' : 'From: '}
                {state.peerIdentityKey}
              </Text>
            )}
            {state.role === 'receiver' && state.receivedPayload && (
              <TouchableOpacity
                style={[styles.acceptPaymentButton, { backgroundColor: colors.success }]}
                onPress={handleAcceptPayment}
              >
                <Ionicons name="wallet-outline" size={20} color="#fff" />
                <Text style={[styles.acceptPaymentText]}>{t('accept_to_wallet')}</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={[styles.retryButton, { backgroundColor: colors.accent, marginTop: spacing.md }]}
              onPress={() => {
                handleCancelSend()
                ble.reset()
              }}
            >
              <Text style={[styles.retryButtonText, { color: colors.background }]}>{t('done')}</Text>
            </TouchableOpacity>
          </StatusDisplay>
        )}

        {state.phase === 'error' && (
          <StatusDisplay
            icon="alert-circle"
            iconColor={colors.error}
            title={state.statusText || t('transfer_failed')}
            subtitle={state.errorMessage ?? ''}
            colors={colors}
          >
            <TouchableOpacity
              style={[styles.retryButton, { backgroundColor: colors.accent }]}
              onPress={() => {
                handleCancelSend()
                ble.reset()
              }}
            >
              <Text style={[styles.retryButtonText, { color: colors.background }]}>{t('try_again')}</Text>
            </TouchableOpacity>
          </StatusDisplay>
        )}

        {/* ── Debug Log Panel ── */}
        {showLogs && logs.length > 0 && (
          <View
            style={[styles.logPanel, { backgroundColor: colors.backgroundTertiary, borderColor: colors.separator }]}
          >
            <Text style={[styles.logPanelTitle, { color: colors.textSecondary }]}>BLE Debug Log</Text>
            {logs.slice(-30).map((entry, i) => (
              <Text
                key={i}
                style={[
                  styles.logEntry,
                  {
                    color:
                      entry.direction === 'error'
                        ? colors.error
                        : entry.direction === 'tx'
                          ? colors.info
                          : entry.direction === 'rx'
                            ? colors.success
                            : colors.textSecondary
                  }
                ]}
                numberOfLines={2}
              >
                {entry.direction.toUpperCase().padEnd(5)} {entry.message}
              </Text>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  )
}

// ── Status Display Component ──

function StatusDisplay({
  icon,
  iconColor,
  title,
  subtitle,
  colors,
  showSpinner,
  peerIdentity,
  children
}: {
  icon: keyof typeof Ionicons.glyphMap
  iconColor: string
  title: string
  subtitle: string
  colors: any
  showSpinner?: boolean
  peerIdentity?: PeerDisplayIdentity | null
  children?: React.ReactNode
}) {
  return (
    <View style={styles.statusContainer}>
      {peerIdentity && (
        <View style={[styles.peerCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.separator }]}>
          {peerIdentity.avatarURL ? (
            <Image source={{ uri: peerIdentity.avatarURL }} style={styles.peerAvatar} />
          ) : (
            <View style={[styles.peerAvatarPlaceholder, { backgroundColor: colors.info + '20' }]}>
              <Ionicons name="person" size={24} color={colors.info} />
            </View>
          )}
          <View style={styles.peerInfoCol}>
            <Text style={[styles.peerName, { color: colors.textPrimary }]} numberOfLines={1}>
              {peerIdentity.name}
            </Text>
            <Text style={[styles.peerKey, { color: colors.textTertiary }]} numberOfLines={1} ellipsizeMode="middle">
              {peerIdentity.abbreviatedKey || peerIdentity.identityKey}
            </Text>
          </View>
          {peerIdentity.badgeIconURL ? (
            <Image source={{ uri: peerIdentity.badgeIconURL }} style={styles.peerBadge} />
          ) : null}
        </View>
      )}

      <View style={[styles.statusIconCircle, { backgroundColor: iconColor + '15' }]}>
        {showSpinner ? (
          <ActivityIndicator size="large" color={iconColor} />
        ) : (
          <Ionicons name={icon} size={48} color={iconColor} />
        )}
      </View>

      <Text style={[styles.statusTitle, { color: colors.textPrimary }]}>{title}</Text>
      {subtitle ? <Text style={[styles.statusSubtitle, { color: colors.textSecondary }]}>{subtitle}</Text> : null}
      {children}
    </View>
  )
}

// ── Styles ──

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth
  },
  headerButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { ...typography.headline, fontWeight: '600' },
  content: { padding: spacing.lg, paddingBottom: spacing.xxxl },

  // Idle
  iconContainer: { alignItems: 'center', marginVertical: spacing.xl },
  iconCircle: {
    width: 96,
    height: 96,
    borderRadius: 48,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md
  },
  subtitle: { ...typography.subhead, textAlign: 'center', paddingHorizontal: spacing.xl },
  fieldGroup: { marginBottom: spacing.lg },
  fieldLabel: { ...typography.subhead, marginBottom: spacing.sm, fontWeight: '500' },
  buttonRow: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.sm },
  actionButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    borderRadius: radii.md
  },
  actionButtonText: { ...typography.body, fontWeight: '600' },

  // Scanning / discovered receivers
  scanHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.md, gap: spacing.md },
  scanTitle: { ...typography.title3, fontWeight: '700' },
  scanSubtitle: { ...typography.subhead, marginTop: 2 },
  amountBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.sm,
    borderWidth: 1,
    marginBottom: spacing.lg
  },
  amountBadgeText: { ...typography.footnote, fontWeight: '600' },
  receiverList: { borderRadius: radii.md, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  receiverRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth
  },
  receiverAvatar: { width: 42, height: 42, borderRadius: 21 },
  receiverAvatarPlaceholder: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center'
  },
  receiverInfo: { flex: 1, minWidth: 0 },
  receiverName: { ...typography.body, fontWeight: '600', marginBottom: 1 },
  receiverBadgeLabel: { ...typography.caption2, fontWeight: '500', marginBottom: 1 },
  receiverKey: { ...typography.caption2, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  receiverTrailing: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  emptyState: { alignItems: 'center', paddingVertical: spacing.xxl, gap: spacing.md },
  emptyStateText: { ...typography.subhead, textAlign: 'center', paddingHorizontal: spacing.xl },

  // Status display
  statusContainer: { alignItems: 'center', paddingVertical: spacing.xxl },
  statusIconCircle: {
    width: 96,
    height: 96,
    borderRadius: 48,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg
  },
  statusTitle: { ...typography.title3, fontWeight: '700', textAlign: 'center', marginBottom: spacing.xs },
  statusSubtitle: { ...typography.subhead, textAlign: 'center', marginBottom: spacing.lg },

  // Progress
  progressTrack: { height: 6, borderRadius: 3, width: '100%', maxWidth: 280, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 3 },

  // Buttons
  cancelButton: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm,
    borderRadius: radii.md,
    borderWidth: 1,
    marginTop: spacing.lg,
    alignItems: 'center'
  },
  cancelButtonText: { ...typography.body, fontWeight: '500' },
  retryButton: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radii.md,
    alignItems: 'center'
  },
  retryButtonText: { ...typography.body, fontWeight: '600' },

  // Complete
  completedAmount: { fontSize: 34, fontWeight: '700', letterSpacing: 0.4, marginBottom: spacing.sm },
  peerKeyText: {
    ...typography.caption1,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    marginBottom: spacing.lg,
    maxWidth: 280
  },
  acceptPaymentButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xl,
    borderRadius: radii.md,
    marginTop: spacing.md
  },
  acceptPaymentText: { ...typography.body, color: '#fff', fontWeight: '600' },

  // Peer card
  peerCard: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: spacing.xl,
    gap: spacing.md,
    width: '100%',
    maxWidth: 320
  },
  peerAvatar: { width: 44, height: 44, borderRadius: 22 },
  peerAvatarPlaceholder: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  peerInfoCol: { flex: 1, minWidth: 0 },
  peerName: { ...typography.body, fontWeight: '600' },
  peerKey: { ...typography.caption2, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  peerBadge: { width: 20, height: 20, borderRadius: 10 },

  // Debug log
  logPanel: {
    marginTop: spacing.xl,
    padding: spacing.md,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth
  },
  logPanelTitle: { ...typography.caption1, fontWeight: '600', marginBottom: spacing.sm },
  logEntry: {
    ...typography.caption2,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    lineHeight: 16,
    marginBottom: 2
  },

  // Debug panel
  debugPanel: {
    padding: spacing.md,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: spacing.lg
  },
  debugTitle: {
    ...typography.subhead,
    fontWeight: '700',
    marginBottom: spacing.sm
  },
  debugButtonRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.sm
  },
  debugButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: spacing.sm,
    borderRadius: radii.sm
  },
  debugButtonText: {
    ...typography.caption1,
    color: '#fff',
    fontWeight: '600'
  },
  debugLogScroll: {
    maxHeight: 300,
    marginTop: spacing.xs
  },
  debugLogLine: {
    ...typography.caption2,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    lineHeight: 15,
    marginBottom: 1
  }
})
