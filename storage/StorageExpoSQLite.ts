import * as SQLite from 'expo-sqlite'
import type { SQLiteDatabase } from 'expo-sqlite'
import { createTables, ensureOfflineActionsColumns } from './schema/createTables'
import {
  PROVEN_HEIGHTS_SQL,
  buildFindSql,
  columnsExcluding,
  fullReadSql,
  rangeReadSql,
  spendingReferencesSql,
  splitOutpoint
} from './methods/findSql'
import { scrubHistoryJson } from './methods/historyNotes'
import { compressScriptBytes, isCompressed } from '@/services/vault/templateCodec'
import {
  COMPRESS_PROVEN_TX_RAWTX,
  assertExpanded,
  compressOutputScript,
  compressStoredBeef,
  compressStoredTx,
  expandStoredRange,
  expandStoredScript,
  expandStoredTx
} from './methods/expandStored'
import { compressOneAtRest, type CompactionStep } from './methods/compressAtRest'
import { StorageError, storageErrorFromSqlite } from './errors'
import {
  RECLAIM_CANDIDATES_SQL,
  RECLAIM_EXCLUDED_SQL,
  RECLAIM_INPUT_BEEF_SQL,
  RECLAIM_SIZES_SQL,
  type ReclaimReport
} from './methods/reclaim'
import { availableDiskBytes, diskPressure } from '../utils/diskSpace'
import { devLog } from '../utils/logging'
import { StorageProvider } from '@bsv/wallet-toolbox-mobile'
import type { StorageProviderOptions } from '@bsv/wallet-toolbox-mobile'
import type {
  AuthId,
  FindCertificateFieldsArgs,
  FindCertificatesArgs,
  FindCommissionsArgs,
  FindMonitorEventsArgs,
  FindOutputBasketsArgs,
  FindOutputsArgs,
  FindOutputTagsArgs,
  FindOutputTagMapsArgs,
  FindProvenTxReqsArgs,
  FindProvenTxsArgs,
  FindSyncStatesArgs,
  FindTransactionsArgs,
  FindTxLabelsArgs,
  FindTxLabelMapsArgs,
  FindUsersArgs,
  FindForUserSincePagedArgs,
  ProcessSyncChunkResult,
  ProvenOrRawTx,
  PurgeParams,
  PurgeResults,
  RequestSyncChunkArgs,
  SyncChunk,
  TrxToken
} from '@bsv/wallet-toolbox-mobile/out/src/sdk/WalletStorage.interfaces'
import type { AdminStatsResult } from '@bsv/wallet-toolbox-mobile/out/src/storage/StorageProvider'
import type {
  TableCertificate,
  TableCertificateField,
  TableCertificateX,
  TableCommission,
  TableMonitorEvent,
  TableOutput,
  TableOutputBasket,
  TableOutputTag,
  TableOutputTagMap,
  TableProvenTx,
  TableProvenTxReq,
  TableSettings,
  TableSyncState,
  TableTransaction,
  TableTxLabel,
  TableTxLabelMap,
  TableUser
} from '@bsv/wallet-toolbox-mobile/out/src/storage/schema/tables'
import type { ListActionsResult, ListOutputsResult, Validation, WalletLoggerInterface } from '@bsv/sdk'
import { Beef } from '@bsv/sdk'
import type { EntityProvenTxReq } from '@bsv/wallet-toolbox-mobile/out/src/storage/schema/entities'
import type { PostReqsToNetworkResult } from '@bsv/wallet-toolbox-mobile/out/src/storage/methods/attemptToPostReqsToNetwork'
import { listActionsSql } from './methods/listActionsSql'
import { listOutputsSql } from './methods/listOutputsSql'
import { insertOfflineAction, type OfflineActionRole } from './methods/offlineActions'
import { buildOfflineHoldResult, groupOfflineHolds } from '../utils/offline/hold'
import { getOnline } from '../utils/net/online'
import { TaskSendOffline } from '../utils/monitor/TaskSendOffline'

export interface StorageExpoSQLiteOptions extends StorageProviderOptions {
  databaseName?: string
  identityKey?: string
}

/**
 * SQLite storage provider for BSV wallet using expo-sqlite.
 * Extends StorageProvider to inherit business logic (createAction, internalizeAction, etc.)
 * while implementing only the abstract CRUD methods.
 */
export class StorageExpoSQLite extends StorageProvider {
  dbName: string
  db?: SQLiteDatabase

  constructor(options: StorageExpoSQLiteOptions) {
    super(options)
    const keySuffix = (options.identityKey || 'default').slice(-8)
    this.dbName = options.databaseName || `wallet-${keySuffix}-${this.chain}net.db`
  }

  // ============================================================================
  // Infrastructure methods
  // ============================================================================

