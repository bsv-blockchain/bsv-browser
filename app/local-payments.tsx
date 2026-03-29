/**
 * Local Payments Screen — BLE P2P Payment Transfer
 *
 * UX Flow:
 * 1. Choose role: "Send" or "Receive"
 * 2. Receive: advertise via BLE, wait for sender, show progress, show success
 * 3. Send: scan for nearby receivers → pick one (shows identity) → enter amount → confirm → transfer → success
 *
 * Uses:
 * - munim-bluetooth for peripheral mode (advertising, GATT server)
 * - react-native-ble-plx for central mode (scan, connect, read, write)
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
import { IdentityClient, createNonce, PublicKey, P2PKH } from '@bsv/sdk'

import type { BLEPaymentPayload, PeerDisplayIdentity } from '@/utils/ble/types'
import {
  BSV_PAYMENT_SERVICE_UUID,
  IDENTITY_CHARACTERISTIC_UUID,
  WRITE_CHARACTERISTIC_UUID,
  NOTIFY_CHARACTERISTIC_UUID,
  PEERPAY_PROTOCOL_ID,
  PEERPAY_LABEL,
  PEERPAY_DESCRIPTION
} from '@/utils/ble/constants'
import {
  chunkPayload,
  serializePayload,
  uint8ArrayToHex,
  ChunkReassembler,
  hexToUint8Array,
  deserializePayload
} from '@/utils/ble/chunking'
import { processIncomingChunk, teardownPeripheral } from '@/utils/ble/peripheral'

// ── Types ──

type ScreenPhase =
  | 'role_select'
  | 'receiving_wait'
  | 'receiving_progress'
  | 'sending_scan'
  | 'sending_confirm'
  | 'sending_amount'
  | 'transferring'
  | 'complete'
  | 'error'

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
  const action = await wallet.createAction(
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
  if (!action.tx) throw new Error('Transaction creation failed')
  return {
    version: 1,
    senderIdentityKey,
    token: { customInstructions: { derivationPrefix, derivationSuffix }, transaction: Array.from(action.tx), amount }
  }
}

// ── Identity Resolution ──

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

  // Core state
  const [phase, setPhase] = useState<ScreenPhase>('role_select')
  const [identityKey, setIdentityKey] = useState('')
  const [errorMsg, setErrorMsg] = useState('')

  // Sender state
  const [discoveredReceivers, setDiscoveredReceivers] = useState<DiscoveredReceiver[]>([])
  const [selectedReceiver, setSelectedReceiver] = useState<DiscoveredReceiver | null>(null)
  const [sendAmount, setSendAmount] = useState('')
  const [progress, setProgress] = useState(0)
  const [completedAmount, setCompletedAmount] = useState(0)
  const [completedRole, setCompletedRole] = useState<'sender' | 'receiver'>('sender')

  // Receiver state
  const [receivedPayload, setReceivedPayload] = useState<BLEPaymentPayload | null>(null)

  // Debug
  const [showDebug, setShowDebug] = useState(false)
  const [debugLogs, setDebugLogs] = useState<string[]>([])

  // Refs
  const bleManagerRef = useRef<any>(null)
  const identityClientRef = useRef<IdentityClient | null>(null)
  const cleanupRef = useRef<Array<() => void>>([])

  const dlog = useCallback((msg: string) => {
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false })
    setDebugLogs(prev => [...prev.slice(-100), `[${ts}] ${msg}`])
  }, [])

  // ── Init ──

  useEffect(() => {
    wallet
      ?.getPublicKey({ identityKey: true }, adminOriginator)
      .then((r: any) => r && setIdentityKey(r.publicKey))
      .catch(() => {})
  }, [wallet, adminOriginator])

  useEffect(() => {
    if (!wallet) return
    try {
      identityClientRef.current = new IdentityClient(wallet as any, undefined, adminOriginator)
    } catch {}
  }, [wallet, adminOriginator])

  // ── BLE Manager (ble-plx, for central) ──

  const getBleManager = useCallback(async () => {
    if (!bleManagerRef.current) {
      const { BleManager } = await import('react-native-ble-plx')
      bleManagerRef.current = new BleManager()
    }
    return bleManagerRef.current
  }, [])

  // ── Permission Helper ──

  const ensurePermissions = useCallback(async (): Promise<boolean> => {
    if (Platform.OS === 'android' && Platform.Version >= 31) {
      const r = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE
      ])
      return Object.values(r).every(v => v === PermissionsAndroid.RESULTS.GRANTED)
    }
    if (Platform.OS === 'ios') {
      const { requestBluetoothPermission } = await import('munim-bluetooth')
      return requestBluetoothPermission()
    }
    return true
  }, [])

  // ── Cleanup ──

  const cleanupAll = useCallback(() => {
    for (const fn of cleanupRef.current) {
      try {
        fn()
      } catch {}
    }
    cleanupRef.current = []
    bleManagerRef.current?.stopDeviceScan()
    teardownPeripheral()
  }, [])

  useEffect(
    () => () => {
      cleanupAll()
      bleManagerRef.current?.destroy()
    },
    []
  )

  // ── Reset ──

  const resetToStart = useCallback(() => {
    cleanupAll()
    setPhase('role_select')
    setDiscoveredReceivers([])
    setSelectedReceiver(null)
    setSendAmount('')
    setProgress(0)
    setErrorMsg('')
    setReceivedPayload(null)
  }, [cleanupAll])

  const showError = useCallback(
    (msg: string) => {
      setErrorMsg(msg)
      setPhase('error')
      dlog(`ERROR: ${msg}`)
    },
    [dlog]
  )

  // ════════════════════════════════════════════════
  // RECEIVE FLOW
  // ════════════════════════════════════════════════

  const startReceiving = useCallback(async () => {
    if (!identityKey) return
    const ok = await ensurePermissions()
    if (!ok) {
      showError('Bluetooth permissions required')
      return
    }

    dlog('Starting receiver (peripheral mode)...')
    setPhase('receiving_wait')

    try {
      const { setServices, startAdvertising, addEventListener } = await import('munim-bluetooth')

      // Set up GATT service with identity + write + notify characteristics
      setServices([
        {
          uuid: BSV_PAYMENT_SERVICE_UUID,
          characteristics: [
            { uuid: IDENTITY_CHARACTERISTIC_UUID, properties: ['read'], value: identityKey },
            { uuid: WRITE_CHARACTERISTIC_UUID, properties: ['write', 'writeWithoutResponse'], value: '' },
            { uuid: NOTIFY_CHARACTERISTIC_UUID, properties: ['read', 'notify'], value: '' }
          ]
        }
      ])

      startAdvertising({ serviceUUIDs: [BSV_PAYMENT_SERVICE_UUID], localName: 'BSV Pay' })
      dlog('Advertising started')

      // Listen for incoming writes (from our munim-bluetooth patch)
      const removeListener = addEventListener('characteristicValueChanged', (data: any) => {
        const charUUID = (data?.characteristicUUID ?? '').toUpperCase()
        if (!charUUID.includes('B5A1E001')) return // Only process writes to WRITE_CHARACTERISTIC
        const hexValue = data?.value ?? ''
        if (!hexValue) return

        setPhase('receiving_progress')
        processIncomingChunk(hexValue, {
          onProgress: pct => setProgress(pct),
          onPayloadReceived: payload => {
            dlog(`Payment received: ${payload.token.amount} sats`)
            setReceivedPayload(payload)
            setCompletedAmount(payload.token.amount)
            setCompletedRole('receiver')
            setPhase('complete')
            teardownPeripheral()
          },
          onError: err => showError(err.message),
          onLog: entry => dlog(`${entry.direction}: ${entry.message}`)
        })
      })
      cleanupRef.current.push(removeListener)
    } catch (e: any) {
      showError(`Failed to start receiving: ${e.message}`)
    }
  }, [identityKey, ensurePermissions, dlog, showError])

  // ════════════════════════════════════════════════
  // SEND FLOW — Step 1: Scan for receivers
  // ════════════════════════════════════════════════

  const startScanning = useCallback(async () => {
    const ok = await ensurePermissions()
    if (!ok) {
      showError('Bluetooth permissions required')
      return
    }

    setPhase('sending_scan')
    setDiscoveredReceivers([])
    dlog('Scanning for nearby receivers...')

    try {
      const mgr = await getBleManager()

      const seenDevices = new Set<string>()

      mgr.startDeviceScan([BSV_PAYMENT_SERVICE_UUID], { allowDuplicates: false }, async (error: any, device: any) => {
        if (error) {
          dlog(`Scan error: ${error.message}`)
          return
        }
        if (!device || seenDevices.has(device.id)) return
        seenDevices.add(device.id)

        const name = device.localName || device.name || '(unknown)'
        dlog(`Found BSV device: ${name} (${device.id.substring(0, 12)}...)`)

        // Add placeholder
        const entry: DiscoveredReceiver = {
          deviceId: device.id,
          identityKey: '',
          name,
          rssi: device.rssi ?? null,
          identity: null,
          resolving: true
        }
        setDiscoveredReceivers(prev => [...prev, entry])

        // Connect briefly to read identity
        try {
          const connected = await mgr.connectToDevice(device.id)
          await connected.discoverAllServicesAndCharacteristics()

          // Find identity char across all service instances
          const services = await connected.services()
          let identityHex = ''
          for (const svc of services) {
            const chars = await svc.characteristics()
            const idChar = chars.find((c: any) => c.uuid.toLowerCase().includes('b5a1e003') && c.isReadable)
            if (idChar) {
              const result = await idChar.read()
              if (result.value) {
                const raw = atob(result.value)
                if (raw.length === 33) {
                  identityHex = Array.from(raw)
                    .map(c => c.charCodeAt(0).toString(16).padStart(2, '0'))
                    .join('')
                } else if (raw.length >= 66) {
                  identityHex = raw.substring(0, 66)
                }
              }
              break
            }
          }

          await connected.cancelConnection()

          if (identityHex.length === 66) {
            dlog(`Identity: ${identityHex.substring(0, 16)}...`)
            setDiscoveredReceivers(prev =>
              prev.map(r => (r.deviceId === device.id ? { ...r, identityKey: identityHex, resolving: true } : r))
            )
            // Resolve display identity
            if (identityClientRef.current) {
              const identity = await resolveIdentity(identityClientRef.current, identityHex)
              setDiscoveredReceivers(prev =>
                prev.map(r => (r.deviceId === device.id ? { ...r, identity, resolving: false } : r))
              )
              if (identity) dlog(`Resolved: ${identity.name}`)
            } else {
              setDiscoveredReceivers(prev => prev.map(r => (r.deviceId === device.id ? { ...r, resolving: false } : r)))
            }
          } else {
            dlog(`No valid identity from ${name}`)
            setDiscoveredReceivers(prev => prev.filter(r => r.deviceId !== device.id))
          }
        } catch (e: any) {
          dlog(`Failed to read identity from ${name}: ${e.message}`)
          setDiscoveredReceivers(prev => prev.filter(r => r.deviceId !== device.id))
        }
      })

      // Auto-stop after 20s
      setTimeout(() => {
        mgr.stopDeviceScan()
        dlog('Scan complete')
      }, 20_000)
    } catch (e: any) {
      showError(`Scan failed: ${e.message}`)
    }
  }, [ensurePermissions, getBleManager, dlog, showError])

  // ════════════════════════════════════════════════
  // SEND FLOW — Step 2: Select receiver
  // ════════════════════════════════════════════════

  const selectReceiver = useCallback(
    (receiver: DiscoveredReceiver) => {
      bleManagerRef.current?.stopDeviceScan()
      setSelectedReceiver(receiver)
      setPhase('sending_amount')
      dlog(`Selected: ${receiver.identity?.name ?? receiver.identityKey.substring(0, 16)}...`)
    },
    [dlog]
  )

  // ════════════════════════════════════════════════
  // SEND FLOW — Step 3: Confirm + Transfer
  // ════════════════════════════════════════════════

  const executeTransfer = useCallback(async () => {
    if (!wallet || !identityKey || !selectedReceiver) return
    const sats = Math.round(Number(sendAmount))
    if (isNaN(sats) || sats <= 0) return

    setPhase('transferring')
    setProgress(0)
    dlog(`Building transaction: ${sats} sats to ${selectedReceiver.identityKey.substring(0, 16)}...`)

    try {
      // Build the payment
      const payload = await createBLEPaymentToken(
        wallet,
        selectedReceiver.identityKey,
        sats,
        identityKey,
        adminOriginator
      )
      dlog(`TX built: ${payload.token.transaction.length} bytes`)

      // Serialize and chunk
      const serialized = serializePayload(payload)
      const chunks = chunkPayload(serialized)
      dlog(`Chunked: ${chunks.length} writes (${serialized.length} bytes)`)

      // Connect via ble-plx
      const mgr = await getBleManager()
      dlog(`Connecting to ${selectedReceiver.name ?? selectedReceiver.deviceId}...`)
      const device = await mgr.connectToDevice(selectedReceiver.deviceId)
      await device.discoverAllServicesAndCharacteristics()
      dlog('Connected, sending chunks...')

      // Send each chunk with pacing
      for (let i = 0; i < chunks.length; i++) {
        const chunkHex = uint8ArrayToHex(chunks[i])
        // ble-plx uses base64 for write values
        const chunkB64 = btoa(String.fromCharCode(...chunks[i]))
        await device.writeCharacteristicWithoutResponseForService(
          BSV_PAYMENT_SERVICE_UUID,
          WRITE_CHARACTERISTIC_UUID,
          chunkB64
        )
        if (i > 0 && chunks.length > 1) {
          setProgress(Math.round((i / (chunks.length - 1)) * 100))
        }
        // Small delay between chunks
        if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 50))
      }

      // Wait for receiver to process
      await new Promise(r => setTimeout(r, 500))

      dlog('Transfer complete!')
      await device.cancelConnection()

      setCompletedAmount(sats)
      setCompletedRole('sender')
      setPhase('complete')
    } catch (e: any) {
      showError(`Transfer failed: ${e.message}`)
    }
  }, [wallet, identityKey, selectedReceiver, sendAmount, adminOriginator, getBleManager, dlog, showError])

  // ── Internalize received payment ──

  const acceptPayment = useCallback(async () => {
    if (!wallet || !receivedPayload) return
    try {
      await wallet.internalizeAction(
        {
          tx: receivedPayload.token.transaction,
          outputs: [
            {
              paymentRemittance: {
                derivationPrefix: receivedPayload.token.customInstructions.derivationPrefix,
                derivationSuffix: receivedPayload.token.customInstructions.derivationSuffix,
                senderIdentityKey: receivedPayload.senderIdentityKey
              },
              outputIndex: receivedPayload.token.outputIndex ?? 0,
              protocol: 'wallet payment'
            }
          ],
          labels: [PEERPAY_LABEL],
          description: PEERPAY_DESCRIPTION
        },
        adminOriginator
      )
      dlog('Payment internalized to wallet')
    } catch (e: any) {
      dlog(`Internalize error: ${e.message}`)
    }
  }, [wallet, receivedPayload, adminOriginator, dlog])

  // ════════════════════════════════════════════════
  // RENDER
  // ════════════════════════════════════════════════

  return (
    <View style={[styles.container, { backgroundColor: colors.backgroundSecondary, paddingTop: insets.top }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.separator }]}>
        <TouchableOpacity
          onPress={() => {
            cleanupAll()
            router.back()
          }}
          style={styles.headerBtn}
        >
          <Ionicons name="chevron-back" size={24} color={colors.accent} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.textPrimary }]}>{t('local_payments')}</Text>
        <TouchableOpacity onPress={() => setShowDebug(v => !v)} style={styles.headerBtn}>
          <Ionicons name="code-slash-outline" size={18} color={showDebug ? colors.info : colors.textTertiary} />
        </TouchableOpacity>
      </View>

      <ScrollView
        style={{ flex: 1, backgroundColor: colors.background }}
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
      >
        {/* ══ Role Select ══ */}
        {phase === 'role_select' && (
          <>
            <View style={styles.center}>
              <View style={[styles.heroCircle, { backgroundColor: colors.info + '12' }]}>
                <Ionicons name="bluetooth" size={52} color={colors.info} />
              </View>
              <Text style={[styles.heroText, { color: colors.textSecondary }]}>{t('local_payments_subtitle')}</Text>
            </View>
            <TouchableOpacity style={[styles.bigBtn, { backgroundColor: colors.accent }]} onPress={startReceiving}>
              <Ionicons name="download-outline" size={24} color={colors.background} />
              <Text style={[styles.bigBtnText, { color: colors.background }]}>{t('request_payment')}</Text>
            </TouchableOpacity>
            <View style={{ height: spacing.md }} />
            <TouchableOpacity style={[styles.bigBtn, { backgroundColor: colors.success }]} onPress={startScanning}>
              <Ionicons name="send-outline" size={24} color="#fff" />
              <Text style={[styles.bigBtnText, { color: '#fff' }]}>{t('send_payment')}</Text>
            </TouchableOpacity>
          </>
        )}

        {/* ══ Receiving: Waiting ══ */}
        {phase === 'receiving_wait' && (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={colors.info} style={{ marginBottom: spacing.lg }} />
            <Text style={[styles.phaseTitle, { color: colors.textPrimary }]}>{t('waiting_for_sender')}</Text>
            <Text style={[styles.phaseSub, { color: colors.textSecondary }]}>{t('advertising_status')}</Text>
            <CancelBtn colors={colors} onPress={resetToStart} t={t} />
          </View>
        )}

        {/* ══ Receiving: Progress ══ */}
        {phase === 'receiving_progress' && (
          <View style={styles.center}>
            <Text style={[styles.phaseTitle, { color: colors.textPrimary }]}>{t('receiving_payment')}</Text>
            <Text style={[styles.phaseSub, { color: colors.textSecondary }]}>{progress}%</Text>
            <View style={[styles.progressTrack, { backgroundColor: colors.separator }]}>
              <View style={[styles.progressFill, { backgroundColor: colors.info, width: `${progress}%` }]} />
            </View>
          </View>
        )}

        {/* ══ Sending: Scan ══ */}
        {phase === 'sending_scan' && (
          <View>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: spacing.md }}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.phaseTitle, { color: colors.textPrimary }]}>{t('searching_receiver')}</Text>
                <Text style={[styles.phaseSub, { color: colors.textSecondary, marginBottom: 0 }]}>
                  {discoveredReceivers.length === 0 ? t('scanning_status') : `${discoveredReceivers.length} found`}
                </Text>
              </View>
              <ActivityIndicator color={colors.info} />
            </View>

            {discoveredReceivers.map((r, i) => (
              <TouchableOpacity
                key={r.deviceId}
                style={[styles.receiverRow, { borderColor: colors.separator }]}
                onPress={() => selectReceiver(r)}
                disabled={r.resolving || !r.identityKey}
              >
                {r.identity?.avatarURL ? (
                  <Image source={{ uri: r.identity.avatarURL }} style={styles.avatar} />
                ) : (
                  <View style={[styles.avatarPlaceholder, { backgroundColor: colors.info + '15' }]}>
                    <Ionicons name="person" size={20} color={colors.info} />
                  </View>
                )}
                <View style={{ flex: 1, minWidth: 0 }}>
                  {r.resolving ? (
                    <Text style={[styles.receiverName, { color: colors.textSecondary }]}>Resolving...</Text>
                  ) : (
                    <Text style={[styles.receiverName, { color: colors.textPrimary }]} numberOfLines={1}>
                      {r.identity?.name ?? 'Unknown'}
                    </Text>
                  )}
                  <Text
                    style={[styles.receiverKey, { color: colors.textTertiary }]}
                    numberOfLines={1}
                    ellipsizeMode="middle"
                  >
                    {r.identity?.abbreviatedKey || r.identityKey || r.deviceId}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
              </TouchableOpacity>
            ))}

            {discoveredReceivers.length === 0 && (
              <View style={[styles.center, { paddingVertical: spacing.xxl }]}>
                <Ionicons name="radio-outline" size={36} color={colors.textTertiary} />
                <Text style={[styles.phaseSub, { color: colors.textTertiary }]}>{t('scanning_status')}</Text>
              </View>
            )}
            <CancelBtn colors={colors} onPress={resetToStart} t={t} />
          </View>
        )}

        {/* ══ Sending: Amount Entry ══ */}
        {phase === 'sending_amount' && selectedReceiver && (
          <View>
            <Text style={[styles.phaseTitle, { color: colors.textPrimary, marginBottom: spacing.md }]}>Send to</Text>
            <IdentityCard receiver={selectedReceiver} colors={colors} />
            <View style={{ marginTop: spacing.lg }}>
              <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>{t('amount_sats')}</Text>
              <SatsAmountInput value={sendAmount} onChangeText={setSendAmount} />
            </View>
            <TouchableOpacity
              style={[
                styles.bigBtn,
                {
                  backgroundColor: Number(sendAmount) > 0 ? colors.success : colors.success + '40',
                  marginTop: spacing.lg
                }
              ]}
              onPress={executeTransfer}
              disabled={!sendAmount || Number(sendAmount) <= 0}
            >
              <Ionicons name="send" size={20} color="#fff" />
              <Text style={[styles.bigBtnText, { color: '#fff' }]}>{t('send_payment')}</Text>
            </TouchableOpacity>
            <CancelBtn colors={colors} onPress={resetToStart} t={t} />
          </View>
        )}

        {/* ══ Transferring ══ */}
        {phase === 'transferring' && (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={colors.info} style={{ marginBottom: spacing.lg }} />
            <Text style={[styles.phaseTitle, { color: colors.textPrimary }]}>{t('sending_payment')}</Text>
            <Text style={[styles.phaseSub, { color: colors.textSecondary }]}>{progress}%</Text>
            <View style={[styles.progressTrack, { backgroundColor: colors.separator }]}>
              <View style={[styles.progressFill, { backgroundColor: colors.info, width: `${progress}%` }]} />
            </View>
          </View>
        )}

        {/* ══ Complete ══ */}
        {phase === 'complete' && (
          <View style={styles.center}>
            <Ionicons name="checkmark-circle" size={72} color={colors.success} style={{ marginBottom: spacing.md }} />
            <Text style={[styles.phaseTitle, { color: colors.textPrimary }]}>
              {completedRole === 'sender' ? t('payment_sent') : t('payment_received')}
            </Text>
            <Text style={[styles.completedAmount, { color: colors.textPrimary }]}>
              <AmountDisplay>{completedAmount}</AmountDisplay>
            </Text>

            {selectedReceiver?.identity && <IdentityCard receiver={selectedReceiver} colors={colors} />}
            {receivedPayload && (
              <Text
                style={[styles.receiverKey, { color: colors.textSecondary, marginBottom: spacing.md }]}
                numberOfLines={1}
                ellipsizeMode="middle"
              >
                From: {receivedPayload.senderIdentityKey}
              </Text>
            )}

            {completedRole === 'receiver' && receivedPayload && (
              <TouchableOpacity
                style={[styles.bigBtn, { backgroundColor: colors.success, marginBottom: spacing.sm }]}
                onPress={acceptPayment}
              >
                <Ionicons name="wallet-outline" size={20} color="#fff" />
                <Text style={[styles.bigBtnText, { color: '#fff' }]}>{t('accept_to_wallet')}</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={[styles.bigBtn, { backgroundColor: colors.accent }]} onPress={resetToStart}>
              <Text style={[styles.bigBtnText, { color: colors.background }]}>{t('done')}</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ══ Error ══ */}
        {phase === 'error' && (
          <View style={styles.center}>
            <Ionicons name="alert-circle" size={72} color={colors.error} style={{ marginBottom: spacing.md }} />
            <Text style={[styles.phaseTitle, { color: colors.textPrimary }]}>{t('transfer_failed')}</Text>
            <Text style={[styles.phaseSub, { color: colors.textSecondary }]}>{errorMsg}</Text>
            <TouchableOpacity style={[styles.bigBtn, { backgroundColor: colors.accent }]} onPress={resetToStart}>
              <Text style={[styles.bigBtnText, { color: colors.background }]}>{t('try_again')}</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ══ Debug Panel ══ */}
        {showDebug && debugLogs.length > 0 && (
          <View
            style={[styles.debugPanel, { backgroundColor: colors.backgroundTertiary, borderColor: colors.separator }]}
          >
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: spacing.xs
              }}
            >
              <Text style={[styles.debugTitle, { color: colors.textSecondary }]}>Debug Log</Text>
              <TouchableOpacity
                onPress={() => {
                  import('expo-clipboard').then(({ setStringAsync }) => setStringAsync(debugLogs.join('\n')))
                }}
              >
                <Ionicons name="copy-outline" size={16} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>
            <ScrollView style={{ maxHeight: 220 }} nestedScrollEnabled>
              {debugLogs.slice(-40).map((line, i) => (
                <Text
                  key={i}
                  style={[
                    styles.debugLine,
                    {
                      color: line.includes('ERROR')
                        ? colors.error
                        : line.includes('SUCCESS') || line.includes('Resolved')
                          ? colors.success
                          : colors.textSecondary
                    }
                  ]}
                  selectable
                >
                  {line}
                </Text>
              ))}
            </ScrollView>
          </View>
        )}
      </ScrollView>
    </View>
  )
}

