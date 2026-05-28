/**
 * PeerPay Outbox — Persistent Outbound Payment Token Queue
 *
 * Outbound PeerPay payments are persisted to the wallet's key_value_store table
 * BEFORE the payment token is delivered to the recipient's MessageBox. This ensures
 * the derivation data (derivationPrefix, derivationSuffix, AtomicBEEF) is never
 * lost if the app crashes or loses connectivity between transaction broadcast and
 * message delivery.
 *
 * Storage format: a JSON array stored under the key "peerpay_outbox".
 * Each entry includes the full PaymentToken plus metadata for tracking delivery state.
 *
 * Entries persist indefinitely until explicitly dismissed by the user.
 * Retry is manual — the UI surfaces unsent entries with a Retry button.
 */

// ── Types ──────────────────────────────────────────────────────────────────────

export interface OutboxEntry {
  /** Unique ID: `${timestamp}_${recipientKey.slice(0, 8)}` */
  id: string
  /** ISO 8601 creation timestamp */
  createdAt: string
  /** Recipient identity key (hex compressed pubkey) */
  recipient: string
  /** Full payment token — stored in its entirety so retry needs no wallet round-trip */
  token: {
    customInstructions: {
      derivationPrefix: string
      derivationSuffix: string
    }
    transaction: number[]
    amount: number
  }
  /** The MessageBox host URL used at creation time */
  messageBoxUrl: string
  status: 'unsent' | 'sent'
  /** ISO 8601 timestamp of most recent delivery attempt */
  lastAttemptAt?: string
  /** Error message from the most recent failed delivery attempt */
  lastError?: string
}

interface StorageLike {
  getKeyValue: (key: string) => Promise<string | undefined>
  setKeyValue: (key: string, value: string) => Promise<void>
}

// ── Constants ─────────────────────────────────────────────────────────────────

const OUTBOX_KEY = 'peerpay_outbox'

// ── Private helpers ───────────────────────────────────────────────────────────

async function readEntries(storage: StorageLike): Promise<OutboxEntry[]> {
  try {
    const raw = await storage.getKeyValue(OUTBOX_KEY)
    if (!raw) return []
    return JSON.parse(raw) as OutboxEntry[]
  } catch {
    return []
  }
}

async function writeEntries(storage: StorageLike, entries: OutboxEntry[]): Promise<void> {
  await storage.setKeyValue(OUTBOX_KEY, JSON.stringify(entries))
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns all outbox entries (any status).
 */
export async function getOutboxEntries(storage: StorageLike): Promise<OutboxEntry[]> {
  return readEntries(storage)
}

/**
 * Persist a new outbound payment token to the outbox before delivery is attempted.
 * Returns the generated entry ID.
 */
export async function saveOutboxEntry(
  storage: StorageLike,
  params: {
    recipient: string
    token: OutboxEntry['token']
    messageBoxUrl: string
  }
): Promise<string> {
  const { recipient, token, messageBoxUrl } = params
  const id = `${Date.now()}_${recipient.slice(0, 8)}`
  const entry: OutboxEntry = {
    id,
    createdAt: new Date().toISOString(),
    recipient,
    token,
    messageBoxUrl,
    status: 'unsent'
  }
  const all = await readEntries(storage)
  all.push(entry)
  await writeEntries(storage, all)
  return id
}

/**
 * Mark an entry as successfully delivered.
 * Called immediately after `sendMessage()` returns without error.
 */
export async function markOutboxSent(storage: StorageLike, id: string): Promise<void> {
  const all = await readEntries(storage)
  const entry = all.find(e => e.id === id)
  if (entry) {
    entry.status = 'sent'
    await writeEntries(storage, all)
  }
}

/**
 * Merge a partial update into an entry.
 * Used to record `lastAttemptAt` and `lastError` on failed retry attempts.
 */
export async function updateOutboxEntry(storage: StorageLike, id: string, patch: Partial<OutboxEntry>): Promise<void> {
  const all = await readEntries(storage)
  const idx = all.findIndex(e => e.id === id)
  if (idx !== -1) {
    all[idx] = { ...all[idx], ...patch }
    await writeEntries(storage, all)
  }
}

/**
 * Remove an entry from the outbox permanently.
 * Called when the user explicitly dismisses an entry.
 */
export async function removeOutboxEntry(storage: StorageLike, id: string): Promise<void> {
  const all = await readEntries(storage)
  await writeEntries(
    storage,
    all.filter(e => e.id !== id)
  )
}
