/**
 * BLE P2P Payment Transfer — Central (Sender) Module
 *
 * When a user taps "Send Payment", this module:
 * 1. Scans for peripherals advertising the BSV payment service UUID
 * 2. Extracts the receiver's identity key from advertising manufacturer data
 * 3. Connects to the chosen peripheral
 * 4. Discovers services and subscribes to the notify characteristic for ACKs
 * 5. Sends the payment payload in chunks via the write characteristic
 * 6. Waits for ACK_COMPLETE, then disconnects
 */

import {
  startScan,
  stopScan,
  connect,
  disconnect,
  discoverServices,
  writeCharacteristic,
  subscribeToCharacteristic,
  unsubscribeFromCharacteristic
} from 'munim-bluetooth'

import {
  BSV_PAYMENT_SERVICE_UUID,
  WRITE_CHARACTERISTIC_UUID,
  NOTIFY_CHARACTERISTIC_UUID,
  MANUFACTURER_ID_HEX,
  ACK_METADATA,
  ACK_CHUNK,
  ACK_COMPLETE,
  NAK_ERROR,
  ACK_TIMEOUT_MS
} from './constants'

import { chunkPayload, serializePayload, uint8ArrayToHex, hexToUint8Array, readUint16BE } from './chunking'

import type { BLEPaymentPayload, BLELogEntry } from './types'

// ── ACK Resolution ──

interface AckResult {
  type: 'ack' | 'error'
  opcode: number
  seq?: number
  message?: string
}

/** Pending ACK resolver — set during chunk sending, resolved by notification handler */
let pendingAckResolve: ((result: AckResult) => void) | null = null
let pendingAckTimeout: ReturnType<typeof setTimeout> | null = null

/**
 * Process a received ACK/NAK notification from the receiver.
 * Called externally (from the hook's event listener) when a notification arrives
 * on the NOTIFY_CHARACTERISTIC_UUID.
 *
 * @param hexValue - Notification value as hex string
 */
export function handleAckNotification(hexValue: string): void {
  if (!pendingAckResolve) return

  const data = hexToUint8Array(hexValue)
  if (data.length === 0) return

  const opcode = data[0]
  const resolve = pendingAckResolve
  pendingAckResolve = null
  if (pendingAckTimeout) {
    clearTimeout(pendingAckTimeout)
    pendingAckTimeout = null
  }

  if (opcode === NAK_ERROR) {
    const errorCode = data.length > 1 ? data[1] : 0
    resolve({ type: 'error', opcode, message: `NAK error: 0x${errorCode.toString(16)}` })
  } else if (opcode === ACK_CHUNK && data.length >= 3) {
    const seq = readUint16BE(data, 1)
    resolve({ type: 'ack', opcode, seq })
  } else {
    resolve({ type: 'ack', opcode })
  }
}

/** Create a promise that resolves when the next ACK notification arrives. */
function waitForAck(): Promise<AckResult> {
  return new Promise<AckResult>((resolve, reject) => {
    pendingAckResolve = resolve
    pendingAckTimeout = setTimeout(() => {
      pendingAckResolve = null
      pendingAckTimeout = null
      reject(new Error('ACK timeout: receiver did not respond'))
    }, ACK_TIMEOUT_MS)
  })
}

// ── Scanning ──

/**
 * Extract the receiver's identity key from advertising manufacturer data.
 * Format: MANUFACTURER_ID_HEX (4 hex chars) + identity key hex (66 chars)
 */
export function extractIdentityKey(manufacturerDataHex: string | undefined): string | null {
  if (!manufacturerDataHex) return null

  const prefixUpper = MANUFACTURER_ID_HEX.toUpperCase()
  const dataUpper = manufacturerDataHex.toUpperCase()

  if (dataUpper.startsWith(prefixUpper)) {
    const keyHex = manufacturerDataHex.substring(MANUFACTURER_ID_HEX.length)
    // Compressed public key = 33 bytes = 66 hex chars
    if (keyHex.length >= 66) {
      return keyHex.substring(0, 66)
    }
  }
  return null
}

/**
 * Start scanning for BSV payment receivers.
 * Device discovery events are handled externally via addEventListener('deviceFound', ...).
 */
