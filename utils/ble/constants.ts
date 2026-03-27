/**
 * BLE P2P Payment Transfer — Protocol Constants
 *
 * Fixed GATT service and characteristic UUIDs used for BSV local payments.
 * The service UUID is advertised by the receiver ("Request Payment" side).
 * The sender discovers this UUID during scanning and connects.
 */

// ── Custom GATT Service UUID ──
// Used for discovery: the receiver advertises this so the sender can find them.
export const BSV_PAYMENT_SERVICE_UUID = 'B5A1E000-7374-4F6E-8E2D-425356504159'

// ── Characteristic UUIDs ──
// Write characteristic: sender writes chunked payment data here.
export const WRITE_CHARACTERISTIC_UUID = 'B5A1E001-7374-4F6E-8E2D-425356504159'
// Notify characteristic: receiver sends ACK/NAK/progress via notifications.
export const NOTIFY_CHARACTERISTIC_UUID = 'B5A1E002-7374-4F6E-8E2D-425356504159'

// ── Chunking Protocol ──
// Each BLE write carries a 3-byte header + payload.
// Header: [2-byte big-endian sequence number][1-byte flags]
export const CHUNK_HEADER_SIZE = 3
// Conservative payload size per write (works within default 20-byte MTU but
// most modern phones negotiate 200+ byte MTU). We target 200 bytes of payload
// per chunk; the total write is CHUNK_HEADER_SIZE + CHUNK_PAYLOAD_SIZE.
export const CHUNK_PAYLOAD_SIZE = 200
// Maximum payload size we support (100 KB).
export const MAX_PAYLOAD_SIZE = 100 * 1024

// ── Chunk Flags ──
export const FLAG_METADATA = 0x02 // First chunk: carries total size + CRC32
export const FLAG_DATA = 0x00 // Intermediate data chunk
export const FLAG_FINAL = 0x01 // Last data chunk

// ── ACK / NAK Opcodes (sent via notify characteristic) ──
export const ACK_METADATA = 0x10 // Receiver ready, metadata received
export const ACK_CHUNK = 0x11 // Chunk received (followed by 2-byte seq)
export const ACK_COMPLETE = 0x12 // Full transfer verified (checksum match)
export const NAK_ERROR = 0xff // Error (followed by 1-byte error code)

// ── Error Codes (NAK payload) ──
export const ERR_CHECKSUM = 0x01
export const ERR_SIZE_EXCEEDED = 0x02
export const ERR_OUT_OF_ORDER = 0x03
export const ERR_UNKNOWN = 0x04

// ── Timeouts (ms) ──
export const SCAN_TIMEOUT_MS = 20_000 // Max time to scan for a receiver
export const CONNECT_TIMEOUT_MS = 10_000 // Max time to establish connection
export const ACK_TIMEOUT_MS = 5_000 // Max time to wait for an ACK
export const TRANSFER_TIMEOUT_MS = 60_000 // Max total transfer time

// ── Manufacturer Data Prefix ──
// 2-byte "company ID" (0xBSV = 0x0B5V → we use 0x0B5A) followed by identity key bytes.
// The scanner parses this to extract the advertiser's identity key before connecting.
export const MANUFACTURER_ID_HEX = '0B5A'

// ── PeerPay-compatible protocol constants ──
export const PEERPAY_PROTOCOL_ID: [number, string] = [2, '3241645161d8']
export const PEERPAY_LABEL = 'peerpay'
export const PEERPAY_DESCRIPTION = 'Local BLE Payment'