  async migrate(storageName: string, storageIdentityKey: string): Promise<string> {
    this.db = await SQLite.openDatabaseAsync(this.dbName)
    await createTables(this.db)
    await ensureOfflineActionsColumns(this.db)

    // Check/insert settings
    const existing = (await this.db.getFirstAsync('SELECT * FROM settings WHERE storageIdentityKey = ?', [
      storageIdentityKey
    ])) as any
    if (!existing) {
      const now = new Date().toISOString()
      await this.db.runAsync(
        `INSERT INTO settings (storageIdentityKey, storageName, chain, dbtype, maxOutputScript, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [storageIdentityKey, storageName, this.chain, 'SQLite', 1024, now, now]
      )
    }

    this._settings = await this.readSettings()
    this.whenLastAccess = new Date()
    return '1'
  }

  async readSettings(_trx?: TrxToken): Promise<TableSettings> {
    const db = this.getDB()
    const row = (await db.getFirstAsync('SELECT * FROM settings LIMIT 1')) as any
    if (!row) throw new Error('Settings not found. Call migrate() first.')
    return this.validateEntity({ ...row })
  }

  async destroy(): Promise<void> {
    if (this.db) {
      await this.db.closeAsync()
    }
    this.db = undefined
    this._settings = undefined
  }

  // ============================================================================
  // Key-value store (for app-level state like SSE lastEventId)
  // ============================================================================

  async getKeyValue(key: string): Promise<string | undefined> {
    const db = this.getDB()
    const row = (await db.getFirstAsync('SELECT value FROM key_value_store WHERE key = ?', [key])) as {
      value: string
    } | null
    return row?.value
  }

  async setKeyValue(key: string, value: string): Promise<void> {
    const db = this.getDB()
    await db.runAsync(
      `INSERT INTO key_value_store (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, value, new Date().toISOString()]
    )
  }

  /**
   * Every wallet write funnels through here, which makes it the one place a
   * storage-pressure gate and a failure classifier need to live.
   *
   * The pre-flight check is not belt-and-braces, it is the only reliable
   * diagnosis: withExclusiveTransactionAsync awaits ROLLBACK inside its own
   * catch BEFORE recording the error, so a rollback that also fails under disk
   * pressure propagates instead and the original cause is destroyed.
   * (node_modules/expo-sqlite/src/SQLiteDatabase.ts:184-189.)
   *
   * 'unknown' pressure proceeds. The reading can be null on either platform, and
   * refusing writes because the disk could not be read would be worse than the
   * problem — see utils/diskSpace.ts.
   */
  async transaction<T>(scope: (trx: TrxToken) => Promise<T>, trx?: TrxToken): Promise<T> {
    // If already inside a transaction, reuse it — no nested BEGIN.
    if (trx) return await scope(trx)

    if (diskPressure() === 'block') {
      throw new StorageError(
        'disk-full',
        'Not enough free storage to write to the wallet database. Free some space and try again.'
      )
    }

    const db = this.getDB()
    const token: TrxToken = { _inTrx: true } as any

    // withExclusiveTransactionAsync opens a dedicated connection for the
    // transaction so no other async queries can interleave with BEGIN/COMMIT.
    // All queries executed inside scope() must go through that connection, so
    // we temporarily replace this.db with the exclusive txn object and restore
    // it when the scope completes (or throws).
    let result!: T
    try {
      await db.withExclusiveTransactionAsync(async txn => {
        const savedDb = this.db
        this.db = txn as any
        try {
          result = await scope(token)
        } finally {
          this.db = savedDb
        }
      })
    } catch (e) {
      // Rethrow a recognisable storage failure as a typed one so the UI can say
      // something true about it. Anything unrecognised passes through untouched:
      // guessing would turn a schema bug into a "free up space" prompt.
      const classified = storageErrorFromSqlite(e)
      throw classified ?? e
    }
    return result
  }

  async dropAllData(): Promise<void> {
    throw new Error('dropAllData is not supported — this database contains critical wallet data')
  }

  // ============================================================================
  // Validation helpers (matching StorageIdb patterns)
  // ============================================================================

  verifyReadyForDatabaseAccess(_trx?: TrxToken): string {
    if (!this._settings) {
      throw new Error('Settings not loaded. Call migrate() first.')
    }
    return this._settings.dbtype as string
  }

  private getDB(): SQLiteDatabase {
    if (!this.db) throw new Error('Database not initialized. Call migrate() first.')
    this.whenLastAccess = new Date()
    return this.db
  }

  validateEntity(entity: any, dateFields?: string[], booleanFields?: string[]): any {
    entity.created_at = this.validateDate(entity.created_at)
    entity.updated_at = this.validateDate(entity.updated_at)
    if (dateFields) {
      for (const df of dateFields) {
        if (entity[df]) entity[df] = this.validateDate(entity[df])
      }
    }
    if (booleanFields) {
      for (const df of booleanFields) {
        if (entity[df] !== undefined) entity[df] = !!entity[df]
      }
    }
    for (const key of Object.keys(entity)) {
      const val = entity[key]
      if (val === null) {
        entity[key] = undefined
      } else if (val instanceof Uint8Array) {
        entity[key] = Array.from(val)
      }
    }
    return entity
  }

  validateEntities(entities: any[], dateFields?: string[], booleanFields?: string[]): any[] {
    for (let i = 0; i < entities.length; i++) {
      entities[i] = this.validateEntity(entities[i], dateFields, booleanFields)
    }
    return entities
  }

  validatePartialForUpdate(update: any, dateFields?: string[], booleanFields?: string[]): any {
    this.verifyReadyForDatabaseAccess()
    const v = { ...update } as any
    if (v.created_at) v.created_at = this.validateEntityDate(v.created_at)
    if (v.updated_at) v.updated_at = this.validateEntityDate(v.updated_at)
    if (!v.created_at) delete v.created_at
    if (!v.updated_at) v.updated_at = this.validateEntityDate(new Date())
    if (dateFields) {
      for (const df of dateFields) {
        if (v[df]) v[df] = this.validateOptionalEntityDate(v[df])
      }
    }
    if (booleanFields) {
      for (const df of booleanFields) {
        if (update[df] !== undefined) v[df] = !!update[df] ? 1 : 0
      }
    }
    for (const key of Object.keys(v)) {
      const val = v[key]
      if (Array.isArray(val) && (val.length === 0 || Number.isInteger(val[0]))) {
        v[key] = Uint8Array.from(val)
      } else if (val === null) {
        v[key] = undefined
      } else if (typeof val === 'boolean') {
        // SQLite: always convert booleans to 0/1
        v[key] = val ? 1 : 0
      }
    }
    this.isDirty = true
    return v
  }

  async validateEntityForInsert(
    entity: any,
    trx?: TrxToken,
    dateFields?: string[],
    booleanFields?: string[]
  ): Promise<any> {
    this.verifyReadyForDatabaseAccess(trx)
    const v = { ...entity } as any
    v.created_at = this.validateOptionalEntityDate(v.created_at, true)
    v.updated_at = this.validateOptionalEntityDate(v.updated_at, true)
    if (!v.created_at) delete v.created_at
    if (!v.updated_at) delete v.updated_at
    if (dateFields) {
      for (const df of dateFields) {
        if (v[df]) v[df] = this.validateOptionalEntityDate(v[df])
      }
    }
    if (booleanFields) {
      for (const df of booleanFields) {
        if (entity[df] !== undefined) v[df] = !!entity[df] ? 1 : 0
      }
    }
    for (const key of Object.keys(v)) {
      const val = v[key]
      if (Array.isArray(val) && (val.length === 0 || Number.isInteger(val[0]))) {
        v[key] = Uint8Array.from(val)
      } else if (val === null) {
        v[key] = undefined
      } else if (typeof val === 'boolean') {
        // SQLite: always convert booleans to 0/1
        v[key] = val ? 1 : 0
      }
    }
    this.isDirty = true
    return v
  }

  // ============================================================================
  // Generic SQL helpers
  // ============================================================================

  private buildWhere(partial: Record<string, any>, extras?: string[]): { sql: string; params: any[] } {
    const conditions: string[] = []
    const params: any[] = []
    for (const [key, value] of Object.entries(partial)) {
      if (value !== undefined) {
        conditions.push(`"${key}" = ?`)
        // Convert booleans to 0/1 for SQLite, Dates to strings
        const v =
          typeof value === 'boolean'
            ? value
              ? 1
              : 0
            : value instanceof Date
              ? this.validateDateForWhere(value)
              : value
        params.push(v)
      }
    }
    if (extras) {
      for (const e of extras) conditions.push(e)
    }
    const sql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    return { sql, params }
  }

  /**
   * @param columns explicit projection. Omit for `SELECT *`. Passing the
   * non-blob columns is what makes `noRawTx`/`noScript` actually cheap: without
   * it every BLOB is read off disk and `Array.from`-expanded by validateEntity
   * before being discarded. See storage/methods/findSql.ts.
   */
  private async sqlFind<T>(
    table: string,
    args: {
      partial: Record<string, any>
      since?: Date
      paged?: { limit?: number; offset?: number }
      orderDescending?: boolean
      trx?: TrxToken
    },
    pkCol: string,
    extraClauses?: { conditions: string[]; params: any[] },
    columns?: string[]
  ): Promise<T[]> {
    const db = this.getDB()
    const { sql: whereSql, params } = this.buildWhere(args.partial)

    // Params must be pushed in the same order buildFindSql emits their
    // placeholders: where, then since, then the extra conditions.
    if (args.since) params.push(this.validateDateForWhere(args.since))
    if (extraClauses) params.push(...extraClauses.params)

    const query = buildFindSql({
      table,
      whereSql,
      hasSince: args.since !== undefined,
      extraConditions: extraClauses?.conditions,
      pkCol,
      orderDescending: args.orderDescending,
      limit: args.paged?.limit,
      offset: args.paged?.offset,
      columns
    })
    return (await db.getAllAsync(query, params)) as T[]
  }

  private async sqlCount(
    table: string,
    args: { partial: Record<string, any>; since?: Date; trx?: TrxToken },
    extraClauses?: { conditions: string[]; params: any[] }
  ): Promise<number> {
    const db = this.getDB()
    const { sql: whereSql, params } = this.buildWhere(args.partial)
    let query = `SELECT COUNT(*) as count FROM "${table}" ${whereSql}`

    if (args.since) {
      query += `${whereSql ? ' AND' : ' WHERE'} updated_at >= ?`
      params.push(this.validateDateForWhere(args.since))
    }
    if (extraClauses) {
      for (const c of extraClauses.conditions) {
        query += `${whereSql || args.since ? ' AND' : ' WHERE'} ${c}`
      }
      params.push(...extraClauses.params)
    }
    const result = (await db.getFirstAsync(query, params)) as any
    return result?.count || 0
  }

  /**
   * The same shape as sqlCount, for a SUM over one column — so a total can be
   * computed by SQLite instead of by marshalling every row into JS to add it up.
   * `column` is never caller-supplied; it names a schema column literally.
   */
  private async sqlSum(
    table: string,
    column: string,
    args: { partial: Record<string, any>; since?: Date; trx?: TrxToken },
    extraClauses?: { conditions: string[]; params: any[] }
  ): Promise<{ count: number; total: number }> {
    const db = this.getDB()
    const { sql: whereSql, params } = this.buildWhere(args.partial)
    let query = `SELECT COUNT(*) as count, COALESCE(SUM("${column}"), 0) as total FROM "${table}" ${whereSql}`

    if (args.since) {
      query += `${whereSql ? ' AND' : ' WHERE'} updated_at >= ?`
      params.push(this.validateDateForWhere(args.since))
    }
    if (extraClauses) {
      for (const c of extraClauses.conditions) {
        query += `${whereSql || args.since ? ' AND' : ' WHERE'} ${c}`
      }
      params.push(...extraClauses.params)
    }
    const result = (await db.getFirstAsync(query, params)) as any
    return { count: result?.count || 0, total: result?.total || 0 }
  }

  /**
   * Column names of a table, cached for the life of this connection.
   *
   * Read from the database rather than hardcoded so that a column added by a
   * later migration cannot silently disappear from reads that project columns
   * explicitly (see findOutputs' noScript path).
   */
  private tableColumnsCache = new Map<string, string[]>()
  private async tableColumns(table: string): Promise<string[]> {
    const cached = this.tableColumnsCache.get(table)
    if (cached) return cached
    const rows = (await this.getDB().getAllAsync(`PRAGMA table_info("${table}")`, [])) as { name: string }[]
    const names = rows.map(r => r.name)
    this.tableColumnsCache.set(table, names)
    return names
  }

  private async sqlInsert(table: string, entity: Record<string, any>, pkCol: string): Promise<number> {
    const db = this.getDB()
    const cols: string[] = []
    const placeholders: string[] = []
    const vals: any[] = []
    for (const [key, value] of Object.entries(entity)) {
      if (value !== undefined) {
        cols.push(`"${key}"`)
        placeholders.push('?')
        vals.push(value)
      }
    }
    const sql = `INSERT INTO "${table}" (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`
    try {
      const result = await db.runAsync(sql, vals)
      return result.lastInsertRowId
    } catch (e: any) {
      console.error(`[StorageExpoSQLite] INSERT into ${table} failed:`, e.message, '\nSQL:', sql, '\nCols:', cols)
      throw e
    }
  }

  private async sqlUpdate(
    table: string,
    ids: number | number[],
    update: Record<string, any>,
    pkCol: string
  ): Promise<number> {
    const db = this.getDB()
    const setClauses: string[] = []
    const vals: any[] = []
    for (const [key, value] of Object.entries(update)) {
      if (value !== undefined && key !== pkCol) {
        setClauses.push(`"${key}" = ?`)
        vals.push(value instanceof Date ? this.validateDateForWhere(value) : value)
      }
    }
    if (setClauses.length === 0) return 0
    const idArr = Array.isArray(ids) ? ids : [ids]
    const placeholders = idArr.map(() => '?').join(', ')
    vals.push(...idArr)
    const result = await db.runAsync(
      `UPDATE "${table}" SET ${setClauses.join(', ')} WHERE "${pkCol}" IN (${placeholders})`,
      vals
    )
    return result.changes
  }

  private async sqlUpdateComposite(
    table: string,
    keyMap: Record<string, any>,
    update: Record<string, any>
  ): Promise<number> {
    const db = this.getDB()
    const setClauses: string[] = []
    const vals: any[] = []
    for (const [key, value] of Object.entries(update)) {
      if (value !== undefined && !(key in keyMap)) {
        setClauses.push(`"${key}" = ?`)
        vals.push(value)
      }
    }
    if (setClauses.length === 0) return 0
    const whereClauses: string[] = []
    for (const [key, value] of Object.entries(keyMap)) {
      whereClauses.push(`"${key}" = ?`)
      vals.push(value)
    }
    const result = await db.runAsync(
      `UPDATE "${table}" SET ${setClauses.join(', ')} WHERE ${whereClauses.join(' AND ')}`,
      vals
    )
    return result.changes
  }

  // ============================================================================
  // INSERT methods (15)
  // ============================================================================

  async insertUser(user: TableUser, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(user, trx)
    if (e.userId === 0) delete e.userId
    const id = await this.sqlInsert('users', e, 'userId')
    user.userId = id
    return id
  }

  async insertProvenTx(tx: TableProvenTx, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(tx, trx)
    if (e.provenTxId === 0) delete e.provenTxId
    // Gated: this row is the merkle evidence, and Beef.verifyBumpIndexLeaves binds
    // hash256(rawTx) to a chain-committed leaf inside @bsv/sdk where no subclass
    // can intercept. See COMPRESS_PROVEN_TX_RAWTX.
    if (COMPRESS_PROVEN_TX_RAWTX) e.rawTx = (await compressStoredTx(e.rawTx, e.txid)) as number[]
    const id = await this.sqlInsert('proven_txs', e, 'provenTxId')
    tx.provenTxId = id
    return id
  }

  async insertProvenTxReq(tx: TableProvenTxReq, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(tx, trx)
    if (e.provenTxReqId === 0) delete e.provenTxReqId
    // See methods/historyNotes.ts: provider error notes carry the full EF/rawTx
    // hex and reach this column untruncated.
    e.history = scrubHistoryJson(e.history)
    // Compress-on-write. A vault transaction's rawTx is ~960 KB of template that
    // reconstructs from ~40 bytes; this is the column TaskSendWaiting re-reads in
    // full on every sweep and the one that pushed a backup chunk over the
    // server's 1 MiB cap.
    e.rawTx = await compressStoredTx(e.rawTx, e.txid)
    e.inputBEEF = await compressStoredBeef(e.inputBEEF)
    const id = await this.sqlInsert('proven_tx_reqs', e, 'provenTxReqId')
    tx.provenTxReqId = id
    return id
  }

  async insertCertificate(certificate: TableCertificate, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(certificate, trx, undefined, ['isDeleted'])
    const fields = (e as any).fields
    if (e.fields) delete (e as any).fields
    if (e.certificateId === 0) delete (e as any).certificateId
    const id = await this.sqlInsert('certificates', e, 'certificateId')
    certificate.certificateId = id
    if (fields) {
      for (const field of fields) {
        field.certificateId = id
        field.userId = certificate.userId
        await this.insertCertificateField(field, trx)
      }
    }
    return id
  }

  async insertCertificateField(certificateField: TableCertificateField, trx?: TrxToken): Promise<void> {
    const e = await this.validateEntityForInsert(certificateField, trx)
    await this.sqlInsert('certificate_fields', e, 'certificateId')
  }

  async insertCommission(commission: TableCommission, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(commission, trx)
    if (e.commissionId === 0) delete (e as any).commissionId
    const id = await this.sqlInsert('commissions', e, 'commissionId')
    commission.commissionId = id
    return id
  }

  async insertMonitorEvent(event: TableMonitorEvent, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(event, trx)
    if (e.id === 0) delete (e as any).id
    const id = await this.sqlInsert('monitor_events', e, 'id')
    event.id = id
    return id
  }

  async insertOutput(output: TableOutput, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(output, trx)
    if (e.outputId === 0) delete (e as any).outputId
    e.lockingScript = await compressOutputScript(e.lockingScript)
    const id = await this.sqlInsert('outputs', e, 'outputId')
    output.outputId = id
    return id
  }

  async insertOutputBasket(basket: TableOutputBasket, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(basket, trx, undefined, ['isDeleted'])
    if (e.basketId === 0) delete (e as any).basketId
    const id = await this.sqlInsert('output_baskets', e, 'basketId')
    basket.basketId = id
    return id
  }

  async insertOutputTag(tag: TableOutputTag, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(tag, trx, undefined, ['isDeleted'])
    if (e.outputTagId === 0) delete (e as any).outputTagId
    const id = await this.sqlInsert('output_tags', e, 'outputTagId')
    tag.outputTagId = id
    return id
  }

  async insertOutputTagMap(tagMap: TableOutputTagMap, trx?: TrxToken): Promise<void> {
    const e = await this.validateEntityForInsert(tagMap, trx, undefined, ['isDeleted'])
    await this.sqlInsert('output_tags_map', e, 'outputTagId')
  }

  async insertSyncState(syncState: TableSyncState, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(syncState, trx, ['when'], ['init'])
    if (e.syncStateId === 0) delete (e as any).syncStateId
    const id = await this.sqlInsert('sync_states', e, 'syncStateId')
    syncState.syncStateId = id
    return id
  }

  async insertTransaction(tx: TableTransaction, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(tx, trx)
    if (e.transactionId === 0) delete (e as any).transactionId
    e.rawTx = await compressStoredTx(e.rawTx, e.txid)
    e.inputBEEF = await compressStoredBeef(e.inputBEEF)
    const id = await this.sqlInsert('transactions', e, 'transactionId')
    tx.transactionId = id
    return id
  }

  async insertTxLabel(label: TableTxLabel, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(label, trx, undefined, ['isDeleted'])
    if (e.txLabelId === 0) delete (e as any).txLabelId
    const id = await this.sqlInsert('tx_labels', e, 'txLabelId')
    label.txLabelId = id
    return id
  }

  async insertTxLabelMap(labelMap: TableTxLabelMap, trx?: TrxToken): Promise<void> {
    const e = await this.validateEntityForInsert(labelMap, trx, undefined, ['isDeleted'])
    await this.sqlInsert('tx_labels_map', e, 'txLabelId')
  }

  // ============================================================================
  // UPDATE methods (15)
  // ============================================================================

  async updateUser(id: number, update: Partial<TableUser>, trx?: TrxToken): Promise<number> {
    const u = this.validatePartialForUpdate(update)
    return await this.sqlUpdate('users', id, u as any, 'userId')
  }

  async updateProvenTx(id: number, update: Partial<TableProvenTx>, trx?: TrxToken): Promise<number> {
    const u = this.validatePartialForUpdate(update) as any
    if (COMPRESS_PROVEN_TX_RAWTX && u.rawTx) {
      const row = (await this.getDB().getFirstAsync('SELECT txid FROM proven_txs WHERE provenTxId = ?', [
        id
      ])) as { txid?: string } | null
      u.rawTx = await compressStoredTx(u.rawTx, u.txid ?? row?.txid)
    }
    return await this.sqlUpdate('proven_txs', id, u, 'provenTxId')
  }

  /**
   * The single write path for proven_tx_reqs, and therefore the backstop for the
   * history column: every note the toolbox's own broadcast providers produce
   * arrives here, and they capture whole Extended Format payloads as hex.
   */
  async updateProvenTxReq(id: number | number[], update: Partial<TableProvenTxReq>, trx?: TrxToken): Promise<number> {
    const u = this.validatePartialForUpdate(update) as any
    if ('history' in u) u.history = scrubHistoryJson(u.history)
    // An update carrying rawTx must know which transaction it is, or the envelope
    // could not self-verify on the way out. When the txid is not part of the same
    // update, read it back rather than storing an unverifiable envelope.
    if (u.rawTx) {
      const txid = u.txid ?? (await this.txidOfProvenTxReq(id))
      u.rawTx = await compressStoredTx(u.rawTx, txid)
    }
    if (u.inputBEEF) u.inputBEEF = await compressStoredBeef(u.inputBEEF)
    return await this.sqlUpdate('proven_tx_reqs', id, u, 'provenTxReqId')
  }

  /** The txid of a single proven_tx_req, for a compress-on-update that did not
   * carry one. Returns undefined for a multi-row update, which then stores raw. */
  private async txidOfProvenTxReq(id: number | number[]): Promise<string | undefined> {
    if (Array.isArray(id)) return undefined
    const row = (await this.getDB().getFirstAsync(
      'SELECT txid FROM proven_tx_reqs WHERE provenTxReqId = ?',
      [id]
    )) as { txid?: string } | null
    return row?.txid
  }

  async updateCertificate(id: number, update: Partial<TableCertificate>, trx?: TrxToken): Promise<number> {
    const u = this.validatePartialForUpdate(update, undefined, ['isDeleted'])
    return await this.sqlUpdate('certificates', id, u as any, 'certificateId')
  }

  async updateCertificateField(
    certificateId: number,
    fieldName: string,
    update: Partial<TableCertificateField>,
    trx?: TrxToken
  ): Promise<number> {
    const u = this.validatePartialForUpdate(update)
    return await this.sqlUpdateComposite('certificate_fields', { certificateId, fieldName }, u as any)
  }

  async updateCommission(id: number, update: Partial<TableCommission>, trx?: TrxToken): Promise<number> {
    const u = this.validatePartialForUpdate(update)
    return await this.sqlUpdate('commissions', id, u as any, 'commissionId')
  }

  async updateMonitorEvent(id: number, update: Partial<TableMonitorEvent>, trx?: TrxToken): Promise<number> {
    const u = this.validatePartialForUpdate(update)
    return await this.sqlUpdate('monitor_events', id, u as any, 'id')
  }

  async updateOutput(id: number, update: Partial<TableOutput>, trx?: TrxToken): Promise<number> {
    const u = this.validatePartialForUpdate(update) as any
    if (u.lockingScript) u.lockingScript = await compressOutputScript(u.lockingScript)
    return await this.sqlUpdate('outputs', id, u, 'outputId')
  }

  async updateOutputBasket(id: number, update: Partial<TableOutputBasket>, trx?: TrxToken): Promise<number> {
    const u = this.validatePartialForUpdate(update, undefined, ['isDeleted'])
    return await this.sqlUpdate('output_baskets', id, u as any, 'basketId')
  }

  async updateOutputTag(id: number, update: Partial<TableOutputTag>, trx?: TrxToken): Promise<number> {
    const u = this.validatePartialForUpdate(update, undefined, ['isDeleted'])
    return await this.sqlUpdate('output_tags', id, u as any, 'outputTagId')
  }

  async updateOutputTagMap(
    outputId: number,
    tagId: number,
    update: Partial<TableOutputTagMap>,
    trx?: TrxToken
  ): Promise<number> {
    const u = this.validatePartialForUpdate(update, undefined, ['isDeleted'])
    return await this.sqlUpdateComposite('output_tags_map', { outputTagId: tagId, outputId }, u as any)
  }

  async updateSyncState(id: number, update: Partial<TableSyncState>, trx?: TrxToken): Promise<number> {
    const u = this.validatePartialForUpdate(update, ['when'], ['init'])
    return await this.sqlUpdate('sync_states', id, u as any, 'syncStateId')
  }

  async updateTransaction(id: number | number[], update: Partial<TableTransaction>, trx?: TrxToken): Promise<number> {
    const u = this.validatePartialForUpdate(update) as any
    if (u.rawTx) {
      const txid = u.txid ?? (await this.txidOfTransaction(id))
      u.rawTx = await compressStoredTx(u.rawTx, txid)
    }
    if (u.inputBEEF) u.inputBEEF = await compressStoredBeef(u.inputBEEF)
    return await this.sqlUpdate('transactions', id, u, 'transactionId')
  }

  /** The txid of a single transaction row, for a compress-on-update that did not
   * carry one. Undefined for a multi-row update, which then stores raw. */
  private async txidOfTransaction(id: number | number[]): Promise<string | undefined> {
    if (Array.isArray(id)) return undefined
    const row = (await this.getDB().getFirstAsync('SELECT txid FROM transactions WHERE transactionId = ?', [
      id
    ])) as { txid?: string } | null
    return row?.txid
  }

  async updateTxLabel(id: number, update: Partial<TableTxLabel>, trx?: TrxToken): Promise<number> {
    const u = this.validatePartialForUpdate(update, undefined, ['isDeleted'])
    return await this.sqlUpdate('tx_labels', id, u as any, 'txLabelId')
  }

  async updateTxLabelMap(
    transactionId: number,
    txLabelId: number,
    update: Partial<TableTxLabelMap>,
    trx?: TrxToken
  ): Promise<number> {
    const u = this.validatePartialForUpdate(update, undefined, ['isDeleted'])
    return await this.sqlUpdateComposite('tx_labels_map', { txLabelId, transactionId }, u as any)
  }

  // ============================================================================
  // FIND methods (StorageReader: 11, StorageReaderWriter: 4 = 15)
  // ============================================================================

  async findUsers(args: FindUsersArgs): Promise<TableUser[]> {
    const rows = await this.sqlFind<any>('users', args, 'userId')
    return this.validateEntities(rows)
  }

  async findCertificateFields(args: FindCertificateFieldsArgs): Promise<TableCertificateField[]> {
    const rows = await this.sqlFind<any>('certificate_fields', args, 'certificateId')
    return this.validateEntities(rows)
  }

  async findCertificates(args: FindCertificatesArgs): Promise<TableCertificateX[]> {
    // Handle extra filters: certifiers, types
    const partial = { ...args.partial } as any
    // Remove certifiers/types from partial - we handle them as extra clauses
    const extraConditions: string[] = []
    const extraParams: any[] = []
    if (args.certifiers && args.certifiers.length > 0) {
      extraConditions.push(`certifier IN (${args.certifiers.map(() => '?').join(',')})`)
      extraParams.push(...args.certifiers)
    }
    if (args.types && args.types.length > 0) {
      extraConditions.push(`type IN (${args.types.map(() => '?').join(',')})`)
      extraParams.push(...args.types)
    }
    const rows = await this.sqlFind<any>(
      'certificates',
      { ...args, partial },
      'certificateId',
      extraConditions.length > 0 ? { conditions: extraConditions, params: extraParams } : undefined
    )
    const results = this.validateEntities(rows, undefined, ['isDeleted'])
    if (args.includeFields) {
      for (const c of results) {
        const fields = await this.findCertificateFields({ partial: { certificateId: c.certificateId }, trx: args.trx })
        ;(c as any).fields = fields
      }
    }
    return results as TableCertificateX[]
  }

  async findCommissions(args: FindCommissionsArgs): Promise<TableCommission[]> {
    if ((args.partial as any).lockingScript) {
      throw new Error('Commissions may not be found by lockingScript value.')
    }
    const rows = await this.sqlFind<any>('commissions', args, 'commissionId')
    return this.validateEntities(rows)
  }

  async findMonitorEvents(args: FindMonitorEventsArgs): Promise<TableMonitorEvent[]> {
    const rows = await this.sqlFind<any>('monitor_events', args, 'id')
    return this.validateEntities(rows)
  }

  async findOutputBaskets(args: FindOutputBasketsArgs): Promise<TableOutputBasket[]> {
    const rows = await this.sqlFind<any>('output_baskets', args, 'basketId')
    return this.validateEntities(rows, undefined, ['isDeleted'])
  }

  /** The txStatus and tag filters shared by every outputs query — one
   * definition so a find, a count and a sum can never drift apart. */
  private outputExtraClauses(
    args: FindOutputsArgs,
    tagIds?: number[],
    isQueryModeAll?: boolean
  ): { conditions: string[]; params: any[] } | undefined {
    const extraConditions: string[] = []
    const extraParams: any[] = []

    // Handle txStatus filter via subquery
    if (args.txStatus && args.txStatus.length > 0) {
      const placeholders = args.txStatus.map(() => '?').join(',')
      extraConditions.push(
        `transactionId IN (SELECT transactionId FROM transactions WHERE status IN (${placeholders}))`
      )
      extraParams.push(...args.txStatus)
    }

    // Handle tagIds filter
    if (tagIds && tagIds.length > 0) {
      const tagPlaceholders = tagIds.map(() => '?').join(',')
      if (isQueryModeAll) {
        // Must have ALL tags
        extraConditions.push(`outputId IN (
          SELECT outputId FROM output_tags_map
          WHERE outputTagId IN (${tagPlaceholders}) AND isDeleted = 0
          GROUP BY outputId HAVING COUNT(DISTINCT outputTagId) = ${tagIds.length}
        )`)
      } else {
        // Must have ANY tag
        extraConditions.push(`outputId IN (
          SELECT outputId FROM output_tags_map
          WHERE outputTagId IN (${tagPlaceholders}) AND isDeleted = 0
        )`)
      }
      extraParams.push(...tagIds)
    }

    return extraConditions.length > 0 ? { conditions: extraConditions, params: extraParams } : undefined
  }

  async findOutputs(args: FindOutputsArgs, tagIds?: number[], isQueryModeAll?: boolean): Promise<TableOutput[]> {
    if ((args.partial as any).lockingScript) {
      throw new Error('Outputs may not be found by lockingScript value.')
    }
    const partial = { ...args.partial } as any

    // `noScript` callers throw the script away the moment it arrives, so do not
    // fetch it at all: an R1-K1 vault output's lockingScript is 959,632 bytes,
    // and `SELECT *` copies every one of them out of SQLite and across the
    // bridge into JS — on the JS thread — only to be discarded below.
    const columns = args.noScript
      ? (await this.tableColumns('outputs')).filter(c => c !== 'lockingScript')
      : undefined

    const rows = await this.sqlFind<any>(
      'outputs',
      { ...args, partial },
      'outputId',
      this.outputExtraClauses(args, tagIds, isQueryModeAll),
      // noScript callers get a projection that never reads the column. The
      // post-hoc `o.lockingScript = undefined` below stays as the contract for
      // any future caller that reaches here without the projection.
      columns
    )

    const results = this.validateEntities(rows, undefined, ['spendable', 'change'])

    for (const o of results) {
      if (!args.noScript) {
        // E3 of the expansion boundary, BEFORE validateOutputScript: that
        // function short-circuits when lockingScript.length equals scriptLength
        // and otherwise re-slices from rawTx, so expanding after it would let a
        // compressed value be silently accepted on createAction-born outputs
        // (vault deposits, change) while breaking internalize-born ones — green
        // on a vault wallet, broken on someone else's.
        o.lockingScript = await expandStoredScript(o.lockingScript)
        await this.validateOutputScript(o, args.trx)
      } else {
        o.lockingScript = undefined
      }
    }
    return results
  }

  /**
   * Count and total the satoshis of the outputs a findOutputs with these same
   * args would return, without materialising a single row.
   *
   * This is the wallet balance: summing it in SQLite rather than pulling every
   * output into JS is the difference between one number crossing the bridge and
   * a few hundred full rows crossing it.
   */
  async sumOutputSatoshis(
    args: FindOutputsArgs,
    tagIds?: number[],
    isQueryModeAll?: boolean
  ): Promise<{ count: number; total: number }> {
    return await this.sqlSum(
      'outputs',
      'satoshis',
      args as any,
      this.outputExtraClauses(args, tagIds, isQueryModeAll)
    )
  }

  async findOutputTags(args: FindOutputTagsArgs): Promise<TableOutputTag[]> {
    const rows = await this.sqlFind<any>('output_tags', args, 'outputTagId')
    return this.validateEntities(rows, undefined, ['isDeleted'])
  }

  async findSyncStates(args: FindSyncStatesArgs): Promise<TableSyncState[]> {
    if ((args.partial as any).syncMap) {
      throw new Error('SyncStates may not be found by syncMap value.')
    }
    const rows = await this.sqlFind<any>('sync_states', args, 'syncStateId')
    return this.validateEntities(rows, ['when'], ['init'])
  }

  async findTransactions(
    args: FindTransactionsArgs,
    labelIds?: number[],
    isQueryModeAll?: boolean
  ): Promise<TableTransaction[]> {
    if ((args.partial as any).rawTx) throw new Error('Transactions may not be found by rawTx value.')
    if ((args.partial as any).inputBEEF) throw new Error('Transactions may not be found by inputBEEF value.')

    const extraConditions: string[] = []
    const extraParams: any[] = []

    // Status filter (array of statuses)
    if (args.status && args.status.length > 0) {
      extraConditions.push(`status IN (${args.status.map(() => '?').join(',')})`)
      extraParams.push(...args.status)
      // Remove status from partial if also in status array
      if ((args.partial as any).status) delete (args.partial as any).status
    }

    // Date range
    if (args.from) {
      extraConditions.push('created_at >= ?')
      extraParams.push(this.validateDateForWhere(args.from))
    }
    if (args.to) {
      extraConditions.push('created_at < ?')
      extraParams.push(this.validateDateForWhere(args.to))
    }

    // Label filtering
    if (labelIds && labelIds.length > 0) {
      const labelPlaceholders = labelIds.map(() => '?').join(',')
      if (isQueryModeAll) {
        extraConditions.push(`transactionId IN (
          SELECT transactionId FROM tx_labels_map
          WHERE txLabelId IN (${labelPlaceholders}) AND isDeleted = 0
          GROUP BY transactionId HAVING COUNT(DISTINCT txLabelId) = ${labelIds.length}
        )`)
      } else {
        extraConditions.push(`transactionId IN (
          SELECT transactionId FROM tx_labels_map
          WHERE txLabelId IN (${labelPlaceholders}) AND isDeleted = 0
        )`)
      }
      extraParams.push(...labelIds)
    }

    const rows = await this.sqlFind<any>(
      'transactions',
      args,
      'transactionId',
      extraConditions.length > 0 ? { conditions: extraConditions, params: extraParams } : undefined,
      args.noRawTx ? columnsExcluding('transactions', ['rawTx', 'inputBEEF']) : undefined
    )

    const results = this.validateEntities(rows, undefined, ['isOutgoing'])

    for (const t of results) {
      if (!args.noRawTx) {
        // E4 of the expansion boundary.
        t.rawTx = await expandStoredTx(t.rawTx)
        t.inputBEEF = await expandStoredTx(t.inputBEEF)
        await this.validateRawTransaction(t, args.trx)
      } else {
        t.rawTx = undefined
        t.inputBEEF = undefined
      }
    }
    return results
  }

  async findTxLabels(args: FindTxLabelsArgs): Promise<TableTxLabel[]> {
    const rows = await this.sqlFind<any>('tx_labels', args, 'txLabelId')
    return this.validateEntities(rows, undefined, ['isDeleted'])
  }

  // StorageReaderWriter find methods
  async findOutputTagMaps(args: FindOutputTagMapsArgs): Promise<TableOutputTagMap[]> {
    const extraConditions: string[] = []
    const extraParams: any[] = []
    if (args.tagIds && args.tagIds.length > 0) {
      extraConditions.push(`outputTagId IN (${args.tagIds.map(() => '?').join(',')})`)
      extraParams.push(...args.tagIds)
    }
    const rows = await this.sqlFind<any>(
      'output_tags_map',
      args,
      'outputTagId',
      extraConditions.length > 0 ? { conditions: extraConditions, params: extraParams } : undefined
    )
    return this.validateEntities(rows, undefined, ['isDeleted'])
  }

  async findProvenTxReqs(args: FindProvenTxReqsArgs): Promise<TableProvenTxReq[]> {
    if ((args.partial as any).rawTx) throw new Error('ProvenTxReqs may not be found by rawTx value.')
    if ((args.partial as any).inputBEEF) throw new Error('ProvenTxReqs may not be found by inputBEEF value.')
    const extraConditions: string[] = []
    const extraParams: any[] = []
    if (args.status && args.status.length > 0) {
      extraConditions.push(`status IN (${args.status.map(() => '?').join(',')})`)
      extraParams.push(...args.status)
      if ((args.partial as any).status) delete (args.partial as any).status
    }
    if (args.txids && args.txids.length > 0) {
      extraConditions.push(`txid IN (${args.txids.map(() => '?').join(',')})`)
      extraParams.push(...args.txids)
    }
    const rows = await this.sqlFind<any>(
      'proven_tx_reqs',
      args,
      'provenTxReqId',
      extraConditions.length > 0 ? { conditions: extraConditions, params: extraParams } : undefined
    )
    const reqs = this.validateEntities(rows, undefined, ['notified', 'wasBroadcast'])
    // E5 of the expansion boundary. proven_tx_reqs is where the monitor's txid
    // tripwire reads from (TaskCheckForProofs re-hashes rawTx and flips the row
    // to status='invalid' on a mismatch — irreversible, and it cascades to every
    // notified transaction), and it is also the row mergeReqToBeefToShareExternally
    // turns into a broadcast payload.
    for (const req of reqs) {
      req.rawTx = await expandStoredTx(req.rawTx)
      req.inputBEEF = await expandStoredTx(req.inputBEEF)
    }
    return reqs
  }

  async findProvenTxs(args: FindProvenTxsArgs): Promise<TableProvenTx[]> {
    if ((args.partial as any).rawTx) throw new Error('ProvenTxs may not be found by rawTx value.')
    if ((args.partial as any).merklePath) throw new Error('ProvenTxs may not be found by merklePath value.')
    const rows = await this.sqlFind<any>('proven_txs', args, 'provenTxId')
    const proven = this.validateEntities(rows)
    // E6 of the expansion boundary. proven_txs.rawTx is the merkle evidence:
    // Beef.verifyBumpIndexLeaves requires hash256(rawTx) to equal a chain-committed
    // BUMP leaf, and that check lives in @bsv/sdk where no subclass can intercept
    // it — so anything leaving here must already be real bytes.
    for (const p of proven) {
      p.rawTx = await expandStoredTx(p.rawTx)
      assertExpanded(p.rawTx, `proven_txs.rawTx for ${p.txid}`)
    }
    return proven
  }

  async findTxLabelMaps(args: FindTxLabelMapsArgs): Promise<TableTxLabelMap[]> {
    const extraConditions: string[] = []
    const extraParams: any[] = []
    if (args.labelIds && args.labelIds.length > 0) {
      extraConditions.push(`txLabelId IN (${args.labelIds.map(() => '?').join(',')})`)
      extraParams.push(...args.labelIds)
    }
    const rows = await this.sqlFind<any>(
      'tx_labels_map',
      args,
      'txLabelId',
      extraConditions.length > 0 ? { conditions: extraConditions, params: extraParams } : undefined
    )
    return this.validateEntities(rows, undefined, ['isDeleted'])
  }

  // ============================================================================
  // COUNT methods (StorageReader: 11, StorageReaderWriter: 4 = 15)
  // ============================================================================

  async countUsers(args: FindUsersArgs): Promise<number> {
    return this.sqlCount('users', args)
  }
  async countCertificateFields(args: FindCertificateFieldsArgs): Promise<number> {
    return this.sqlCount('certificate_fields', args)
  }

  async countCertificates(args: FindCertificatesArgs): Promise<number> {
    const extraConditions: string[] = []
    const extraParams: any[] = []
    if (args.certifiers && args.certifiers.length > 0) {
      extraConditions.push(`certifier IN (${args.certifiers.map(() => '?').join(',')})`)
      extraParams.push(...args.certifiers)
    }
    if (args.types && args.types.length > 0) {
      extraConditions.push(`type IN (${args.types.map(() => '?').join(',')})`)
      extraParams.push(...args.types)
    }
    return this.sqlCount(
      'certificates',
      args,
      extraConditions.length > 0 ? { conditions: extraConditions, params: extraParams } : undefined
    )
  }

  async countCommissions(args: FindCommissionsArgs): Promise<number> {
    return this.sqlCount('commissions', args)
  }
  async countMonitorEvents(args: FindMonitorEventsArgs): Promise<number> {
    return this.sqlCount('monitor_events', args)
  }
  async countOutputBaskets(args: FindOutputBasketsArgs): Promise<number> {
    return this.sqlCount('output_baskets', args)
  }

  async countOutputs(args: FindOutputsArgs, tagIds?: number[], isQueryModeAll?: boolean): Promise<number> {
    return this.sqlCount('outputs', args, this.outputExtraClauses(args, tagIds, isQueryModeAll))
  }

  async countOutputTags(args: FindOutputTagsArgs): Promise<number> {
    return this.sqlCount('output_tags', args)
  }
  async countSyncStates(args: FindSyncStatesArgs): Promise<number> {
    return this.sqlCount('sync_states', args)
  }

  async countTransactions(args: FindTransactionsArgs, labelIds?: number[], isQueryModeAll?: boolean): Promise<number> {
    const extraConditions: string[] = []
    const extraParams: any[] = []
    if (args.status && args.status.length > 0) {
      extraConditions.push(`status IN (${args.status.map(() => '?').join(',')})`)
      extraParams.push(...args.status)
      if ((args.partial as any).status) delete (args.partial as any).status
    }
    if (args.from) {
      extraConditions.push('created_at >= ?')
      extraParams.push(this.validateDateForWhere(args.from))
    }
    if (args.to) {
      extraConditions.push('created_at < ?')
      extraParams.push(this.validateDateForWhere(args.to))
    }
    if (labelIds && labelIds.length > 0) {
      const labelPlaceholders = labelIds.map(() => '?').join(',')
      if (isQueryModeAll) {
        extraConditions.push(`transactionId IN (
          SELECT transactionId FROM tx_labels_map WHERE txLabelId IN (${labelPlaceholders}) AND isDeleted = 0
          GROUP BY transactionId HAVING COUNT(DISTINCT txLabelId) = ${labelIds.length}
        )`)
      } else {
        extraConditions.push(`transactionId IN (
          SELECT transactionId FROM tx_labels_map WHERE txLabelId IN (${labelPlaceholders}) AND isDeleted = 0
        )`)
      }
      extraParams.push(...labelIds)
    }
    return this.sqlCount(
      'transactions',
      args,
      extraConditions.length > 0 ? { conditions: extraConditions, params: extraParams } : undefined
    )
  }

  async countTxLabels(args: FindTxLabelsArgs): Promise<number> {
    return this.sqlCount('tx_labels', args)
  }

  // StorageReaderWriter count methods
  async countOutputTagMaps(args: FindOutputTagMapsArgs): Promise<number> {
    const extraConditions: string[] = []
    const extraParams: any[] = []
    if (args.tagIds && args.tagIds.length > 0) {
      extraConditions.push(`outputTagId IN (${args.tagIds.map(() => '?').join(',')})`)
      extraParams.push(...args.tagIds)
    }
    return this.sqlCount(
      'output_tags_map',
      args,
      extraConditions.length > 0 ? { conditions: extraConditions, params: extraParams } : undefined
    )
  }

  async countProvenTxReqs(args: FindProvenTxReqsArgs): Promise<number> {
    const extraConditions: string[] = []
    const extraParams: any[] = []
    if (args.status && args.status.length > 0) {
      extraConditions.push(`status IN (${args.status.map(() => '?').join(',')})`)
      extraParams.push(...args.status)
    }
    if (args.txids && args.txids.length > 0) {
      extraConditions.push(`txid IN (${args.txids.map(() => '?').join(',')})`)
      extraParams.push(...args.txids)
    }
    return this.sqlCount(
      'proven_tx_reqs',
      args,
      extraConditions.length > 0 ? { conditions: extraConditions, params: extraParams } : undefined
    )
  }

  async countProvenTxs(args: FindProvenTxsArgs): Promise<number> {
    return this.sqlCount('proven_txs', args)
  }

  async countTxLabelMaps(args: FindTxLabelMapsArgs): Promise<number> {
    const extraConditions: string[] = []
    const extraParams: any[] = []
    if (args.labelIds && args.labelIds.length > 0) {
      extraConditions.push(`txLabelId IN (${args.labelIds.map(() => '?').join(',')})`)
      extraParams.push(...args.labelIds)
    }
    return this.sqlCount(
      'tx_labels_map',
      args,
      extraConditions.length > 0 ? { conditions: extraConditions, params: extraParams } : undefined
    )
  }

  // ============================================================================
  // getForUser methods (4)
  // ============================================================================

  /**
   * DELIBERATELY OUTSIDE the expansion boundary — do not add an expansion hook.
   *
   * This and getProvenTxReqsForUser below are what getSyncChunk reads, and a
   * sync chunk is the ONE consumer that wants bytes in their stored form: the
   * whole point of compressing at rest is that a vault record fits inside the
   * backup server's 1 MiB blob cap. Expanding here would put ~960 KB back into
   * every chunk carrying a vault transaction and reinstate exactly the wedge
   * this work exists to clear.
   *
   * Both issue their own SQL and so bypass the find* hooks anyway, which is what
   * makes the exception expressible at all — but it is an exception, and the
   * restore side has to know: processSyncChunk feeds these bytes back through
   * insertProvenTxReq/insertOutput, where the compress-on-write hooks must be
   * idempotent (isEnvelope/isCompressed guards) rather than double-wrapping.
   */
  async getProvenTxsForUser(args: FindForUserSincePagedArgs): Promise<TableProvenTx[]> {
    const db = this.getDB()
    let query = `SELECT pt.* FROM proven_txs pt
      WHERE EXISTS (SELECT 1 FROM transactions t WHERE t.provenTxId = pt.provenTxId AND t.userId = ?)`
    const params: any[] = [args.userId]
    if (args.since) {
      query += ' AND pt.updated_at >= ?'
      params.push(this.validateDateForWhere(args.since))
    }
    query += ' ORDER BY pt.provenTxId ASC'
    if (args.paged?.limit) {
      query += ` LIMIT ${args.paged.limit}`
      if (args.paged.offset) query += ` OFFSET ${args.paged.offset}`
    }
    const rows = (await db.getAllAsync(query, params)) as any[]
    return this.validateEntities(rows)
  }

  async getProvenTxReqsForUser(args: FindForUserSincePagedArgs): Promise<TableProvenTxReq[]> {
    const db = this.getDB()
    let query = `SELECT ptr.* FROM proven_tx_reqs ptr
      WHERE EXISTS (SELECT 1 FROM transactions t WHERE t.txid = ptr.txid AND t.userId = ?)`
    const params: any[] = [args.userId]
    if (args.since) {
      query += ' AND ptr.updated_at >= ?'
      params.push(this.validateDateForWhere(args.since))
    }
    query += ' ORDER BY ptr.provenTxReqId ASC'
    if (args.paged?.limit) {
      query += ` LIMIT ${args.paged.limit}`
      if (args.paged.offset) query += ` OFFSET ${args.paged.offset}`
    }
    const rows = (await db.getAllAsync(query, params)) as any[]
    return this.validateEntities(rows, undefined, ['notified', 'wasBroadcast'])
  }

  async getTxLabelMapsForUser(args: FindForUserSincePagedArgs): Promise<TableTxLabelMap[]> {
    const db = this.getDB()
    let query = `SELECT tlm.* FROM tx_labels_map tlm
      WHERE EXISTS (SELECT 1 FROM tx_labels tl WHERE tl.txLabelId = tlm.txLabelId AND tl.userId = ?)`
    const params: any[] = [args.userId]
    if (args.since) {
      query += ' AND tlm.updated_at >= ?'
      params.push(this.validateDateForWhere(args.since))
    }
    query += ' ORDER BY tlm.txLabelId ASC'
    if (args.paged?.limit) {
      query += ` LIMIT ${args.paged.limit}`
      if (args.paged.offset) query += ` OFFSET ${args.paged.offset}`
    }
    const rows = (await db.getAllAsync(query, params)) as any[]
    return this.validateEntities(rows, undefined, ['isDeleted'])
  }

  async getOutputTagMapsForUser(args: FindForUserSincePagedArgs): Promise<TableOutputTagMap[]> {
    const db = this.getDB()
    let query = `SELECT otm.* FROM output_tags_map otm
      WHERE EXISTS (SELECT 1 FROM output_tags ot WHERE ot.outputTagId = otm.outputTagId AND ot.userId = ?)`
    const params: any[] = [args.userId]
    if (args.since) {
      query += ' AND otm.updated_at >= ?'
      params.push(this.validateDateForWhere(args.since))
    }
    query += ' ORDER BY otm.outputTagId ASC'
    if (args.paged?.limit) {
      query += ` LIMIT ${args.paged.limit}`
      if (args.paged.offset) query += ` OFFSET ${args.paged.offset}`
    }
    const rows = (await db.getAllAsync(query, params)) as any[]
    return this.validateEntities(rows, undefined, ['isDeleted'])
  }

  // ============================================================================
  // StorageProvider abstract methods
  // ============================================================================

  // Auth delegations
  async findCertificatesAuth(auth: AuthId, args: FindCertificatesArgs): Promise<TableCertificateX[]> {
    if (!auth.userId || (args.partial.userId && args.partial.userId !== auth.userId))
      throw new Error('WERR_UNAUTHORIZED')
    args.partial.userId = auth.userId
    return await this.findCertificates(args)
  }

  async findOutputBasketsAuth(auth: AuthId, args: FindOutputBasketsArgs): Promise<TableOutputBasket[]> {
    if (!auth.userId || (args.partial.userId && args.partial.userId !== auth.userId))
      throw new Error('WERR_UNAUTHORIZED')
    args.partial.userId = auth.userId
    return await this.findOutputBaskets(args)
  }

  async findOutputsAuth(auth: AuthId, args: FindOutputsArgs): Promise<TableOutput[]> {
    if (!auth.userId || (args.partial.userId && args.partial.userId !== auth.userId))
      throw new Error('WERR_UNAUTHORIZED')
    args.partial.userId = auth.userId
    return await this.findOutputs(args)
  }

  async insertCertificateAuth(auth: AuthId, certificate: TableCertificateX): Promise<number> {
    if (!auth.userId || (certificate.userId && certificate.userId !== auth.userId)) throw new Error('WERR_UNAUTHORIZED')
    certificate.userId = auth.userId
    return await this.insertCertificate(certificate)
  }

  /**
   * E7 of the expansion boundary: the one place stored bytes become a network
   * payload.
   *
   * `attemptToPostReqsToNetwork` builds its beef exclusively through here, and
   * every broadcaster — ARC, Arcade, WhatsOnChain, Bitails — reads out of that
   * beef, so this is the convergence point for the wire. Reqs loaded through
   * findProvenTxReqs are already expanded by E5, which makes this a belt rather
   * than the mechanism; it exists because a caller can hand over a req obtained
   * some other way (getProvenTxReqsForUser deliberately returns stored form),
   * and posting a compressed payload is not a recoverable mistake: ARC rejects
   * it, the req goes `invalid`, `reviewStatus` is a stub so it never becomes
   * `failed`, and `releaseStuckReservations` only frees outputs whose spender is
   * `failed` — so vault UTXOs stay reserved against a dead txid with nothing
   * surfaced.
   */
  async mergeReqToBeefToShareExternally(
    req: TableProvenTxReq,
    mergeToBeef: Beef,
    knownTxids: string[],
    trx?: TrxToken
  ): Promise<void> {
    const expanded: TableProvenTxReq = {
      ...req,
      rawTx: await expandStoredTx(req.rawTx),
      inputBEEF: await expandStoredTx(req.inputBEEF)
    }
    assertExpanded(expanded.rawTx, `broadcast rawTx for ${req.txid}`)
    assertExpanded(expanded.inputBEEF, `broadcast inputBEEF for ${req.txid}`)
    return await super.mergeReqToBeefToShareExternally(expanded, mergeToBeef, knownTxids, trx)
  }

  // Data retrieval
  /**
   * E1 of the expansion boundary (see storage/methods/expandStored.ts).
   *
   * Every identity-deriving and BEEF-assembling consumer in the toolbox reaches
   * bytes through here, including three that bypass the find* hooks entirely, so
   * this is the load-bearing one: a compressed value escaping here becomes a
   * WRONG TXID rather than an error.
   */
  async getProvenOrRawTx(txid: string, trx?: TrxToken): Promise<ProvenOrRawTx> {
    const r: ProvenOrRawTx = { proven: undefined, rawTx: undefined, inputBEEF: undefined }
    const provenResults = await this.findProvenTxs({ partial: { txid }, trx })
    r.proven = provenResults.length === 1 ? provenResults[0] : undefined
    if (!r.proven) {
      const reqResults = await this.findProvenTxReqs({ partial: { txid }, trx })
      const req: any = reqResults.length === 1 ? reqResults[0] : undefined
      if (req && ['unsent', 'unmined', 'unconfirmed', 'sending', 'nosend', 'completed'].includes(req.status)) {
        r.rawTx = req.rawTx
        r.inputBEEF = req.inputBEEF
      }
    }
    // findProvenTxs/findProvenTxReqs already expand (E4/E5), so these are
    // normally no-ops. Kept unconditional because this method is what the
    // bypassing consumers call, and an assertion is cheaper than reasoning about
    // which of them arrived by which route.
    r.rawTx = await expandStoredTx(r.rawTx)
    r.inputBEEF = await expandStoredTx(r.inputBEEF)
    if (r.proven) r.proven.rawTx = (await expandStoredTx(r.proven.rawTx)) as number[]
    assertExpanded(r.rawTx, `proven_tx_reqs.rawTx for ${txid}`)
    assertExpanded(r.proven?.rawTx, `proven_txs.rawTx for ${txid}`)
    return r
  }

  /**
   * txid -> height for every proven transaction.
   *
   * The CSV export used findProvenTxs({ partial: {} }) for this: an unbounded
   * SELECT * that reads and Array.from-expands every rawTx and merklePath in the
   * wallet to build a map of two small columns. On a wallet with vault history
   * that is hundreds of megabytes of transient heap.
   */
  /**
   * The transactions reserving the given outpoints, by `reference`.
   *
   * Answers in one indexed query (outputs.spentBy is indexed) what the vault's
   * reservation heal previously answered by paging up to 5,000 actions with
   * includeInputs — where listActionsSql loads each action's full rawTx and runs
   * Transaction.fromBinary on it just to read a sequence number.
   *
   * `reference`, not `txid`: the reservation being healed belongs to an attempt
   * that died before signing, so it has no txid. abortAction takes a reference.
   */
  async findSpendingReferences(outpoints: string[]): Promise<{ reference: string; status: string }[]> {
    if (outpoints.length === 0) return []
    if (!this.isAvailable()) await this.makeAvailable()
    const pairs = outpoints.map(splitOutpoint).filter((p): p is { txid: string; vout: number } => p !== null)
    if (pairs.length === 0) return []
    const params = pairs.flatMap(p => [p.txid, p.vout])
    const rows = (await this.getDB().getAllAsync(spendingReferencesSql(pairs.length), params)) as {
      reference?: string
      status?: string
    }[]
    return rows
      .filter(r => typeof r.reference === 'string' && typeof r.status === 'string')
      .map(r => ({ reference: r.reference as string, status: r.status as string }))
  }

  /** Size of the database file on disk, or null when it cannot be read. */
  async databaseFileBytes(): Promise<number | null> {
    try {
      const path = (this.db as unknown as { databasePath?: string })?.databasePath
      if (!path) return null
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { File } = require('expo-file-system') as typeof import('expo-file-system')
      const size = new File(path).size
      // Deliberately NOT gated on .exists: the Android exists getter is
      // permission-gated while size is not. A zero is treated as unknown rather
      // than as an empty database.
      return typeof size === 'number' && size > 0 ? size : null
    } catch {
      return null
    }
  }

  /**
   * What could be reclaimed, and what is being held back.
   *
   * Read-only by design: this ships before anything destructive so the decision
   * can be made from real device numbers. See storage/methods/reclaim.ts for why
   * row deletion is not on offer at all.
   */
  async reclaimReport(tipHeight: number, cutoff: string): Promise<ReclaimReport> {
    if (!this.isAvailable()) await this.makeAvailable()
    const db = this.getDB()

    const perTable = (await db.getAllAsync(RECLAIM_SIZES_SQL)) as {
      table: string
      rows: number
      blobBytes: number
    }[]
    const candidates = (await db.getAllAsync(RECLAIM_CANDIDATES_SQL, [tipHeight, cutoff])) as { bytes: number }[]
    const excluded = (await db.getAllAsync(RECLAIM_EXCLUDED_SQL, [tipHeight, tipHeight, cutoff])) as {
      reason: string
      rows: number
      bytes: number
    }[]

    return {
      dbBytes: await this.databaseFileBytes(),
      freeBytes: availableDiskBytes(),
      perTable,
      reclaimable: {
        rows: candidates.length,
        bytes: candidates.reduce((sum, c) => sum + (c.bytes ?? 0), 0)
      },
      excluded
    }
  }

  /**
   * Null transactions.inputBEEF for settled transactions.
   *
   * The one destructive operation here, and the only blob whose clearing is both
   * safe and effective — nothing reads this column for BEEF. Raw SQL because
   * updateTransaction cannot write NULL: sqlUpdate skips undefined values, so an
   * update meaning "clear this" is silently dropped.
   *
   * Not wired to the low-disk trigger: on a nearly full volume this UPDATE's own
   * rollback journal can fail with SQLITE_FULL, and with no WAL and no
   * auto_vacuum the file does not shrink afterwards.
   */
  async reclaimInputBeef(tipHeight: number, cutoff: string): Promise<{ rows: number }> {
    if (!this.isAvailable()) await this.makeAvailable()
    const result = await this.getDB().runAsync(RECLAIM_INPUT_BEEF_SQL, [
      new Date().toISOString(),
      tipHeight,
      cutoff
    ])
    return { rows: result.changes ?? 0 }
  }

  async getProvenTxHeights(): Promise<Map<string, number>> {
    if (!this.isAvailable()) await this.makeAvailable()
    const rows = (await this.getDB().getAllAsync(PROVEN_HEIGHTS_SQL)) as { txid?: string; height?: number }[]
    const map = new Map<string, number>()
    for (const r of rows) {
      if (r.txid && typeof r.height === 'number') map.set(r.txid, r.height)
    }
    return map
  }

  async getRawTxOfKnownValidTransaction(
    txid?: string,
    offset?: number,
    length?: number,
    trx?: TrxToken
  ): Promise<number[] | undefined> {
    if (!txid) return undefined
    if (!this.isAvailable()) await this.makeAvailable()

    // Range reads are served in SQL. The caller here is almost always
    // validateOutputScript re-slicing one output's locking script out of its
    // source transaction, and with maxOutputScript = 1024 the outputs that take
    // that path are exactly the ~960 KB vault scripts. Loading the whole rawTx
    // to slice it meant reading ~960 KB off disk and Array.from-ing it into an
    // ~960 K-element JS array to keep a few hundred bytes.
    //
    // Table order and the status filter mirror getProvenOrRawTx exactly (see
    // rangeReadSql), so a range read can never see a row the full read refuses.
    if (offset !== undefined && length !== undefined && Number.isInteger(offset) && Number.isInteger(length)) {
      const db = this.getDB()
      // substr is 1-indexed over bytes; a JS offset of n starts at n + 1.
      const args = [offset + 1, length, txid]
      type RangeRow = { marker?: Uint8Array; chunk?: Uint8Array } | null
      let table: 'proven_txs' | 'proven_tx_reqs' = 'proven_txs'
      let row = (await db.getFirstAsync(rangeReadSql('proven_txs'), args)) as RangeRow
      if (!row) {
        table = 'proven_tx_reqs'
        row = (await db.getFirstAsync(rangeReadSql('proven_tx_reqs'), args)) as RangeRow
      }
      if (!row?.chunk) return undefined

      // E2 of the expansion boundary. Slicing a stored envelope is the silent
      // fund-eviction path (see storage/methods/expandStored.ts), so a marked row
      // is re-read whole and the range served from its span list.
      if (row.marker?.[0] === 0xfe) {
        const full = (await db.getFirstAsync(fullReadSql(table), [txid])) as { rawTx?: Uint8Array } | null
        if (!full?.rawTx) return undefined
        const range = await expandStoredRange(Array.from(full.rawTx), offset, length)
        assertExpanded(range, `range of rawTx for ${txid}`)
        return range
      }
      return Array.from(row.chunk)
    }

    const r = await this.getProvenOrRawTx(txid, trx)
    return r.proven ? r.proven.rawTx : r.rawTx
  }

  async getLabelsForTransactionId(transactionId?: number, trx?: TrxToken): Promise<TableTxLabel[]> {
    if (!transactionId) return []
    const maps = await this.findTxLabelMaps({ partial: { transactionId, isDeleted: false } as any, trx })
    const labels: any[] = []
    for (const m of maps) {
      const results = await this.findTxLabels({ partial: { txLabelId: m.txLabelId, isDeleted: false } as any, trx })
      if (results.length > 0) labels.push(results[0])
    }
    return labels
  }

  async getTagsForOutputId(outputId: number, trx?: TrxToken): Promise<TableOutputTag[]> {
    const maps = await this.findOutputTagMaps({ partial: { outputId, isDeleted: false } as any, trx })
    const tags: any[] = []
    for (const m of maps) {
      const results = await this.findOutputTags({
        partial: { outputTagId: m.outputTagId, isDeleted: false } as any,
        trx
      })
      if (results.length > 0) tags.push(results[0])
    }
    return tags
  }

  // Change input allocation
  async allocateChangeInput(
    userId: number,
    basketId: number,
    targetSatoshis: number,
    exactSatoshis: number | undefined,
    excludeSending: boolean,
    transactionId: number
  ): Promise<TableOutput | undefined> {
    const txStatus: string[] = ['completed', 'unproven']
    if (!excludeSending) txStatus.push('sending')
    const outputs = await this.findOutputs({
      partial: { userId, basketId, spendable: true as any },
      txStatus: txStatus as any
    })
    devLog(
      `[StorageExpoSQLite] allocateChangeInput: userId=${userId} basketId=${basketId} target=${targetSatoshis} found ${outputs.length} spendable outputs, satoshis: [${outputs.map(o => o.satoshis).join(',')}]`
    )
    let output: TableOutput | undefined
    let scores: { output: TableOutput; score: number }[] = []
    for (const o of outputs) {
      if (exactSatoshis && o.satoshis === exactSatoshis) {
        output = o
        break
      }
      scores.push({ output: o, score: o.satoshis - targetSatoshis })
    }
    if (!output) {
      scores = scores.sort((a, b) => a.score - b.score)
      const found = scores.find(s => s.score >= 0)
      if (found) {
        output = found.output
      } else if (scores.length > 0) {
        output = scores[scores.length - 1].output
      }
    }
    if (output) {
      await this.updateOutput(output.outputId, { spendable: false, spentBy: transactionId } as any)
    }
    return output
  }

  async countChangeInputs(userId: number, basketId: number, excludeSending: boolean): Promise<number> {
    const txStatus: string[] = ['completed', 'unproven']
    if (!excludeSending) txStatus.push('sending')
    return await this.countOutputs({
      partial: { userId, basketId, spendable: true as any },
      txStatus: txStatus as any
    })
  }

  // listActions and listOutputs — delegate to SQL-native implementations
  async listActions(auth: AuthId, vargs: Validation.ValidListActionsArgs): Promise<ListActionsResult> {
    if (!auth.userId) throw new Error('WERR_UNAUTHORIZED')
    return await listActionsSql(this, auth, vargs)
  }

  async listOutputs(auth: AuthId, vargs: Validation.ValidListOutputsArgs): Promise<ListOutputsResult> {
    if (!auth.userId) throw new Error('WERR_UNAUTHORIZED')
    return await listOutputsSql(this, auth, vargs)
  }

  // Stubs
  async reviewStatus(_args: { agedLimit: Date; trx?: TrxToken }): Promise<{ log: string }> {
    return { log: '' }
  }

  async purgeData(_params: PurgeParams, _trx?: TrxToken): Promise<PurgeResults> {
    return { count: 0, log: '' }
  }

  async adminStats(_adminIdentityKey: string): Promise<AdminStatsResult> {
    throw new Error('Method intentionally not implemented for personal storage.')
  }

  /**
   * The raw database, for the offline-actions modules only. `db` above is
   * already public (no access modifier) — this isn't a narrower type, just a
   * named, deliberate access point for that use so call sites read as
   * intentional rather than reaching into an implementation-shaped field.
   */
  get sqliteDb(): SQLiteDatabase | undefined {
    return this.db
  }

  // Override internalizeAction for debugging
  async internalizeAction(auth: AuthId, args: any): Promise<any> {
    devLog('[StorageExpoSQLite] internalizeAction called, userId:', auth.userId)
    try {
      const result = await super.internalizeAction(auth, args)
      devLog(
        '[StorageExpoSQLite] internalizeAction result:',
        JSON.stringify({
          accepted: result.accepted,
          isMerge: result.isMerge,
          txid: result.txid,
          satoshis: result.satoshis,
          hasSendWithResults: !!result.sendWithResults,
          hasNotDelayedResults: !!result.notDelayedResults
        })
      )
      return result
    } catch (e: any) {
      console.error('[StorageExpoSQLite] internalizeAction ERROR:', e.message, e.stack?.slice(0, 500))
      throw e
    }
  }

  /**
   * Park requests for later delivery instead of broadcasting them now.
   *
   * Each request goes to 'nosend': held, ignored by every monitor task
   * (`TaskSendWaiting` selects 'unsent'/'sending', `TaskCheckNoSends` is barred
   * from counting attempts against nosend rows, `TaskFailAbandoned` sweeps
   * *transactions* in 'unprocessed'/'unsigned'), yet still releasable later via
   * `options.sendWith` because `readyToSendStatuses` includes it
   * (`storage/storageProviderHelpers.js:14`). A row in `offline_actions` then
   * records that it still needs sending.
   *
   * The transaction row is deliberately left untouched, which makes its current
   * status a **precondition** rather than an afterthought: callers must only
   * pass requests whose transaction is already in `holdSafeTxStatuses`. For the
   * internalize path that is 'unproven'
   * (`storage/methods/internalizeAction.js:352`), the status that keeps the
   * received outputs spendable while the broadcast waits — the whole point of
   * holding rather than failing. See `utils/offline/hold.ts` for what the other
   * statuses would cost.
   *
   * Both writes are idempotent (a repeat 'nosend' is a no-op, and the queue
   * insert is `INSERT OR IGNORE` on a UNIQUE txid, so it neither duplicates a
   * row nor disturbs an existing `seq`), so a partial failure is safe to retry.
   *
   * Public and upstream-shaped: this is the method that becomes
   * `StorageProvider.holdReqsOffline` in wallet-toolbox.
   */
  async holdReqsOffline(reqs: { txid: string }[], userId: number, role: OfflineActionRole = 'received'): Promise<void> {
    const db = this.getDB()
    for (const req of reqs) {
      const row = (await this.findProvenTxReqs({ partial: { txid: req.txid } }))[0]
      if (row) await this.updateProvenTxReq(row.provenTxReqId, { status: 'nosend' })
      await insertOfflineAction(db, { userId, txid: req.txid, role })
    }
    TaskSendOffline.noteEnqueued()
  }

  /**
   * Offline, hold the requests. Online, behave exactly as before.
   *
   * This override is reached only from `shareReqsWithWorld`
   * (`storage/methods/processAction.js:146`, a method call on storage), which
   * covers the forced broadcast inside `internalizeAction` and the non-delayed
   * create/`sendWith` path. `TaskSendWaiting` invokes the module function
   * directly (`monitor/tasks/TaskSendWaiting.js:180`), so the monitor's
   * ordinary broadcast retries are deliberately NOT intercepted.
   *
   * Narrower than "offline means hold": only requests whose transaction is
   * already in a hold-safe status are parked, so in practice this holds the
   * internalize path the feature needs and leaves the non-delayed `createAction`
   * path with the `serviceError` and automatic `TaskSendWaiting` retry it has
   * today. `groupOfflineHolds` makes that call; see `utils/offline/hold.ts`.
   *
   * The returned 'success' means "accepted for delivery", not "the network has
   * it"; see `utils/offline/hold.ts` for why nothing persisted claims otherwise.
   */
  async attemptToPostReqsToNetwork(
    reqs: EntityProvenTxReq[],
    trx?: TrxToken,
    logger?: WalletLoggerInterface
  ): Promise<PostReqsToNetworkResult> {
    if (reqs.length === 0) return await super.attemptToPostReqsToNetwork(reqs, trx, logger)

    let online = true
    try {
      online = await getOnline()
    } catch (e) {
      // A failed connectivity probe must never change posting behaviour: assume
      // online so the real post runs exactly as it did before this override.
      devLog('[StorageExpoSQLite] connectivity probe failed, assuming online:', e)
    }
    if (online) return await super.attemptToPostReqsToNetwork(reqs, trx, logger)

    const pairs = await this.resolveHoldPairs(reqs)
    const holds = groupOfflineHolds(pairs)
    if (!holds) {
      // Either a request could not be attributed to a user, so we could not
      // record that it still needs sending, or its transaction is not in a
      // status that survives being held (see `holdSafeTxStatuses`). Refuse the
      // whole call and let the ordinary broadcast run: offline its failure takes
      // the pre-existing paths, either `internalizeAction`'s rollback or a
      // `serviceError` that leaves the request for `TaskSendWaiting` to retry.
      devLog(
        '[StorageExpoSQLite] offline: not holding, delegating to the real post:',
        pairs.map(p => `${p.req.txid} ${p.tx ? `tx ${p.tx.status}` : 'unattributed'}`).join(', ')
      )
      return await super.attemptToPostReqsToNetwork(reqs, trx, logger)
    }

    devLog(`[StorageExpoSQLite] offline: holding ${reqs.length} req(s) for later delivery`)
    for (const hold of holds.values()) {
      await this.holdReqsOffline(hold.reqs, hold.userId, hold.role)
    }
    return { ...buildOfflineHoldResult(reqs), beef: new Beef(), log: '' }
  }

  /**
   * Pair each request with the transaction row it notifies
   * (`EntityProvenTxReq.addNotifyTransactionId`, populated by
   * `storage/methods/internalizeAction.js:523` and
   * `storage/methods/processAction.js:241`).
   *
   * Database reads only: every rule applied to these pairs lives in
   * `groupOfflineHolds`, which is pure and unit-tested. Read-only on purpose, so
   * the whole set is resolved before any write and a refusal can never leave a
   * request half-held.
   */
  private async resolveHoldPairs(
    reqs: EntityProvenTxReq[]
  ): Promise<{ req: EntityProvenTxReq; tx: TableTransaction | undefined }[]> {
    const pairs: { req: EntityProvenTxReq; tx: TableTransaction | undefined }[] = []
    for (const req of reqs) {
      let tx: TableTransaction | undefined
      for (const transactionId of req.notify?.transactionIds ?? []) {
        tx = (await this.findTransactions({ partial: { transactionId }, noRawTx: true }))[0]
        if (tx) break
      }
      pairs.push({ req, tx })
    }
    return pairs
  }

  /**
   * Keep sync chunks in stored form.
   *
   * getSyncChunk reads outputs through findOutputs WITHOUT noScript, so two
   * things happen that make a chunk enormous: E3 expands any compressed script,
   * and validateOutputScript re-slices the full ~960 KB script out of rawTx for
   * vault outputs whose column is NULL (maxOutputScript is 1024, so it is always
   * NULL for them). The result is that a chunk carrying one vault output exceeds
   * the backup server's 1 MiB blob cap even though the database itself stores
   * almost nothing for it.
   *
   * So the chunk is re-compressed on the way out. This is the deliberate
   * exception to the expansion boundary — the one consumer that wants stored
   * form — and it is safe because the receiving side is symmetric:
   * processSyncChunk writes through the insert hooks, which are idempotent, and
   * every read path expands.
   *
   * IF PEER SYNC IS EVER ENABLED (storageUrl is 'local' today, so the only
   * consumer is our own encrypted backup), this needs a capability flag first:
   * the toolbox's portable layer base64s byte columns verbatim and neither
   * getSyncChunk nor processSyncChunk inspects them, so envelopes would replicate
   * to a peer with no signal, and byte-for-byte entity diffs would make a mixed
   * fleet see every record as changed and re-push forever.
   */
  async getSyncChunk(args: RequestSyncChunkArgs): Promise<SyncChunk> {
    const chunk = await super.getSyncChunk(args)

    for (const o of chunk.outputs ?? []) {
      if (o.lockingScript && !isCompressed(o.lockingScript)) {
        const compressed = await compressScriptBytes(Uint8Array.from(o.lockingScript))
        if (compressed.length < o.lockingScript.length) o.lockingScript = Array.from(compressed)
      }
    }
    for (const req of chunk.provenTxReqs ?? []) {
      req.rawTx = await compressStoredTx(req.rawTx, req.txid)
      req.inputBEEF = await compressStoredBeef(req.inputBEEF)
      // Rows written before the write-time scrub landed (2026-08-19) can carry
      // the full EF/rawTx HEX in provider error notes — the same forbidden
      // R1-K1 bytes at twice the size, as text. getProvenTxReqsForUser is a
      // SELECT *, so without this a single pre-scrub row re-wedges the backup
      // right after the rawTx compression clears it.
      req.history = scrubHistoryJson(req.history) as typeof req.history
    }
    // proven_txs is the row that actually wedged the first mainnet vault wallet:
    // its rawTx is the full mined transaction (~960 KB for a deposit), it is read
    // for the chunk via getProvenTxsForUser in stored form, and nothing below the
    // envelope can split one record across blobs. Whatever COMPRESS_PROVEN_TX_RAWTX
    // says about the AT-REST column, the sync form must always be compressed or a
    // single vault deposit blocks every backup that follows it.
    for (const p of chunk.provenTxs ?? []) {
      p.rawTx = (await compressStoredTx(p.rawTx, p.txid)) as number[]
    }
    for (const t of chunk.transactions ?? []) {
      t.rawTx = await compressStoredTx(t.rawTx, t.txid)
      t.inputBEEF = await compressStoredBeef(t.inputBEEF)
    }
    return chunk
  }

  /**
   * One step of the at-rest R1-K1 compaction — rewrites at most one oversize
   * full-size blob into its compressed form. See storage/methods/compressAtRest.ts;
   * driven by utils/monitor/TaskCompressAtRest.ts, one row per monitor pass.
   */
  async compressNextOversizeRow(): Promise<CompactionStep | undefined> {
    // Scoped by database name so the in-process skip set of one wallet's
    // database can never suppress a colliding row id in another's.
    return await compressOneAtRest(this.getDB(), this.dbName)
  }

  // processSyncChunk — delegate to inherited implementation if available, stub otherwise
  async processSyncChunk(args: RequestSyncChunkArgs, chunk: SyncChunk): Promise<ProcessSyncChunkResult> {
    // The base StorageProvider class provides the implementation via super
    return await super.processSyncChunk(args, chunk)
  }

  // Helper: validate raw transaction (fill from proven if missing)
  private async validateRawTransaction(t: TableTransaction, trx?: TrxToken): Promise<void> {
    if (t.rawTx || !t.txid) return
    const rawTx = await this.getRawTxOfKnownValidTransaction(t.txid, undefined, undefined, trx)
    if (rawTx) t.rawTx = rawTx
  }
}
