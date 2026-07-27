import type { PaymentFrame } from './codec'

export const PENDING_KEY = 'localpay_pending'
export const PEERPAY_PROTOCOL_ID: [number, string] = [2, '3241645161d8']
export const PEERPAY_LABEL = 'localpay'
export const PEERPAY_DESCRIPTION = 'Payment received from a nearby device'

export type PendingStatus = 'pending' | 'processing' | 'completed' | 'failed'

export interface PendingPayment {
  id: string
  receivedAt: string
  frame: PaymentFrame
  status: PendingStatus
  failureReason?: string
  lastAttemptAt?: string
}

export interface KVStorage {
  getKeyValue(k: string): Promise<string | undefined>
  setKeyValue(k: string, v: string): Promise<void>
}

interface Serialised extends Omit<PendingPayment, 'frame'> {
  frame: Omit<PaymentFrame, 'transaction'> & { transaction: number[] }
}

function toWire(p: PendingPayment): Serialised {
  return { ...p, frame: { ...p.frame, transaction: Array.from(p.frame.transaction) } }
}

function fromWire(s: Serialised): PendingPayment {
  return { ...s, frame: { ...s.frame, transaction: new Uint8Array(s.frame.transaction) } }
}

// All read-modify-write sequences on the queue share one storage key, so they
// must not interleave: a concurrent write built from a stale read silently
// drops entries. Every mutating path runs through this chain.
let queueLock: Promise<unknown> = Promise.resolve()

function withQueueLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = queueLock.then(fn, fn)
  queueLock = run.catch(() => undefined)
  return run
}

async function readAll(storage: KVStorage): Promise<PendingPayment[]> {
  // A storage failure must NOT be reported as "empty" — callers write back
  // what they read, so swallowing it here destroys the queue.
  const raw = await storage.getKeyValue(PENDING_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as Serialised[]).map(fromWire) : []
  } catch {
    return []
  }
}

async function writeAll(storage: KVStorage, list: PendingPayment[]): Promise<void> {
  await storage.setKeyValue(PENDING_KEY, JSON.stringify(list.map(toWire)))
}

export async function savePending(storage: KVStorage, frame: PaymentFrame): Promise<PendingPayment> {
  return withQueueLock(async () => {
    const entry: PendingPayment = {
      id: `${Date.now()}_${frame.senderIdentityKey.slice(0, 8)}`,
      receivedAt: new Date().toISOString(),
      frame,
      status: 'pending',
    }
    await writeAll(storage, [...(await readAll(storage)), entry])
    return entry
  })
}

export async function getPending(storage: KVStorage): Promise<PendingPayment[]> {
  return readAll(storage)
}

/** `processing` is included: a crash mid-flight must not strand a payment. */
export async function getUnprocessed(storage: KVStorage): Promise<PendingPayment[]> {
  return (await readAll(storage)).filter(p => p.status !== 'completed')
}

export async function updateStatus(
  storage: KVStorage,
  id: string,
  status: PendingStatus,
  failureReason?: string
): Promise<void> {
  return withQueueLock(async () => {
    const all = await readAll(storage)
    const next = all.map(p =>
      p.id === id ? { ...p, status, failureReason, lastAttemptAt: new Date().toISOString() } : p
    )
    await writeAll(storage, next)
  })
}

interface InternalizingWallet {
  internalizeAction(args: unknown, originator?: string): Promise<unknown>
}

export async function processPending(
  wallet: InternalizingWallet,
  storage: KVStorage,
  originator: string
): Promise<{ id: string; success: boolean; error?: string }[]> {
  const results: { id: string; success: boolean; error?: string }[] = []
  for (const p of await getUnprocessed(storage)) {
    await updateStatus(storage, p.id, 'processing')
    try {
      await wallet.internalizeAction(
        {
          tx: Array.from(p.frame.transaction),
          outputs: [
            {
              outputIndex: p.frame.outputIndex,
              protocol: 'wallet payment',
              paymentRemittance: {
                derivationPrefix: p.frame.derivationPrefix,
                derivationSuffix: p.frame.derivationSuffix,
                senderIdentityKey: p.frame.senderIdentityKey,
              },
            },
          ],
          description: PEERPAY_DESCRIPTION,
          labels: [PEERPAY_LABEL],
        },
        originator
      )
      await updateStatus(storage, p.id, 'completed')
      results.push({ id: p.id, success: true })
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      await updateStatus(storage, p.id, 'failed', error)
      results.push({ id: p.id, success: false, error })
    }
  }
  return results
}

export const SPENT_KEY = 'localpay_spent_sessions'

function sessionKey(sessionId: Uint8Array): string {
  return Array.from(sessionId, b => b.toString(16).padStart(2, '0')).join('')
}

async function readSpent(storage: KVStorage): Promise<string[]> {
  // Same as readAll: let storage errors propagate, swallow only parse failures.
  const raw = await storage.getKeyValue(SPENT_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as string[]) : []
  } catch {
    return []
  }
}

export async function markSessionSpent(storage: KVStorage, sessionId: Uint8Array): Promise<void> {
  return withQueueLock(async () => {
    const key = sessionKey(sessionId)
    const spent = await readSpent(storage)
    if (spent.includes(key)) return
    await storage.setKeyValue(SPENT_KEY, JSON.stringify([...spent, key]))
  })
}

export async function isSessionSpent(storage: KVStorage, sessionId: Uint8Array): Promise<boolean> {
  return (await readSpent(storage)).includes(sessionKey(sessionId))
}
