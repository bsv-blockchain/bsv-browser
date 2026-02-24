import * as SQLite from 'expo-sqlite'
import type { SQLiteDatabase } from 'expo-sqlite'
import { createTables } from './schema/createTables'
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
import type { ListActionsResult, ListOutputsResult, Validation } from '@bsv/sdk'
import { listActionsSql } from './methods/listActionsSql'
import { listOutputsSql } from './methods/listOutputsSql'

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

    // Check/insert settings
    const existing = await this.db.getFirstAsync(
      'SELECT * FROM settings WHERE storageIdentityKey = ?',
      [storageIdentityKey]
    ) as any
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
    const row = await db.getFirstAsync('SELECT * FROM settings LIMIT 1') as any
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

  async transaction<T>(scope: (trx: TrxToken) => Promise<T>, trx?: TrxToken): Promise<T> {
    if (trx) return await scope(trx)
    const db = this.getDB()
    const token: TrxToken = { _inTrx: true } as any
    let result: T
    await db.withTransactionAsync(async () => {
      result = await scope(token)
    })
    return result!
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
      }
    }
    this.isDirty = true
    return v
  }

  async validateEntityForInsert(entity: any, trx?: TrxToken, dateFields?: string[], booleanFields?: string[]): Promise<any> {
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
        const v = typeof value === 'boolean' ? (value ? 1 : 0)
          : value instanceof Date ? this.validateDateForWhere(value)
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

  private async sqlFind<T>(
    table: string,
    args: { partial: Record<string, any>; since?: Date; paged?: { limit?: number; offset?: number }; orderDescending?: boolean; trx?: TrxToken },
    pkCol: string,
    extraClauses?: { conditions: string[]; params: any[] }
  ): Promise<T[]> {
    const db = this.getDB()
    const { sql: whereSql, params } = this.buildWhere(args.partial)
    let query = `SELECT * FROM "${table}" ${whereSql}`

    if (args.since) {
      query += `${whereSql ? ' AND' : ' WHERE'} updated_at >= ?`
      params.push(this.validateDateForWhere(args.since))
    }
    if (extraClauses) {
      for (const c of extraClauses.conditions) {
        query += `${(whereSql || args.since) ? ' AND' : ' WHERE'} ${c}`
      }
      params.push(...extraClauses.params)
    }
    query += ` ORDER BY "${pkCol}" ${args.orderDescending ? 'DESC' : 'ASC'}`
    if (args.paged?.limit) {
      query += ` LIMIT ${args.paged.limit}`
      if (args.paged?.offset) {
        query += ` OFFSET ${args.paged.offset}`
      }
    }
    return await db.getAllAsync(query, params) as T[]
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
        query += `${(whereSql || args.since) ? ' AND' : ' WHERE'} ${c}`
      }
      params.push(...extraClauses.params)
    }
    const result = await db.getFirstAsync(query, params) as any
    return result?.count || 0
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

  private async sqlUpdate(table: string, ids: number | number[], update: Record<string, any>, pkCol: string): Promise<number> {
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

  private async sqlUpdateComposite(table: string, keyMap: Record<string, any>, update: Record<string, any>): Promise<number> {
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
    const id = await this.sqlInsert('proven_txs', e, 'provenTxId')
    tx.provenTxId = id
    return id
  }

  async insertProvenTxReq(tx: TableProvenTxReq, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(tx, trx)
    if (e.provenTxReqId === 0) delete e.provenTxReqId
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
    const u = this.validatePartialForUpdate(update)
    return await this.sqlUpdate('proven_txs', id, u as any, 'provenTxId')
  }

  async updateProvenTxReq(id: number | number[], update: Partial<TableProvenTxReq>, trx?: TrxToken): Promise<number> {
    const u = this.validatePartialForUpdate(update)
    return await this.sqlUpdate('proven_tx_reqs', id, u as any, 'provenTxReqId')
  }

  async updateCertificate(id: number, update: Partial<TableCertificate>, trx?: TrxToken): Promise<number> {
    const u = this.validatePartialForUpdate(update, undefined, ['isDeleted'])
    return await this.sqlUpdate('certificates', id, u as any, 'certificateId')
  }

  async updateCertificateField(certificateId: number, fieldName: string, update: Partial<TableCertificateField>, trx?: TrxToken): Promise<number> {
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
    const u = this.validatePartialForUpdate(update)
    return await this.sqlUpdate('outputs', id, u as any, 'outputId')
  }

  async updateOutputBasket(id: number, update: Partial<TableOutputBasket>, trx?: TrxToken): Promise<number> {
    const u = this.validatePartialForUpdate(update, undefined, ['isDeleted'])
    return await this.sqlUpdate('output_baskets', id, u as any, 'basketId')
  }

  async updateOutputTag(id: number, update: Partial<TableOutputTag>, trx?: TrxToken): Promise<number> {
    const u = this.validatePartialForUpdate(update, undefined, ['isDeleted'])
    return await this.sqlUpdate('output_tags', id, u as any, 'outputTagId')
  }

  async updateOutputTagMap(outputId: number, tagId: number, update: Partial<TableOutputTagMap>, trx?: TrxToken): Promise<number> {
    const u = this.validatePartialForUpdate(update, undefined, ['isDeleted'])
    return await this.sqlUpdateComposite('output_tags_map', { outputTagId: tagId, outputId }, u as any)
  }

  async updateSyncState(id: number, update: Partial<TableSyncState>, trx?: TrxToken): Promise<number> {
    const u = this.validatePartialForUpdate(update, ['when'], ['init'])
    return await this.sqlUpdate('sync_states', id, u as any, 'syncStateId')
  }

  async updateTransaction(id: number | number[], update: Partial<TableTransaction>, trx?: TrxToken): Promise<number> {
    const u = this.validatePartialForUpdate(update)
    return await this.sqlUpdate('transactions', id, u as any, 'transactionId')
  }

  async updateTxLabel(id: number, update: Partial<TableTxLabel>, trx?: TrxToken): Promise<number> {
    const u = this.validatePartialForUpdate(update, undefined, ['isDeleted'])
    return await this.sqlUpdate('tx_labels', id, u as any, 'txLabelId')
  }

  async updateTxLabelMap(transactionId: number, txLabelId: number, update: Partial<TableTxLabelMap>, trx?: TrxToken): Promise<number> {
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
    const rows = await this.sqlFind<any>('certificates', { ...args, partial }, 'certificateId',
      extraConditions.length > 0 ? { conditions: extraConditions, params: extraParams } : undefined)
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

  async findOutputs(args: FindOutputsArgs, tagIds?: number[], isQueryModeAll?: boolean): Promise<TableOutput[]> {
    if ((args.partial as any).lockingScript) {
      throw new Error('Outputs may not be found by lockingScript value.')
    }
    const db = this.getDB()
    const partial = { ...args.partial } as any

    // Build base query
    const extraConditions: string[] = []
    const extraParams: any[] = []

    // Handle txStatus filter via subquery
    if (args.txStatus && args.txStatus.length > 0) {
      const placeholders = args.txStatus.map(() => '?').join(',')
      extraConditions.push(`transactionId IN (SELECT transactionId FROM transactions WHERE status IN (${placeholders}))`)
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

    const rows = await this.sqlFind<any>('outputs', { ...args, partial }, 'outputId',
      extraConditions.length > 0 ? { conditions: extraConditions, params: extraParams } : undefined)

    const results = this.validateEntities(rows, undefined, ['spendable', 'change'])

    for (const o of results) {
      if (!args.noScript) {
        await this.validateOutputScript(o, args.trx)
      } else {
        o.lockingScript = undefined
      }
    }
    return results
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

  async findTransactions(args: FindTransactionsArgs, labelIds?: number[], isQueryModeAll?: boolean): Promise<TableTransaction[]> {
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

    const rows = await this.sqlFind<any>('transactions', args, 'transactionId',
      extraConditions.length > 0 ? { conditions: extraConditions, params: extraParams } : undefined)

    const results = this.validateEntities(rows, undefined, ['isOutgoing'])

    for (const t of results) {
      if (!args.noRawTx) {
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
    const rows = await this.sqlFind<any>('output_tags_map', args, 'outputTagId',
      extraConditions.length > 0 ? { conditions: extraConditions, params: extraParams } : undefined)
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
    const rows = await this.sqlFind<any>('proven_tx_reqs', args, 'provenTxReqId',
      extraConditions.length > 0 ? { conditions: extraConditions, params: extraParams } : undefined)
    return this.validateEntities(rows, undefined, ['notified'])
  }

  async findProvenTxs(args: FindProvenTxsArgs): Promise<TableProvenTx[]> {
    if ((args.partial as any).rawTx) throw new Error('ProvenTxs may not be found by rawTx value.')
    if ((args.partial as any).merklePath) throw new Error('ProvenTxs may not be found by merklePath value.')
    const rows = await this.sqlFind<any>('proven_txs', args, 'provenTxId')
    return this.validateEntities(rows)
  }

  async findTxLabelMaps(args: FindTxLabelMapsArgs): Promise<TableTxLabelMap[]> {
    const extraConditions: string[] = []
    const extraParams: any[] = []
    if (args.labelIds && args.labelIds.length > 0) {
      extraConditions.push(`txLabelId IN (${args.labelIds.map(() => '?').join(',')})`)
      extraParams.push(...args.labelIds)
    }
    const rows = await this.sqlFind<any>('tx_labels_map', args, 'txLabelId',
      extraConditions.length > 0 ? { conditions: extraConditions, params: extraParams } : undefined)
    return this.validateEntities(rows, undefined, ['isDeleted'])
  }

  // ============================================================================
  // COUNT methods (StorageReader: 11, StorageReaderWriter: 4 = 15)
  // ============================================================================

  async countUsers(args: FindUsersArgs): Promise<number> { return this.sqlCount('users', args) }
  async countCertificateFields(args: FindCertificateFieldsArgs): Promise<number> { return this.sqlCount('certificate_fields', args) }

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
    return this.sqlCount('certificates', args, extraConditions.length > 0 ? { conditions: extraConditions, params: extraParams } : undefined)
  }

  async countCommissions(args: FindCommissionsArgs): Promise<number> { return this.sqlCount('commissions', args) }
  async countMonitorEvents(args: FindMonitorEventsArgs): Promise<number> { return this.sqlCount('monitor_events', args) }
  async countOutputBaskets(args: FindOutputBasketsArgs): Promise<number> { return this.sqlCount('output_baskets', args) }

  async countOutputs(args: FindOutputsArgs, tagIds?: number[], isQueryModeAll?: boolean): Promise<number> {
    const extraConditions: string[] = []
    const extraParams: any[] = []
    if (args.txStatus && args.txStatus.length > 0) {
      const placeholders = args.txStatus.map(() => '?').join(',')
      extraConditions.push(`transactionId IN (SELECT transactionId FROM transactions WHERE status IN (${placeholders}))`)
      extraParams.push(...args.txStatus)
    }
    if (tagIds && tagIds.length > 0) {
      const tagPlaceholders = tagIds.map(() => '?').join(',')
      if (isQueryModeAll) {
        extraConditions.push(`outputId IN (
          SELECT outputId FROM output_tags_map WHERE outputTagId IN (${tagPlaceholders}) AND isDeleted = 0
          GROUP BY outputId HAVING COUNT(DISTINCT outputTagId) = ${tagIds.length}
        )`)
      } else {
        extraConditions.push(`outputId IN (
          SELECT outputId FROM output_tags_map WHERE outputTagId IN (${tagPlaceholders}) AND isDeleted = 0
        )`)
      }
      extraParams.push(...tagIds)
    }
    return this.sqlCount('outputs', args, extraConditions.length > 0 ? { conditions: extraConditions, params: extraParams } : undefined)
  }

  async countOutputTags(args: FindOutputTagsArgs): Promise<number> { return this.sqlCount('output_tags', args) }
  async countSyncStates(args: FindSyncStatesArgs): Promise<number> { return this.sqlCount('sync_states', args) }

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
    return this.sqlCount('transactions', args, extraConditions.length > 0 ? { conditions: extraConditions, params: extraParams } : undefined)
  }

  async countTxLabels(args: FindTxLabelsArgs): Promise<number> { return this.sqlCount('tx_labels', args) }

  // StorageReaderWriter count methods
  async countOutputTagMaps(args: FindOutputTagMapsArgs): Promise<number> {
    const extraConditions: string[] = []
    const extraParams: any[] = []
    if (args.tagIds && args.tagIds.length > 0) {
      extraConditions.push(`outputTagId IN (${args.tagIds.map(() => '?').join(',')})`)
      extraParams.push(...args.tagIds)
    }
    return this.sqlCount('output_tags_map', args, extraConditions.length > 0 ? { conditions: extraConditions, params: extraParams } : undefined)
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
    return this.sqlCount('proven_tx_reqs', args, extraConditions.length > 0 ? { conditions: extraConditions, params: extraParams } : undefined)
  }

  async countProvenTxs(args: FindProvenTxsArgs): Promise<number> { return this.sqlCount('proven_txs', args) }

  async countTxLabelMaps(args: FindTxLabelMapsArgs): Promise<number> {
    const extraConditions: string[] = []
    const extraParams: any[] = []
    if (args.labelIds && args.labelIds.length > 0) {
      extraConditions.push(`txLabelId IN (${args.labelIds.map(() => '?').join(',')})`)
      extraParams.push(...args.labelIds)
    }
    return this.sqlCount('tx_labels_map', args, extraConditions.length > 0 ? { conditions: extraConditions, params: extraParams } : undefined)
  }

  // ============================================================================
  // getForUser methods (4)
  // ============================================================================

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
    const rows = await db.getAllAsync(query, params) as any[]
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
    const rows = await db.getAllAsync(query, params) as any[]
    return this.validateEntities(rows, undefined, ['notified'])
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
    const rows = await db.getAllAsync(query, params) as any[]
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
    const rows = await db.getAllAsync(query, params) as any[]
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
    if (!auth.userId || (certificate.userId && certificate.userId !== auth.userId))
      throw new Error('WERR_UNAUTHORIZED')
    certificate.userId = auth.userId
    return await this.insertCertificate(certificate)
  }

  // Data retrieval
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
    return r
  }

  async getRawTxOfKnownValidTransaction(txid?: string, offset?: number, length?: number, trx?: TrxToken): Promise<number[] | undefined> {
    if (!txid) return undefined
    if (!this.isAvailable()) await this.makeAvailable()
    let rawTx: number[] | undefined
    const r = await this.getProvenOrRawTx(txid, trx)
    if (r.proven) rawTx = r.proven.rawTx
    else rawTx = r.rawTx
    if (rawTx && offset !== undefined && length !== undefined && Number.isInteger(offset) && Number.isInteger(length)) {
      rawTx = rawTx.slice(offset, offset + length)
    }
    return rawTx
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
      const results = await this.findOutputTags({ partial: { outputTagId: m.outputTagId, isDeleted: false } as any, trx })
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

  // Override internalizeAction for debugging
  async internalizeAction(auth: AuthId, args: any): Promise<any> {
    console.log('[StorageExpoSQLite] internalizeAction called, userId:', auth.userId)
    try {
      const result = await super.internalizeAction(auth, args)
      console.log('[StorageExpoSQLite] internalizeAction result:', JSON.stringify({
        accepted: result.accepted,
        isMerge: result.isMerge,
        txid: result.txid,
        satoshis: result.satoshis,
        hasSendWithResults: !!result.sendWithResults,
        hasNotDelayedResults: !!result.notDelayedResults
      }))
      return result
    } catch (e: any) {
      console.error('[StorageExpoSQLite] internalizeAction ERROR:', e.message, e.stack?.slice(0, 500))
      throw e
    }
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
