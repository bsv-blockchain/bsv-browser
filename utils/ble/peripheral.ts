/**
 * BLE P2P Payment Transfer — Peripheral (Receiver) Module
 *
 * When a user taps "Request Payment", this module:
 * 1. Sets up a GATT service with write + notify characteristics
 * 2. Advertises the service UUID + the user's identity key in manufacturer data
 * 3. Provides handlers for incoming chunk writes from the sender
 * 4. Builds ACK/NAK responses to send back via the notify characteristic
 * 5. Reassembles the full payload and verifies checksum
 */

import { Platform } from 'react-native'

// Lazy-loaded munim-bluetooth — do NOT import at the top level.
// A static import causes munim-bluetooth to call NitroModules.createHybridObject()
// at module-load time, which on Android/Hermes can crash the module graph before
// @bsv/sdk classes finish initialising, producing "Cannot read property 'prototype'
// of undefined" when the sender tries to build a transaction.
// We defer the require to the first peripheral API call instead.
function getMunimBT() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('munim-bluetooth') as {
    startAdvertising: (opts: { serviceUUIDs: string[]; localName?: string; manufacturerData?: string }) => void
    stopAdvertising: () => void
    setServices: (
      services: Array<{ uuid: string; characteristics: Array<{ uuid: string; properties: string[]; value: string }> }>
    ) => void
  }
}

import {
  BSV_PAYMENT_SERVICE_UUID,
  IDENTITY_CHARACTERISTIC_UUID,
  WRITE_CHARACTERISTIC_UUID,
  NOTIFY_CHARACTERISTIC_UUID,
  MANUFACTURER_ID_HEX,
  LOCAL_NAME_PREFIX,
  ACK_METADATA,
  ACK_CHUNK,
  ACK_COMPLETE,
  NAK_ERROR,
  ERR_CHECKSUM,
  ERR_UNKNOWN
} from './constants'

import {
  ChunkReassembler,
  buildAckMetadata,
  buildAckChunk,
  buildAckComplete,
  buildNakError,
  hexToUint8Array,
  deserializePayload
} from './chunking'

import type { BLEPaymentPayload, BLELogEntry } from './types'

export interface PeripheralCallbacks {
  onProgress: (percent: number) => void
  onPayloadReceived: (payload: BLEPaymentPayload) => void
  onError: (error: Error) => void
  onLog: (entry: BLELogEntry) => void
}

let reassembler = new ChunkReassembler()
let isAdvertising = false

/**
 * Set up the GATT service and start advertising.
 *
 * @param identityKey - The receiver's compressed public key hex (66 chars)
 */
export function setupAndAdvertise(identityKey: string): void {
  reassembler.reset()

  // Set up the GATT service with three characteristics:
  // 1. Identity (readable) — contains the receiver's identity key hex so the
  //    sender can read it after connecting and show who they're paying
  // 2. Write — sender writes chunked payment data here
  // 3. Notify — receiver sends ACKs (future use)
  getMunimBT().setServices([
    {
      uuid: BSV_PAYMENT_SERVICE_UUID,
      characteristics: [
        {
          uuid: IDENTITY_CHARACTERISTIC_UUID,
          properties: ['read'],
          value: identityKey
        },
        {
          uuid: WRITE_CHARACTERISTIC_UUID,
          properties: ['write', 'writeWithoutResponse'],
          value: ''
        },
        {
          uuid: NOTIFY_CHARACTERISTIC_UUID,
          properties: ['read', 'notify'],
          value: ''
        }
      ]
    }
  ])

  // Start advertising with identity key.
  //
  // iOS CoreBluetooth only allows localName + serviceUUIDs in peripheral ads.
  // manufacturerData is silently dropped. So we encode the identity key in
  // the localName on iOS: "BSV:<66-char-hex-key>"
  //
  // Android supports manufacturerData, so we use both for maximum compatibility.
  // The scanner checks localName first (works on both), then falls back to mfg data (Android).
  const localName = LOCAL_NAME_PREFIX + identityKey
  const manufacturerDataHex = MANUFACTURER_ID_HEX + identityKey

  getMunimBT().startAdvertising({
    serviceUUIDs: [BSV_PAYMENT_SERVICE_UUID],
    localName,
    manufacturerData: manufacturerDataHex
  })

  isAdvertising = true
}

/**
 * Process an incoming chunk write from the sender.
 *
 * Feeds the chunk into the reassembler and returns the appropriate
 * ACK/NAK hex string to send back via the notify characteristic.
 *
 * @param hexValue - The written data as a hex string (from BLE event)
 * @param callbacks - Event callbacks for progress and completion
 * @returns Hex string to write to the notify characteristic as response
 */
export function processIncomingChunk(hexValue: string, callbacks: PeripheralCallbacks): string {
  const log = (direction: BLELogEntry['direction'], message: string) => {
    callbacks.onLog({ timestamp: Date.now(), direction, message })
  }

  try {
    const chunkData = hexToUint8Array(hexValue)
    log('rx', `Chunk received: ${chunkData.length} bytes`)

    const seq = reassembler.addChunk(chunkData)

    if (seq === -1) {
      // Metadata chunk
      const meta = reassembler.expectedMetadata!
      log('info', `Metadata: ${meta.totalBytes}B, ${meta.totalChunks} chunks, CRC=0x${meta.checksum.toString(16)}`)
      callbacks.onProgress(0)
      return buildAckMetadata(ACK_METADATA)
    }

    // Data chunk — update progress
    const progress = reassembler.progress
    callbacks.onProgress(progress)
    log('info', `Chunk seq=${seq}, progress=${progress}%`)

    if (reassembler.isComplete) {
      // All chunks received — assemble and verify checksum
      try {
        const fullPayload = reassembler.assemble()
        log('info', `Assembled ${fullPayload.length} bytes, checksum OK`)

        const parsed = deserializePayload<BLEPaymentPayload>(fullPayload)
        callbacks.onPayloadReceived(parsed)

        return buildAckComplete(ACK_COMPLETE)
      } catch (verifyError) {
        log('error', `Verification failed: ${(verifyError as Error).message}`)
        callbacks.onError(verifyError as Error)
        return buildNakError(NAK_ERROR, ERR_CHECKSUM)
      }
    }

    // Intermediate chunk — ACK with sequence number
    return buildAckChunk(ACK_CHUNK, seq)
  } catch (error) {
    log('error', `Chunk processing error: ${(error as Error).message}`)
    callbacks.onError(error as Error)
    return buildNakError(NAK_ERROR, ERR_UNKNOWN)
  }
}

/**
 * Stop advertising and clean up.
 */
export function teardownPeripheral(): void {
  if (isAdvertising) {
    try {
      getMunimBT().stopAdvertising()
    } catch {
      // Ignore cleanup errors
    }
    isAdvertising = false
  }
  reassembler.reset()
}

/**
 * Reset the reassembler for a new transfer (without stopping advertising).
 */
export function resetReassembler(): void {
  reassembler = new ChunkReassembler()
}

export function isPeripheralActive(): boolean {
  return isAdvertising
}
