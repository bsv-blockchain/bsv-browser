/**
 * BLE P2P Payment Transfer — Chunking & Reassembly
 *
 * Handles splitting a payload into BLE-sized chunks with sequencing,
 * reassembling received chunks, and CRC32 verification.
 *
 * Chunk wire format:
 *   [2-byte BE sequence][1-byte flags][payload bytes]
 *
 * Metadata chunk (seq=0, flags=0x02):
 *   payload = [4-byte BE totalBytes][4-byte BE checksum][4-byte BE totalChunks]
 *
 * Data chunks (seq=1..N, flags=0x00 or 0x01 for final):
 *   payload = raw data bytes
 */

import {
  CHUNK_HEADER_SIZE,
  CHUNK_PAYLOAD_SIZE,
  FLAG_METADATA,
  FLAG_DATA,
  FLAG_FINAL,
  MAX_PAYLOAD_SIZE
} from './constants'
import type { ChunkMetadata } from './types'

// ── CRC32 ──

/** Pre-computed CRC32 lookup table (IEEE 802.3 polynomial) */
const crc32Table: number[] = (() => {
  const table: number[] = new Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[i] = c >>> 0
  }
  return table
})()

/** Compute CRC32 checksum of a Uint8Array. Returns unsigned 32-bit integer. */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    crc = crc32Table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

// ── Encoding Helpers ──

/** Write a 16-bit big-endian unsigned integer into a byte array at offset. */
function writeUint16BE(arr: Uint8Array, value: number, offset: number): void {
  arr[offset] = (value >>> 8) & 0xff
  arr[offset + 1] = value & 0xff
}

/** Read a 16-bit big-endian unsigned integer from a byte array at offset. */
export function readUint16BE(arr: Uint8Array, offset: number): number {
  return (arr[offset] << 8) | arr[offset + 1]
}

/** Write a 32-bit big-endian unsigned integer into a byte array at offset. */
function writeUint32BE(arr: Uint8Array, value: number, offset: number): void {
  arr[offset] = (value >>> 24) & 0xff
  arr[offset + 1] = (value >>> 16) & 0xff
  arr[offset + 2] = (value >>> 8) & 0xff
  arr[offset + 3] = value & 0xff
}

/** Read a 32-bit big-endian unsigned integer from a byte array at offset. */
export function readUint32BE(arr: Uint8Array, offset: number): number {
  return ((arr[offset] << 24) | (arr[offset + 1] << 16) | (arr[offset + 2] << 8) | arr[offset + 3]) >>> 0
}

// ── Chunking ──

/**
 * Split a serialized payload into BLE-writable chunks.
 *
 * Returns an array of Uint8Array chunks ready to be written via BLE.
 * The first chunk is the metadata chunk (total size, checksum, chunk count).
 * Subsequent chunks contain data with proper sequencing and flags.
 *
 * @param payload - The full serialized payload as Uint8Array
 * @param payloadSizePerChunk - Max data bytes per chunk (default CHUNK_PAYLOAD_SIZE).
 *   Pass a smaller value when the negotiated BLE MTU is below the default.
 *   Effective data per write = MTU - 3 (ATT header) - CHUNK_HEADER_SIZE.
 * @returns Array of chunk buffers to write in order
 * @throws If payload exceeds MAX_PAYLOAD_SIZE
 */
export function chunkPayload(payload: Uint8Array, payloadSizePerChunk: number = CHUNK_PAYLOAD_SIZE): Uint8Array[] {
  if (payload.length > MAX_PAYLOAD_SIZE) {
    throw new Error(`Payload too large: ${payload.length} bytes exceeds ${MAX_PAYLOAD_SIZE} byte limit`)
  }

  const checksum = crc32(payload)
  const totalDataChunks = Math.ceil(payload.length / payloadSizePerChunk)
  const chunks: Uint8Array[] = []

  // Metadata chunk (seq=0, flags=FLAG_METADATA)
  const metaPayload = new Uint8Array(12)
  writeUint32BE(metaPayload, payload.length, 0)
  writeUint32BE(metaPayload, checksum, 4)
  writeUint32BE(metaPayload, totalDataChunks, 8)

  const metaChunk = new Uint8Array(CHUNK_HEADER_SIZE + metaPayload.length)
  writeUint16BE(metaChunk, 0, 0) // seq = 0
  metaChunk[2] = FLAG_METADATA // flags
  metaChunk.set(metaPayload, CHUNK_HEADER_SIZE)
  chunks.push(metaChunk)

  // Data chunks (seq=1..N)
  for (let i = 0; i < totalDataChunks; i++) {
    const start = i * payloadSizePerChunk
    const end = Math.min(start + payloadSizePerChunk, payload.length)
    const slice = payload.slice(start, end)
    const isLast = i === totalDataChunks - 1

    const chunk = new Uint8Array(CHUNK_HEADER_SIZE + slice.length)
    writeUint16BE(chunk, i + 1, 0) // seq = i+1
    chunk[2] = isLast ? FLAG_FINAL : FLAG_DATA // flags
    chunk.set(slice, CHUNK_HEADER_SIZE)
    chunks.push(chunk)
  }

  return chunks
}

// ── Reassembly ──