export function startScanning(): void {
  startScan({
    serviceUUIDs: [BSV_PAYMENT_SERVICE_UUID],
    allowDuplicates: false,
    scanMode: 'balanced'
  })
}

/** Stop scanning. */
export function stopScanning(): void {
  try {
    stopScan()
  } catch {
    // Ignore
  }
}

// ── Connection & Transfer ──

let connectedDeviceId: string | null = null

/**
 * Connect to a discovered receiver, subscribe to notifications,
 * and send the payment payload in chunks.
 *
 * @param deviceId - BLE device ID to connect to
 * @param payload - Payment payload to send
 * @param onProgress - Progress callback (0–100)
 * @param onLog - Log callback
 * @returns Resolves when transfer is complete and ACK_COMPLETE is received
 */
export async function connectAndTransfer(
  deviceId: string,
  payload: BLEPaymentPayload,
  onProgress: (percent: number) => void,
  onLog: (entry: BLELogEntry) => void
): Promise<void> {
  const log = (dir: BLELogEntry['direction'], msg: string) =>
    onLog({ timestamp: Date.now(), direction: dir, message: msg })

  // 1. Connect
  log('info', `Connecting to ${deviceId}...`)
  await connect(deviceId)
  connectedDeviceId = deviceId
  log('info', 'Connected')

  // 2. Discover services
  log('info', 'Discovering services...')
  const services = await discoverServices(deviceId)
  log('info', `Found ${services.length} service(s)`)

  // 3. Subscribe to notify characteristic (ACKs come back here)
  log('info', 'Subscribing to ACK notifications...')
  subscribeToCharacteristic(deviceId, BSV_PAYMENT_SERVICE_UUID, NOTIFY_CHARACTERISTIC_UUID)

  // Small delay to let subscription establish
  await sleep(200)

  // 4. Serialize and chunk
  const serialized = serializePayload(payload)
  log('info', `Payload: ${serialized.length} bytes`)

  const chunks = chunkPayload(serialized)
  log('info', `Chunked into ${chunks.length} writes (1 metadata + ${chunks.length - 1} data)`)

  // 5. Send each chunk and wait for ACK
  for (let i = 0; i < chunks.length; i++) {
    const chunkHex = uint8ArrayToHex(chunks[i])
    const isMetadata = i === 0
    const isFinal = i === chunks.length - 1

    log('tx', `Chunk ${i}/${chunks.length - 1} (${chunks[i].length}B)`)

    await writeCharacteristic(
      deviceId,
      BSV_PAYMENT_SERVICE_UUID,
      WRITE_CHARACTERISTIC_UUID,
      chunkHex,
      'writeWithoutResponse'
    )

    // Wait for ACK
    const ack = await waitForAck()

    if (ack.type === 'error') {
      throw new Error(`Transfer rejected by receiver: ${ack.message}`)
    }

    log('rx', `ACK opcode=0x${ack.opcode.toString(16)}${ack.seq !== undefined ? ` seq=${ack.seq}` : ''}`)

    // Update progress (skip metadata chunk in progress calculation)
    if (!isMetadata) {
      const progress = Math.round((i / (chunks.length - 1)) * 100)
      onProgress(progress)
    }
  }

  log('info', 'All chunks sent and ACKed — transfer complete')
}

/**
 * Clean up: unsubscribe and disconnect from the peripheral.
 */
export async function cleanupCentral(): Promise<void> {
  const deviceId = connectedDeviceId
  if (!deviceId) return

  try {
    unsubscribeFromCharacteristic(deviceId, BSV_PAYMENT_SERVICE_UUID, NOTIFY_CHARACTERISTIC_UUID)
  } catch {
    /* ignore */
  }

  try {
    disconnect(deviceId)
  } catch {
    /* ignore */
  }

  connectedDeviceId = null

  // Clear any pending ACK
  if (pendingAckResolve) {
    pendingAckResolve({ type: 'error', opcode: 0, message: 'Connection closed' })
    pendingAckResolve = null
  }
  if (pendingAckTimeout) {
    clearTimeout(pendingAckTimeout)
    pendingAckTimeout = null
  }
}

/**
 * Force stop everything: scanning + connection.
 */
export async function teardownCentral(): Promise<void> {
  stopScanning()
  await cleanupCentral()
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
