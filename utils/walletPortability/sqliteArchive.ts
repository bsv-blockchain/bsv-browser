import { Buffer } from '@craftzdog/react-native-buffer'
import type { SQLiteDatabase } from 'expo-sqlite'
import { createTables } from '@bsv/expo-wallet-toolbox/core/storage/schema/createTables'
import { ARCHIVE_TABLES, archiveStores, binaries, booleans, canonicalArchiveJson, checkCancelled, jsonFields, PortabilityError, required, rowKey, validateRow, type ArchiveRow, type ArchiveTable } from './schema'
import { archiveMetadata, archiveRows, initializeArchiveStage, storeArchiveEvents, validateArchiveStage } from './staging'

/** Validate a saved binding before any migration or wallet write can occur. */
export async function verifyArchiveStorageBinding(db: SQLiteDatabase, chain: string, storageIdentityKey: string, identityKey?: string): Promise<void> {
  const settings = await db.getAllAsync<{ chain: string; storageIdentityKey: string }>('SELECT chain,storageIdentityKey FROM settings LIMIT 2')
  if (settings.length !== 1 || settings[0].chain !== chain || settings[0].storageIdentityKey !== storageIdentityKey) throw new PortabilityError('identity')
  if (identityKey) {
    const users = await db.getAllAsync<{ identityKey: string }>('SELECT identityKey FROM users LIMIT 2')
    if (users.length !== 1 || users[0].identityKey !== identityKey) throw new PortabilityError('identity')
  }
}

const identifier = (value: string) => `"${value.replace(/"/g, '""')}"`
function portableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(child => {
    if (child == null) throw new PortabilityError('invalid', 'absent structured-array value')
    return portableJson(child)
  })
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, child]) => child != null).map(([key, child]) => [key, portableJson(child)]))
  return value
}
export function portableSqlRow(table: string, row: ArchiveRow): ArchiveRow {
  const result: ArchiveRow = {}
  for (const [key, value] of Object.entries(row)) {
    if (value == null) continue
    if (binaries[table]?.includes(key)) result[key] = Buffer.from(value).toString('base64')
    else if (jsonFields[table]?.includes(key)) result[key] = portableJson(typeof value === 'string' ? JSON.parse(value) : value)
    else if (booleans.has(key) || key === 'wasBroadcast') result[key] = Boolean(value)
    else if (value instanceof Date) result[key] = value.toISOString()
    else result[key] = value
  }
  return result
}
function storedSqlRow(table: string, row: ArchiveRow): ArchiveRow {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
    binaries[table]?.includes(key) ? Uint8Array.from(Buffer.from(value, 'base64'))
      : jsonFields[table]?.includes(key) ? JSON.stringify(value)
        : typeof value === 'boolean' ? Number(value) : value
  ]))
}

/** Empty destinations only. Preserve record identifiers, policies and dates;
 * runtime defaults never replace values present in the imported archive. */
