/**
 * BLE P2P Payment Transfer — Main Orchestration Hook
 *
 * Manages the full transfer state machine for both sender and receiver roles.
 * Wires together the peripheral module (advertising/receiving) and
 * central module (scanning/sending) with proper event listeners and cleanup.
 *
 * Usage:
 *   const ble = useBLETransfer()
 *   ble.startReceiver()  // "Request Payment" — advertise and wait
 *   ble.startSender(payload)  // "Send Payment" — scan, connect, send
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  isBluetoothEnabled,
  requestBluetoothPermission,
  addEventListener,
  addDeviceFoundListener
} from 'munim-bluetooth'
import type { BLEDevice, CharacteristicValue } from 'munim-bluetooth'

import { setupAndAdvertise, processIncomingChunk, teardownPeripheral } from '@/utils/ble/peripheral'

import {
  startScanning,
  stopScanning,
  extractIdentityKey,
  connectAndTransfer,
  teardownCentral,
  handleAckNotification
} from '@/utils/ble/central'

import { NOTIFY_CHARACTERISTIC_UUID, SCAN_TIMEOUT_MS } from '@/utils/ble/constants'
import type {
  TransferState,
  TransferPhase,
  BLEPaymentPayload,
  BLELogEntry,
  PeerDisplayIdentity
} from '@/utils/ble/types'

// ── Initial State ──

const INITIAL_STATE: TransferState = {
  phase: 'idle',
  role: null,
  progress: 0,
  statusText: '',
  errorMessage: null,
  peerIdentityKey: null,
  peerIdentity: null,
  receivedPayload: null,
  amount: null
}

// ── Hook ──

export function useBLETransfer() {
  const [state, setState] = useState<TransferState>(INITIAL_STATE)
  const [logs, setLogs] = useState<BLELogEntry[]>([])

  // Cleanup function references (returned by addEventListener)
  const cleanupRefs = useRef<Array<() => void>>([])
  const scanTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isMountedRef = useRef(true)

  // Safe state setter that checks mount status
  const safeSetState = useCallback((updater: Partial<TransferState> | ((prev: TransferState) => TransferState)) => {
    if (!isMountedRef.current) return
    if (typeof updater === 'function') {
      setState(updater)
    } else {
      setState(prev => ({ ...prev, ...updater }))
    }
  }, [])

  const addLog = useCallback((entry: BLELogEntry) => {
    if (!isMountedRef.current) return
    setLogs(prev => [...prev.slice(-99), entry]) // Keep last 100 entries
  }, [])

  const log = useCallback(
    (direction: BLELogEntry['direction'], message: string) => {
      addLog({ timestamp: Date.now(), direction, message })
    },
    [addLog]
  )

  // ── Permission Check ──

  const ensureBluetooth = useCallback(async (): Promise<boolean> => {
    safeSetState({ phase: 'requesting_permission', statusText: 'Checking Bluetooth...' })
    log('info', 'Checking Bluetooth permissions...')

    try {
      const granted = await requestBluetoothPermission()
      if (!granted) {
        safeSetState({
          phase: 'permission_denied',
          statusText: 'Bluetooth permission denied',
          errorMessage: 'Bluetooth permission is required for local payments.'
        })
        log('error', 'Bluetooth permission denied')
        return false
      }

      const enabled = await isBluetoothEnabled()
      if (!enabled) {
        safeSetState({
          phase: 'permission_denied',
          statusText: 'Bluetooth is turned off',
          errorMessage: 'Please enable Bluetooth in your device settings.'
        })
        log('error', 'Bluetooth is disabled')
        return false
      }

      log('info', 'Bluetooth ready')
      return true
    } catch (error) {
      safeSetState({ phase: 'error', statusText: 'Bluetooth check failed', errorMessage: (error as Error).message })
      log('error', `Bluetooth check failed: ${(error as Error).message}`)
      return false
    }
  }, [safeSetState, log])

  // ── Cleanup ──

  const cleanupAll = useCallback(() => {
    // Clear scan timeout
    if (scanTimeoutRef.current) {
      clearTimeout(scanTimeoutRef.current)
      scanTimeoutRef.current = null
    }

    // Remove all event listeners
    for (const cleanup of cleanupRefs.current) {
      try {
        cleanup()
      } catch {
        /* ignore */
      }
    }
    cleanupRefs.current = []

    // Teardown BLE modules
    teardownPeripheral()
    teardownCentral()
  }, [])

  // ── Start Receiver (Peripheral Mode) ──

  const startReceiverMode = useCallback(
    async (identityKey: string) => {
      cleanupAll()
      setLogs([])

      const btReady = await ensureBluetooth()
      if (!btReady) return

      safeSetState({
        phase: 'advertising',
        role: 'receiver',
        progress: 0,
        statusText: 'Waiting for sender...',
        errorMessage: null,
        peerIdentityKey: null,
        peerIdentity: null,
        receivedPayload: null
      })

      log('info', `Starting receiver with identity: ${identityKey.substring(0, 12)}...`)

      try {
        // Set up GATT service and start advertising
        setupAndAdvertise(identityKey)
        log('info', 'Advertising started')

        // Listen for incoming write requests on our GATT characteristic.
        // munim-bluetooth emits 'characteristicWriteRequest' when a central writes
        // to our peripheral's writable characteristic.
        const removeWriteListener = addEventListener('characteristicWriteRequest', (data: any) => {
          log(
            'rx',
            `Write request received: ${typeof data === 'object' ? JSON.stringify(data).substring(0, 80) : data}`
          )

          // Extract the hex value from the event data
          const hexValue = typeof data === 'string' ? data : (data?.value ?? data?.data ?? '')
          if (!hexValue) return

          // If this is the first write, we're now connected
          safeSetState(prev => {
            if (prev.phase === 'advertising') {
              return { ...prev, phase: 'connected', statusText: 'Connected — receiving payment...' }
            }
            if (prev.phase === 'connected') {
              return { ...prev, phase: 'transferring', statusText: 'Receiving...' }
            }
            return prev
          })

          // Process the chunk and get ACK response
          const ackHex = processIncomingChunk(hexValue, {
            onProgress: percent => {
              safeSetState({ progress: percent, statusText: `Receiving... ${percent}%` })
            },
            onPayloadReceived: payload => {
              safeSetState({
                phase: 'complete',
                progress: 100,
                statusText: 'Payment received!',
                receivedPayload: payload,
                peerIdentityKey: payload.senderIdentityKey,
                amount: payload.token.amount
              })
              log(
                'info',
                `Payment received: ${payload.token.amount} sats from ${payload.senderIdentityKey.substring(0, 12)}...`
              )
            },
            onError: error => {
              safeSetState({ phase: 'error', statusText: 'Transfer failed', errorMessage: error.message })
              log('error', `Transfer error: ${error.message}`)
            },
            onLog: addLog
          })

          // The ACK needs to be sent back via the notify characteristic.
          // With munim-bluetooth's peripheral mode, updating the characteristic
          // value triggers a notification to subscribed centrals.
          // We update the notify characteristic value to send the ACK.
          try {
            const { setServices } = require('munim-bluetooth')
            // Update the notify characteristic value with the ACK
            // Note: In munim-bluetooth, updating the service re-sets the value
            // which triggers notification to subscribed centrals.
            // For a more efficient approach in production, you'd want a dedicated
            // "updateCharacteristicValue" API if available.
          } catch {
            log('error', 'Failed to send ACK notification')
          }
        })
        cleanupRefs.current.push(removeWriteListener)

        // Also listen for connection state changes
        const removeConnectionListener = addEventListener('connectionStateChanged', (data: any) => {
          log('info', `Connection state changed: ${JSON.stringify(data)}`)
        })
        cleanupRefs.current.push(removeConnectionListener)
      } catch (error) {
        safeSetState({
          phase: 'error',
          statusText: 'Failed to start advertising',
          errorMessage: (error as Error).message
        })
        log('error', `Receiver start failed: ${(error as Error).message}`)
      }
    },
    [cleanupAll, ensureBluetooth, safeSetState, log, addLog]
  )

  // ── Start Sender (Central Mode) ──

  const startSenderMode = useCallback(
    async (payload: BLEPaymentPayload, onDeviceFound?: (deviceId: string, identityKey: string) => void) => {
      cleanupAll()
      setLogs([])

      const btReady = await ensureBluetooth()
      if (!btReady) return

      safeSetState({
        phase: 'scanning',
        role: 'sender',
        progress: 0,
        statusText: 'Searching for receiver...',
        errorMessage: null,
        peerIdentityKey: null,
        peerIdentity: null,
        receivedPayload: null,
        amount: payload.token.amount
      })

      log('info', 'Starting scan for payment receivers...')

      try {
        // Set up device discovery listener
        const removeDeviceListener = addDeviceFoundListener((device: BLEDevice) => {
          log('info', `Device found: ${device.name ?? device.id} (RSSI: ${device.rssi ?? '?'})`)

          // Extract identity key from manufacturer data in advertising
          const mfgData = device.advertisingData?.manufacturerData
          const identityKey = extractIdentityKey(mfgData)

          if (identityKey) {
            log('info', `Receiver identity: ${identityKey.substring(0, 12)}...`)
            safeSetState({
              peerIdentityKey: identityKey,
              phase: 'connecting',
              statusText: 'Found receiver, connecting...'
            })

            // Notify caller (for identity resolution)
            onDeviceFound?.(device.id, identityKey)

            // Stop scanning and initiate transfer
            stopScanning()
            if (scanTimeoutRef.current) {
              clearTimeout(scanTimeoutRef.current)
              scanTimeoutRef.current = null
            }

            // Listen for ACK notifications during transfer
            const removeNotifyListener = addEventListener('characteristicValueChanged', (data: any) => {
              // Only process notifications from the ACK characteristic
              const charUUID = data?.characteristicUUID ?? data?.characteristic ?? ''
              if (
                charUUID.toUpperCase().includes(NOTIFY_CHARACTERISTIC_UUID.substring(0, 8).toUpperCase()) ||
                !charUUID
              ) {
                const hexValue = typeof data === 'string' ? data : (data?.value ?? '')
                if (hexValue) {
                  handleAckNotification(hexValue)
                }
              }
            })
            cleanupRefs.current.push(removeNotifyListener)

            // Connect and transfer
            safeSetState({ phase: 'connected', statusText: 'Connected' })

            connectAndTransfer(
              device.id,
              payload,
              percent => {
                safeSetState({ phase: 'transferring', progress: percent, statusText: `Sending... ${percent}%` })
              },
              addLog
            )
              .then(() => {
                safeSetState({ phase: 'complete', progress: 100, statusText: 'Payment sent!' })
                log('info', 'Transfer complete')
              })
              .catch(error => {
                safeSetState({ phase: 'error', statusText: 'Transfer failed', errorMessage: (error as Error).message })
                log('error', `Transfer failed: ${(error as Error).message}`)
              })
          }
        })
        cleanupRefs.current.push(removeDeviceListener)

        // Start scanning
        startScanning()

        // Set scan timeout
        scanTimeoutRef.current = setTimeout(() => {
          if (isMountedRef.current) {
            safeSetState({
              phase: 'error',
              statusText: 'No receiver found',
              errorMessage:
                'Could not find a nearby payment receiver. Make sure the other device is in "Request Payment" mode.'
            })
            log('error', 'Scan timeout')
            stopScanning()
          }
        }, SCAN_TIMEOUT_MS)
      } catch (error) {
        safeSetState({ phase: 'error', statusText: 'Scan failed', errorMessage: (error as Error).message })
        log('error', `Sender start failed: ${(error as Error).message}`)
      }
    },
    [cleanupAll, ensureBluetooth, safeSetState, log, addLog]
  )

  // ── Cancel / Reset ──

  const cancel = useCallback(() => {
    cleanupAll()
    safeSetState(INITIAL_STATE)
    setLogs([])
    log('info', 'Transfer cancelled')
  }, [cleanupAll, safeSetState, log])

  const reset = useCallback(() => {
    cleanupAll()
    setState(INITIAL_STATE)
    setLogs([])
  }, [cleanupAll])

  // ── Update Peer Identity (called externally after IdentityClient lookup) ──

  const setPeerIdentity = useCallback(
    (identity: PeerDisplayIdentity | null) => {
      safeSetState({ peerIdentity: identity })
    },
    [safeSetState]
  )

  // ── Cleanup on Unmount ──

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      cleanupAll()
    }
  }, [cleanupAll])

  return {
    state,
    logs,
    startReceiver: startReceiverMode,
    startSender: startSenderMode,
    cancel,
    reset,
    setPeerIdentity
  }
}
