/**
 * Thin SQL mapper for `offline_actions`. Deliberately logic-free: every
 * decision about ordering, cascading, and status lives in
 * `utils/offline/order.ts` and `utils/offline/plan.ts`, which are unit-tested.
 * This file is validated on device.
 */
export type OfflineActionStatus = 'queued' | 'posting' | 'sent' | 'rejected'
export type OfflineActionRole = 'received' | 'sent'

export interface OfflineActionRow {
  offlineActionId: number
  created_at: string
  updated_at: string
  userId: number
  txid: string
  seq: number
  role: OfflineActionRole
  senderIdentityKey: string | null
  receivedVia: string | null
  status: OfflineActionStatus
  rejectedReason: string | null
  poisonedByTxid: string | null
  framePayload: string | null
}

/** The subset of bind values this mapper ever passes (no blobs). */
export type BindValue = string | number | null

/**
 * Structurally satisfied by expo-sqlite's SQLiteDatabase. `params` is
 * required (not optional) and narrowed to `BindValue[]` rather than
 * `unknown[]`: expo-sqlite's real signatures take `SQLiteBindParams`
 * (`Record<string, SQLiteBindValue> | SQLiteBindValue[]`) as a required
 * argument on the array-form overload, and TypeScript will not treat an
 * optional `unknown[]` parameter as structurally assignable from that —
 * `undefined` isn't a valid SQLiteBindParams, and `unknown` isn't a valid
 * SQLiteBindValue. Every call site below always passes an array, so
 * required is no burden.
 */
export interface OfflineDb {
  runAsync(sql: string, params: BindValue[]): Promise<unknown>
  getAllAsync(sql: string, params: BindValue[]): Promise<unknown[]>
  getFirstAsync(sql: string, params: BindValue[]): Promise<unknown>
}

export interface NewOfflineAction {
  userId: number
  txid: string
  role: OfflineActionRole
  senderIdentityKey?: string
  receivedVia?: string
  /** The payer's full `bsvpayf1:` QR string, so the code can be re-shown after an app restart. */
  framePayload?: string
}

/**
 * Idempotent: a re-delivered frame must not create a second queue row.
 * `seq` is allocated in the same statement as the insert (a scalar subquery
 * in the VALUES clause) rather than as a separate SELECT-then-INSERT, so
 * SQLite's single-writer lock covers both — two interleaved inserts cannot
 * read the same max and land the same seq.
 */
export async function insertOfflineAction(db: OfflineDb, entry: NewOfflineAction): Promise<void> {
  const now = new Date().toISOString()
  await db.runAsync(
    `INSERT OR IGNORE INTO offline_actions
       (created_at, updated_at, userId, txid, seq, role, senderIdentityKey, receivedVia, status, framePayload)
     VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM offline_actions), ?, ?, ?, 'queued', ?)`,
    [
      now,
      now,
      entry.userId,
      entry.txid,
      entry.role,
      entry.senderIdentityKey ?? null,
      entry.receivedVia ?? null,
      entry.framePayload ?? null
    ]
  )
}

export async function findOfflineActions(
  db: OfflineDb,
  filter: { status?: OfflineActionStatus[]; userId?: number } = {}
): Promise<OfflineActionRow[]> {
  const where: string[] = []
  const params: BindValue[] = []
  if (filter.status && filter.status.length > 0) {
    where.push(`status IN (${filter.status.map(() => '?').join(',')})`)
    params.push(...filter.status)
  }
  if (filter.userId !== undefined) {
    where.push('userId = ?')
    params.push(filter.userId)
  }
  const sql =
    'SELECT * FROM offline_actions' + (where.length ? ` WHERE ${where.join(' AND ')}` : '') + ' ORDER BY seq ASC'
  return (await db.getAllAsync(sql, params)) as OfflineActionRow[]
}

export async function updateOfflineAction(
  db: OfflineDb,
  txid: string,
  patch: {
    status?: OfflineActionStatus
    rejectedReason?: string | null
    poisonedByTxid?: string | null
    /**
     * Backfilled after the fact: the row is inserted (with both attribution
     * columns null) from deep inside the storage layer's offline-hold path,
     * which never sees the payment frame. `utils/localpay/pending.ts`'s
     * `processPending` is the one place that has both the txid and the frame,
     * once `internalizeAction` resolves — see its `attribute` callback.
     */
    senderIdentityKey?: string | null
    receivedVia?: string | null
  }
): Promise<void> {
  const sets: string[] = ['updated_at = ?']
  const params: BindValue[] = [new Date().toISOString()]
  if (patch.status !== undefined) {
    sets.push('status = ?')
    params.push(patch.status)
  }
  if (patch.rejectedReason !== undefined) {
    sets.push('rejectedReason = ?')
    params.push(patch.rejectedReason)
  }
  if (patch.poisonedByTxid !== undefined) {
    sets.push('poisonedByTxid = ?')
    params.push(patch.poisonedByTxid)
  }
  if (patch.senderIdentityKey !== undefined) {
    sets.push('senderIdentityKey = ?')
    params.push(patch.senderIdentityKey)
  }
  if (patch.receivedVia !== undefined) {
    sets.push('receivedVia = ?')
    params.push(patch.receivedVia)
  }
  params.push(txid)
  await db.runAsync(`UPDATE offline_actions SET ${sets.join(', ')} WHERE txid = ?`, params)
}