export async function restoreStageDatabase(stage: SQLiteDatabase, destination: SQLiteDatabase, storageIdentity: string, report: (message: string) => void, signal?: AbortSignal): Promise<void> {
  const meta = await archiveMetadata(stage)
  await validateArchiveStage(stage, signal)
  await createTables(destination)
  for (const name of ['settings', 'users', ...Object.values(archiveStores)]) {
    if (await destination.getFirstAsync(`SELECT 1 FROM ${identifier(name)} LIMIT 1`)) throw new PortabilityError('storage', 'destination is not empty')
  }
  const columns = new Map<string, Set<string>>()
  const insert = async (table: string, sqlTable: string, row: ArchiveRow) => {
    checkCancelled(signal)
    let available = columns.get(sqlTable)
    if (!available) {
      available = new Set((await destination.getAllAsync<{ name: string }>(`PRAGMA table_info(${identifier(sqlTable)})`)).map(column => column.name))
      columns.set(sqlTable, available)
    }
    const stored = storedSqlRow(table, row), fields = Object.keys(stored)
    if (fields.some(field => !available!.has(field))) throw new PortabilityError('unsupported', `${table} fields require a newer storage schema`)
    await destination.runAsync(`INSERT INTO ${identifier(sqlTable)} (${fields.map(identifier).join(',')}) VALUES (${fields.map(() => '?').join(',')})`, ...fields.map(field => stored[field]))
  }
  await destination.execAsync('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON')
  try {
    await insert('sourceStorage', 'settings', { ...meta.sourceStorage, storageIdentityKey: storageIdentity, dbtype: 'SQLite' })
    await insert('user', 'users', meta.user)
    // Deferred FKs cover outgoing transactions that spend later-ordered rows.
    for (const table of ARCHIVE_TABLES) {
      report(`Restoring ${table}…`)
      for await (const row of archiveRows(stage, table, signal)) await insert(table, archiveStores[table], row)
    }
    if (await destination.getFirstAsync('PRAGMA foreign_key_check')) throw new PortabilityError('invalid', 'database references')
    checkCancelled(signal)
    await destination.execAsync('COMMIT')
  } catch (error) { await destination.execAsync('ROLLBACK'); throw error }

  // Read each value back through SQLite's native types. Defaults on previously
  // absent optional columns are allowed, but no archived value may disappear.
  for (const table of ARCHIVE_TABLES) {
    report(`Verifying ${table}…`)
    let count = 0
    for await (const row of archiveRows(stage, table, signal)) {
      const keys = table === 'outputTagMaps' ? ['outputId', 'outputTagId'] : table === 'txLabelMaps' ? ['transactionId', 'txLabelId'] : table === 'certificateFields' ? ['certificateId', 'fieldName'] : [required[table][0]]
      const stored = await destination.getFirstAsync<ArchiveRow>(`SELECT * FROM ${identifier(archiveStores[table])} WHERE ${keys.map(key => `${identifier(key)}=?`).join(' AND ')}`, ...keys.map(key => row[key]))
      if (!stored) throw new PortabilityError('storage', 'restored record missing')
      const read = portableSqlRow(table, stored)
      // Legacy exports encoded this optional boolean extension as the SQL/IDB
      // bit. Its meaning must survive, and its exact source bytes stay staged.
      if (table === 'provenTxReqs' && typeof row.wasBroadcast === 'number') read.wasBroadcast = Number(read.wasBroadcast)
      if (canonicalArchiveJson(Object.fromEntries(Object.keys(row).map(key => [key, read[key]]))) !== canonicalArchiveJson(row)) throw new PortabilityError('storage', `${table} verification`)
      count++
    }
    const storedCount = await destination.getFirstAsync<{ count: number }>(`SELECT COUNT(*) AS count FROM ${identifier(archiveStores[table])}`)
    if (storedCount?.count !== count) throw new PortabilityError('storage', `${table} count`)
  }
}

/** The caller supplies a dedicated connection and holds the wallet access
 * queue. WAL's read transaction pins every table to one database snapshot. */
