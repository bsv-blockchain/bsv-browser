/**
 * BLE P2P Payment Transfer — TypeScript Interfaces
 */

// ── Transfer State Machine ──
export type TransferPhase =
  | 'idle'
  | 'requesting_permission'
  | 'permission_denied'
  | 'advertising' // Receiver: GATT server up, waiting for sender
  | 'scanning' // Sender: looking for advertised service
  | 'connecting' // Sender: found device, establishing connection
  | 'connected' // Both: BLE link established
  | 'transferring' // Both: chunked data transfer in progress
  | 'complete' // Both: transfer + ACK successful
  | 'error' // Both: something went wrong

export type TransferRole = 'receiver' | 'sender' | null

export interface TransferState {
  phase: TransferPhase
  role: TransferRole
  /** 0–100 progress percentage during transferring phase */
  progress: number
  /** Human-readable status for UI display */
  statusText: string
  /** Error message when phase === 'error' */
  errorMessage: string | null
  /** Identity key of the connected peer (extracted from advertising data) */
  peerIdentityKey: string | null
  /** Resolved display identity of the peer */
  peerIdentity: PeerDisplayIdentity | null
  /** The received payment payload (receiver side, after transfer completes) */
  receivedPayload: BLEPaymentPayload | null
  /** Amount in satoshis (both sides) */
  amount: number | null
}

// ── Peer Display Identity ──
// Subset of DisplayableIdentity from @bsv/sdk
export interface PeerDisplayIdentity {
  name: string
  avatarURL: string
  abbreviatedKey: string
  identityKey: string
  badgeIconURL: string
  badgeLabel: string
}

// ── BLE Payment Payload ──
// Modeled after PeerPayClient's PaymentToken for compatibility.
// This is the JSON blob that gets serialized, chunked, and sent over BLE.
export interface BLEPaymentPayload {
  /** Protocol version for forward compatibility */
  version: 1
  /** Sender's compressed identity public key (hex) */
  senderIdentityKey: string
  /** The payment token (same structure as PeerPayClient.PaymentToken) */
  token: {
    customInstructions: {
      derivationPrefix: string // Base64 nonce
      derivationSuffix: string // Base64 nonce
    }
    /** AtomicBEEF transaction bytes as number[] */
    transaction: number[]
    /** Payment amount in satoshis */
    amount: number
    /** Output index in the transaction (defaults to 0) */
    outputIndex?: number
  }
}

// ── Chunk Metadata ──
// Sent as the first chunk (FLAG_METADATA) so the receiver knows what to expect.
export interface ChunkMetadata {
  /** Total byte count of the serialized payload */
  totalBytes: number
  /** CRC32 checksum of the full payload bytes */
  checksum: number
  /** Total number of data chunks that will follow */
  totalChunks: number
}

// ── BLE Event Log Entry ──
export interface BLELogEntry {
  timestamp: number
  direction: 'tx' | 'rx' | 'info' | 'error'
  message: string
}
