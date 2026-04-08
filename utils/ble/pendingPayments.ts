/**
 * BLE Pending Payments — Persistence & Auto-Internalization
 *
 * Received BLE payments are persisted to the wallet's key_value_store table
 * before internalization. This ensures payments are never lost if the device
 * is offline or the wallet isn't ready when the transfer completes.
 *
 * Storage format: a JSON array stored under the key "ble_pending_payments".
 * Each entry includes the full BLEPaymentPayload plus metadata for tracking
 * internalization state.
 *
 * Auto-internalization is triggered:
 *   1. Immediately after BLE receipt (if wallet is ready and online)
 *   2. After wallet build completes on subsequent app opens
 *   3. When the device comes back online (via NetInfo listener)
 */

import type { BLEPaymentPayload } from './types'
import { PEERPAY_DESCRIPTION, PEERPAY_LABEL } from './constants'

// ── Types ──

export type PendingPaymentStatus = 'pending' | 'processing' | 'completed' | 'failed'

export interface PendingBLEPayment {
  /** Unique ID: `${receivedAt}_${senderIdentityKey.slice(0,8)}` */
  id: string
  receivedAt: string // ISO 8601
  payload: BLEPaymentPayload
  status: PendingPaymentStatus
  failureReason?: string
  /** ISO 8601 timestamp of last internalization attempt */
  lastAttemptAt?: string
}

export interface InternalizationResult {
  id: string
  success: boolean
  error?: string
}

// ── Storage Key ──
const STORAGE_KEY = 'ble_pending_payments'

// ── Helpers ──

function makeId(payload: BLEPaymentPayload): string {
  const ts = Date.now()
  const keySlice = payload.senderIdentityKey.slice(0, 8)
  return `${ts}_${keySlice}`
}

async function readAll(storage: {
  getKeyValue: (k: string) => Promise<string | undefined>
}): Promise<PendingBLEPayment[]> {
  try {
    const raw = await storage.getKeyValue(STORAGE_KEY)
    if (!raw) return []
    return JSON.parse(raw) as PendingBLEPayment[]
  } catch {
    return []
  }
}

async function writeAll(
  storage: { setKeyValue: (k: string, v: string) => Promise<void> },
  payments: PendingBLEPayment[]
): Promise<void> {
  await storage.setKeyValue(STORAGE_KEY, JSON.stringify(payments))
}

// ── Public API ──

/**
 * Persist a newly received BLE payment to the queue.
 * Returns the generated ID for the entry.
 */
export async function savePendingPayment(
  storage: {
    getKeyValue: (k: string) => Promise<string | undefined>
    setKeyValue: (k: string, v: string) => Promise<void>
  },
  payload: BLEPaymentPayload
): Promise<string> {
  const all = await readAll(storage)
  const id = makeId(payload)
  const entry: PendingBLEPayment = {
    id,
    receivedAt: new Date().toISOString(),
    payload,
    status: 'pending'
  }
  all.push(entry)
  await writeAll(storage, all)
  return id
}

/**
 * Return all pending payments (any status).
 */
export async function getPendingPayments(storage: {
  getKeyValue: (k: string) => Promise<string | undefined>
}): Promise<PendingBLEPayment[]> {
  return readAll(storage)
}

/**
 * Return only payments that still need internalization.
 */
export async function getUnprocessedPayments(storage: {
  getKeyValue: (k: string) => Promise<string | undefined>
}): Promise<PendingBLEPayment[]> {
  const all = await readAll(storage)
  return all.filter(p => p.status === 'pending' || p.status === 'failed')
}

/**
 * Update the status of a specific payment entry.
 */
export async function updatePaymentStatus(
  storage: {
    getKeyValue: (k: string) => Promise<string | undefined>
    setKeyValue: (k: string, v: string) => Promise<void>
  },
  id: string,
  status: PendingPaymentStatus,
  failureReason?: string
): Promise<void> {
  const all = await readAll(storage)
  const idx = all.findIndex(p => p.id === id)
  if (idx === -1) return
  all[idx] = {
    ...all[idx],
    status,
    lastAttemptAt: new Date().toISOString(),
    ...(failureReason !== undefined ? { failureReason } : {})
  }
  await writeAll(storage, all)
}

/**
 * Try to internalize all pending/failed payments via the wallet.
 *
 * Returns an array of results — one per payment attempted. The caller
 * (WalletContext or local-payments screen) can use this to show
 * notifications for each successfully processed payment.
 *
 * @param wallet  - The wallet interface (permissionsManager)
 * @param storage - StorageExpoSQLite instance
 * @param originator - Admin originator string
 */
export async function processPendingPayments(
  wallet: {
    internalizeAction: (
      args: {
        tx: number[]
        outputs: Array<{
          paymentRemittance: { derivationPrefix: string; derivationSuffix: string; senderIdentityKey: string }
          outputIndex: number
          protocol: string
        }>
        labels: string[]
        description: string
      },
      originator: string
    ) => Promise<unknown>
  },
  storage: {
    getKeyValue: (k: string) => Promise<string | undefined>
    setKeyValue: (k: string, v: string) => Promise<void>
  },
  originator: string
): Promise<InternalizationResult[]> {
  const pending = await getUnprocessedPayments(storage)
  if (pending.length === 0) return []

  const results: InternalizationResult[] = []

  for (const entry of pending) {
    await updatePaymentStatus(storage, entry.id, 'processing')
    try {
      await wallet.internalizeAction(
        {
          tx: entry.payload.token.transaction,
          outputs: [
            {
              paymentRemittance: {
                derivationPrefix: entry.payload.token.customInstructions.derivationPrefix,
                derivationSuffix: entry.payload.token.customInstructions.derivationSuffix,
                senderIdentityKey: entry.payload.senderIdentityKey
              },
              outputIndex: entry.payload.token.outputIndex ?? 0,
              protocol: 'wallet payment'
            }
          ],
          labels: [PEERPAY_LABEL],
          description: PEERPAY_DESCRIPTION
        },
        originator
      )
      await updatePaymentStatus(storage, entry.id, 'completed')
      results.push({ id: entry.id, success: true })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      await updatePaymentStatus(storage, entry.id, 'failed', msg)
      results.push({ id: entry.id, success: false, error: msg })
    }
  }

  return results
}