export async function captureSqliteArchive(source: SQLiteDatabase, stage: SQLiteDatabase, identityKey: string, report: (message: string) => void, signal?: AbortSignal, exportedAt = new Date().toISOString()): Promise<void> {
  await initializeArchiveStage(stage)
  await source.execAsync('BEGIN')
  try {
    const user = await source.getFirstAsync<ArchiveRow>('SELECT * FROM users WHERE identityKey=?', identityKey)
    const settings = await source.getFirstAsync<ArchiveRow>('SELECT * FROM settings LIMIT 1')
    if (!user || !settings) throw new PortabilityError('identity')
    const header = { brc: 38, title: 'User Wallet Data Format', formatVersion: 1, exportedAt, user: portableSqlRow('user', user), sourceStorage: portableSqlRow('sourceStorage', settings) }
    validateRow('user', header.user); validateRow('sourceStorage', header.sourceStorage)
    await storeArchiveEvents(stage, Object.entries(header).map(([key, value]) => ({ kind: 'metadata', key, json: canonicalArchiveJson(value) })))
    const ownedTransactions = 'SELECT transactionId FROM transactions WHERE userId=?'
    const ownedTxids = 'SELECT txid FROM transactions WHERE userId=? AND txid IS NOT NULL'
    const raw = async (txid: string, slice: boolean): Promise<Uint8Array | undefined> => {
      const proof = await source.getFirstAsync<{ rawTx: Uint8Array }>('SELECT rawTx FROM proven_txs WHERE txid=?', txid)
      if (proof?.rawTx) return proof.rawTx
      const request = await source.getFirstAsync<{ rawTx: Uint8Array; status: string }>('SELECT rawTx,status FROM proven_tx_reqs WHERE txid=?', txid)
      const statuses = slice ? ['unsent', 'nosend', 'sending', 'unmined', 'completed', 'unfail'] : ['unsent', 'unmined', 'unconfirmed', 'sending', 'nosend', 'completed']
      return request && statuses.includes(request.status) ? request.rawTx : undefined
    }
    for (const table of ARCHIVE_TABLES) {
      report(`Capturing ${table}…`)
      let query = `SELECT * FROM ${identifier(archiveStores[table])} WHERE userId=?`
      let params: Array<string | number> = [user.userId]
      if (table === 'provenTxs') {
        query = `SELECT * FROM proven_txs WHERE provenTxId IN (SELECT provenTxId FROM transactions WHERE userId=? UNION SELECT provenTxId FROM proven_tx_reqs WHERE txid IN (${ownedTxids})) ORDER BY provenTxId`
        params = [user.userId, user.userId]
      } else if (table === 'provenTxReqs') query = `SELECT * FROM proven_tx_reqs WHERE txid IN (${ownedTxids}) ORDER BY provenTxReqId`
      else if (table === 'outputTagMaps') {
        query = 'SELECT * FROM output_tags_map WHERE outputId IN (SELECT outputId FROM outputs WHERE userId=?) AND outputTagId IN (SELECT outputTagId FROM output_tags WHERE userId=?) ORDER BY outputId,outputTagId'
        params = [user.userId, user.userId]
      } else if (table === 'txLabelMaps') {
        query = `SELECT * FROM tx_labels_map WHERE transactionId IN (${ownedTransactions}) AND txLabelId IN (SELECT txLabelId FROM tx_labels WHERE userId=?) ORDER BY transactionId,txLabelId`
        params = [user.userId, user.userId]
      }
      if (!query.includes('ORDER BY')) {
        const keys = table === 'certificateFields' ? ['certificateId', 'fieldName'] : [required[table][0]]
        query += ` ORDER BY ${keys.map(identifier).join(',')}`
      }
      let ordinal = 0
      let queued: import('./streamParser').ArchiveEvent[] = [], queuedBytes = 0
      const flush = async () => { await storeArchiveEvents(stage, queued); queued = []; queuedBytes = 0 }
      for await (const item of source.getEachAsync<ArchiveRow>(query, ...params)) {
        checkCancelled(signal)
        if (table === 'transactions' && !item.rawTx && item.txid) item.rawTx = await raw(item.txid, false)
        if (table === 'outputs' && item.scriptLength && item.scriptOffset != null && item.txid && item.lockingScript?.length !== item.scriptLength) {
          const bytes = await raw(item.txid, true)
          if (bytes) item.lockingScript = bytes.slice(item.scriptOffset, item.scriptOffset + item.scriptLength)
        }
        const row = validateRow(table, portableSqlRow(table, item))
        const json = canonicalArchiveJson(row)
        queued.push({ kind: 'row', table, ordinal: ordinal++, rowKey: rowKey(table, row), json })
        queuedBytes += json.length * 2
        if (queued.length >= 200 || queuedBytes >= 256 * 1024) await flush()
      }
      await flush()
      await storeArchiveEvents(stage, [{ kind: 'table', table }])
    }
    await validateArchiveStage(stage, signal)
    await source.execAsync('COMMIT')
  } catch (error) { await source.execAsync('ROLLBACK'); throw error }
}