// ── Small Components ──

function CancelBtn({ colors, onPress, t }: { colors: any; onPress: () => void; t: any }) {
  return (
    <TouchableOpacity style={[styles.cancelBtn, { borderColor: colors.separator }]} onPress={onPress}>
      <Text style={[styles.cancelBtnText, { color: colors.textSecondary }]}>{t('cancel')}</Text>
    </TouchableOpacity>
  )
}

function IdentityCard({ receiver, colors }: { receiver: DiscoveredReceiver; colors: any }) {
  const id = receiver.identity
  return (
    <View style={[styles.idCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.separator }]}>
      {id?.avatarURL ? (
        <Image source={{ uri: id.avatarURL }} style={styles.avatar} />
      ) : (
        <View style={[styles.avatarPlaceholder, { backgroundColor: colors.info + '15' }]}>
          <Ionicons name="person" size={22} color={colors.info} />
        </View>
      )}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[styles.receiverName, { color: colors.textPrimary }]} numberOfLines={1}>
          {id?.name ?? 'Unknown'}
        </Text>
        <Text style={[styles.receiverKey, { color: colors.textTertiary }]} numberOfLines={1} ellipsizeMode="middle">
          {id?.abbreviatedKey || receiver.identityKey}
        </Text>
        {id?.badgeLabel ? <Text style={[{ ...typography.caption2, color: colors.info }]}>{id.badgeLabel}</Text> : null}
      </View>
      {id?.badgeIconURL ? (
        <Image source={{ uri: id.badgeIconURL }} style={{ width: 20, height: 20, borderRadius: 10 }} />
      ) : null}
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
  headerBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { ...typography.headline, fontWeight: '600' },
  scroll: { padding: spacing.lg, paddingBottom: spacing.xxxl },

  center: { alignItems: 'center', paddingVertical: spacing.xl },
  heroCircle: {
    width: 100,
    height: 100,
    borderRadius: 50,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md
  },
  heroText: { ...typography.subhead, textAlign: 'center', paddingHorizontal: spacing.lg, marginBottom: spacing.xl },

  bigBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: 14,
    borderRadius: radii.md
  },
  bigBtnText: { ...typography.body, fontWeight: '600' },

  phaseTitle: { ...typography.title3, fontWeight: '700', textAlign: 'center' },
  phaseSub: { ...typography.subhead, textAlign: 'center', marginBottom: spacing.lg },
  fieldLabel: { ...typography.subhead, fontWeight: '500', marginBottom: spacing.sm },

  progressTrack: {
    height: 6,
    borderRadius: 3,
    width: '100%',
    maxWidth: 280,
    overflow: 'hidden',
    marginTop: spacing.md
  },
  progressFill: { height: '100%', borderRadius: 3 },

  cancelBtn: {
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderRadius: radii.md,
    borderWidth: 1,
    marginTop: spacing.xl
  },
  cancelBtnText: { ...typography.body, fontWeight: '500' },

  receiverRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: spacing.sm
  },
  avatar: { width: 42, height: 42, borderRadius: 21 },
  avatarPlaceholder: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  receiverName: { ...typography.body, fontWeight: '600', marginBottom: 1 },
  receiverKey: { ...typography.caption2, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },

  idCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    width: '100%'
  },

  completedAmount: { fontSize: 34, fontWeight: '700', letterSpacing: 0.4, marginBottom: spacing.lg },

  debugPanel: {
    marginTop: spacing.xl,
    padding: spacing.md,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth
  },
  debugTitle: { ...typography.caption1, fontWeight: '600' },
  debugLine: {
    ...typography.caption2,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    lineHeight: 15,
    marginBottom: 1
  }
})