/**
 * Stateful chunk reassembler. Collects incoming chunks and verifies
 * the final payload against the metadata checksum.
 */
export class ChunkReassembler {
  private metadata: ChunkMetadata | null = null
  private receivedChunks: Map<number, Uint8Array> = new Map()
  private _isComplete = false

  /** Whether we've received the metadata chunk */
  get hasMetadata(): boolean {
    return this.metadata !== null
  }

  /** Whether all chunks have been received */
  get isComplete(): boolean {
    return this._isComplete
  }

  /** Progress as 0–100 integer */
  get progress(): number {
    if (!this.metadata) return 0
    return Math.min(100, Math.round((this.receivedChunks.size / this.metadata.totalChunks) * 100))
  }

  /** Expected metadata (available after first chunk) */
  get expectedMetadata(): ChunkMetadata | null {
    return this.metadata
  }

  /**
   * Parse the metadata from the first chunk's payload.
   */
  parseMetadata(payload: Uint8Array): ChunkMetadata {
    return {
      totalBytes: readUint32BE(payload, 0),
      checksum: readUint32BE(payload, 4),
      totalChunks: readUint32BE(payload, 8)
    }
  }

  /**
   * Feed a raw chunk (as received from BLE write) into the reassembler.
   *
   * @returns The sequence number of the chunk, or -1 for metadata
   * @throws On size/order validation errors
   */
  addChunk(chunkData: Uint8Array): number {
    if (chunkData.length < CHUNK_HEADER_SIZE) {
      throw new Error('Chunk too small')
    }

    const seq = readUint16BE(chunkData, 0)
    const flags = chunkData[2]
    const payload = chunkData.slice(CHUNK_HEADER_SIZE)

    if (flags === FLAG_METADATA) {
      this.metadata = this.parseMetadata(payload)
      if (this.metadata.totalBytes > MAX_PAYLOAD_SIZE) {
        throw new Error(`Advertised payload size ${this.metadata.totalBytes} exceeds limit`)
      }
      return -1 // metadata indicator
    }

    if (!this.metadata) {
      throw new Error('Received data chunk before metadata')
    }

    // Store the data payload keyed by sequence (1-based)
    this.receivedChunks.set(seq, payload)

    // Check if we have all chunks
    if (this.receivedChunks.size >= this.metadata.totalChunks) {
      this._isComplete = true
    }

    return seq
  }

  /**
   * Assemble all received chunks into the full payload and verify checksum.
   *
   * @returns The verified payload
   * @throws If incomplete or checksum mismatch
   */
  assemble(): Uint8Array {
    if (!this.metadata) throw new Error('No metadata received')
    if (!this._isComplete) throw new Error('Transfer not complete')

    const result = new Uint8Array(this.metadata.totalBytes)
    let offset = 0

    for (let seq = 1; seq <= this.metadata.totalChunks; seq++) {
      const chunk = this.receivedChunks.get(seq)
      if (!chunk) throw new Error(`Missing chunk ${seq}`)
      result.set(chunk, offset)
      offset += chunk.length
    }

    // Verify checksum
    const actualChecksum = crc32(result)
    if (actualChecksum !== this.metadata.checksum) {
      throw new Error(
        `Checksum mismatch: expected 0x${this.metadata.checksum.toString(16)}, ` +
          `got 0x${actualChecksum.toString(16)}`
      )
    }

    return result
  }

  /** Reset for a new transfer */
  reset(): void {
    this.metadata = null
    this.receivedChunks.clear()
    this._isComplete = false
  }
}

// ── Serialization Helpers ──

/** Serialize a BLE payment payload to Uint8Array for chunking */
export function serializePayload(payload: object): Uint8Array {
  const json = JSON.stringify(payload)
  return new TextEncoder().encode(json)
}

/** Deserialize a Uint8Array back to a parsed object */
export function deserializePayload<T>(data: Uint8Array): T {
  const json = new TextDecoder().decode(data)
  return JSON.parse(json) as T
}

// ── ACK Encoding ──

/** Build an ACK_METADATA response (1 byte) */
export function buildAckMetadata(opcode: number): string {
  return uint8ArrayToHex(new Uint8Array([opcode]))
}

/** Build an ACK_CHUNK response (1 byte opcode + 2 byte seq) */
export function buildAckChunk(opcode: number, seq: number): string {
  const buf = new Uint8Array(3)
  buf[0] = opcode
  writeUint16BE(buf, seq, 1)
  return uint8ArrayToHex(buf)
}

/** Build an ACK_COMPLETE response (1 byte) */
export function buildAckComplete(opcode: number): string {
  return uint8ArrayToHex(new Uint8Array([opcode]))
}

/** Build a NAK_ERROR response (1 byte opcode + 1 byte error code) */
export function buildNakError(opcode: number, errorCode: number): string {
  return uint8ArrayToHex(new Uint8Array([opcode, errorCode]))
}

// ── Hex Conversion (munim-bluetooth uses hex strings) ──

/** Convert Uint8Array to hex string */
export function uint8ArrayToHex(data: Uint8Array): string {
  return Array.from(data)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Convert hex string to Uint8Array */
export function hexToUint8Array(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16)
  }
  return bytes
}
