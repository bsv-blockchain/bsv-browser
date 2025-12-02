import * as SQLite from 'expo-sqlite'
import type { SQLiteDatabase } from 'expo-sqlite'
import { createTables } from './schema/createTables'

/**
 * SQLite storage implementation for BSV wallet using expo-sqlite
 * Based on @bsv/wallet-toolbox StorageIdb and StorageKnex implementations
 */

interface StorageOptions {
  chain?: 'main' | 'test'
  databaseName?: string
}

interface TableSettings {
  storageIdentityKey: string
  storageName: string
  chain: string
  dbtype: string
  maxOutputScript: number
  created_at: Date
  updated_at: Date
}

/**
 * Transaction token to support nested transactions
 */
export interface TrxToken {
  id: string
}

export class StorageExpoSQLite {
  private db: SQLiteDatabase | null = null
  private chain: 'main' | 'test'
  private dbName: string
  private _settings: TableSettings | null = null
  private whenLastAccess: Date = new Date()
  private _services: any = null // WalletServices from @bsv/sdk

  // All table names
  readonly allTables = [
    'certificates',
    'certificate_fields',
    'commissions',
    'monitor_events',
    'outputs',
    'output_baskets',
    'output_tags',
    'output_tags_map',
    'proven_txs',
    'proven_tx_reqs',
    'sync_states',
    'transactions',
    'tx_labels',
    'tx_labels_map',
    'users',
    'settings'
  ]

  constructor(options: StorageOptions = {}) {
    this.chain = options.chain || 'main'
    this.dbName = options.databaseName || `wallet-toolbox-${this.chain}net.db`
  }

  /**
   * Initialize the database and create tables
   */
  async migrate(storageName: string, storageIdentityKey: string): Promise<string> {
    await this.initDB(storageName, storageIdentityKey)
    return '1'
  }

  /**
   * Initialize database connection and schema
   */
  private async initDB(storageName?: string, storageIdentityKey?: string): Promise<SQLiteDatabase> {
    if (this.db) {
      return this.db
    }

    try {
      console.log('[StorageExpoSQLite] Opening database:', this.dbName)

      // Open database
      this.db = await SQLite.openDatabaseAsync(this.dbName)
      console.log('[StorageExpoSQLite] Database opened successfully')

      // Create tables
      await createTables(this.db)
      console.log('[StorageExpoSQLite] Tables created successfully')

      // Initialize settings if needed
      if (storageName && storageIdentityKey) {
        const existingSettings = await this.db.getFirstAsync(
          'SELECT * FROM settings WHERE storageIdentityKey = ?',
          [storageIdentityKey]
        ) as TableSettings | null

        if (!existingSettings) {
          const now = new Date().toISOString()
          await this.db.runAsync(
            `INSERT INTO settings (storageIdentityKey, storageName, chain, dbtype, maxOutputScript, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [storageIdentityKey, storageName, this.chain, 'SQLite', 1024, now, now]
          )
        }

        // Load settings
        this._settings = await this.db.getFirstAsync(
          'SELECT * FROM settings WHERE storageIdentityKey = ?',
          [storageIdentityKey]
        ) as TableSettings | null
      }

      console.log('[StorageExpoSQLite] Database initialization complete')
      return this.db
    } catch (error) {
      console.error('[StorageExpoSQLite] Failed to initialize database:', error)
      // Clean up on error
      this.db = null
      this._settings = null
      throw new Error(`Database initialization failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Verify database is ready for operations
   */
  private async verifyDB(): Promise<SQLiteDatabase> {
    if (!this.db) {
      throw new Error('Database not initialized. Call migrate() first.')
    }
    this.whenLastAccess = new Date()
    return this.db
  }

  /**
   * Get current settings
   */
  async getSettings(): Promise<TableSettings> {
    if (this._settings) {
      return this._settings
    }

    const db = await this.verifyDB()
    const settings = await db.getFirstAsync('SELECT * FROM settings LIMIT 1') as TableSettings | null

    if (!settings) {
      throw new Error('Settings not found. Call migrate() first.')
    }

    this._settings = settings
    return settings
  }

  /**
   * Check if storage is available
   */
  isAvailable(): boolean {
    return this.db !== null
  }

  /**
   * Make storage available by initializing and loading settings
   */
  async makeAvailable(): Promise<TableSettings> {
    await this.verifyDB()
    return await this.getSettings()
  }

  /**
   * Close database connection
   */
  async destroy(): Promise<void> {
    if (this.db) {
      await this.db.closeAsync()
      this.db = null
      this._settings = null
    }
  }

  /**
   * Drop all data from the database (for testing/development)
   */
  async dropAllData(): Promise<void> {
    const db = await this.verifyDB()

    // Drop all tables in reverse order to avoid foreign key issues
    const tables = [...this.allTables].reverse()

    for (const table of tables) {
      await db.runAsync(`DELETE FROM ${table}`)
    }
  }

  /**
   * Execute within a transaction
   */
  async transaction<T>(scope: (trx: TrxToken) => Promise<T>, _trx?: TrxToken): Promise<T> {
    const db = await this.verifyDB()

    try {
      await db.execAsync('BEGIN TRANSACTION')
      const trxToken: TrxToken = { id: Date.now().toString() }
      const result = await scope(trxToken)
      await db.execAsync('COMMIT')
      return result
    } catch (error) {
      await db.execAsync('ROLLBACK')
      throw error
    }
  }

  // ============================================================================
  // Helper methods for data conversion
  // ============================================================================

  /**
   * Convert Date to ISO string for storage
   */
  private toISOString(date: Date | string): string {
    if (typeof date === 'string') return date
    return date.toISOString()
  }

  /**
   * Convert ISO string to Date
   */
  private toDate(isoString: string | null): Date | null {
    if (!isoString) return null
    return new Date(isoString)
  }

  /**
   * Convert boolean to integer for SQLite
   */
  private toInt(value: boolean | number): number {
    return value ? 1 : 0
  }

  /**
   * Convert integer to boolean from SQLite
   */
  private toBool(value: number | boolean): boolean {
    return value === 1 || value === true
  }

  /**
   * Convert Uint8Array to BLOB for storage
   */
  private toBlob(data: number[] | Uint8Array | null): Uint8Array | null {
    if (!data) return null
    if (data instanceof Uint8Array) return data
    return new Uint8Array(data)
  }

  /**
   * Convert BLOB to number array
   */
  private toNumberArray(blob: Uint8Array | null): number[] | null {
    if (!blob) return null
    return Array.from(blob)
  }

  /**
   * Build WHERE clause from partial object
   */
  private buildWhereClause(partial: Record<string, any>): { clause: string; values: any[] } {
    const conditions: string[] = []
    const values: any[] = []

    for (const [key, value] of Object.entries(partial)) {
      if (value !== undefined && value !== null) {
        // Escape column name with double quotes to handle reserved keywords
        conditions.push(`"${key}" = ?`)
        values.push(value)
      }
    }

    const clause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    return { clause, values }
  }

  /**
   * Validate and prepare entity for database operations
   * Handles timestamp and data type conversions
   */
  private prepareEntity<T extends Record<string, any>>(entity: T, isUpdate = false): Record<string, any> {
    const prepared: Record<string, any> = { ...entity }

    // Handle timestamps
    if (!isUpdate && !prepared.created_at) {
      prepared.created_at = new Date().toISOString()
    }
    prepared.updated_at = new Date().toISOString()

    // Convert Date objects to ISO strings
    for (const key of Object.keys(prepared)) {
      if (prepared[key] instanceof Date) {
        prepared[key] = this.toISOString(prepared[key])
      }
      // Convert boolean to integer
      else if (typeof prepared[key] === 'boolean') {
        prepared[key] = this.toInt(prepared[key])
      }
      // Convert number arrays to Uint8Array for BLOBs
      else if (Array.isArray(prepared[key]) && key.match(/(rawTx|merklePath|lockingScript|inputBEEF)/)) {
        prepared[key] = this.toBlob(prepared[key])
      }
    }

    return prepared
  }

  /**
   * Validate entity after reading from database
   * Converts timestamps and data types back to proper formats
   */
  private validateEntity<T extends Record<string, any>>(
    entity: T,
    dateFields: string[] = ['created_at', 'updated_at'],
    booleanFields: string[] = []
  ): T {
    const validated: Record<string, any> = { ...entity }

    // Convert ISO strings to Dates
    for (const field of dateFields) {
      if (validated[field] && typeof validated[field] === 'string') {
        validated[field] = new Date(validated[field])
      }
    }

    // Convert integers to booleans
    for (const field of booleanFields) {
      if (validated[field] !== undefined) {
        validated[field] = this.toBool(validated[field])
      }
    }

    // Convert BLOBs to number arrays where appropriate
    for (const key of Object.keys(validated)) {
      if (validated[key] instanceof Uint8Array && key.match(/(rawTx|merklePath|lockingScript|inputBEEF)/)) {
        validated[key] = this.toNumberArray(validated[key])
      }
    }

    return validated as T
  }

  /**
   * Validate array of entities
   */
  private validateEntities<T extends Record<string, any>>(
    entities: T[],
    dateFields: string[] = ['created_at', 'updated_at'],
    booleanFields: string[] = []
  ): T[] {
    return entities.map(entity => this.validateEntity(entity, dateFields, booleanFields))
  }

  // ============================================================================
  // WalletStorageProvider interface methods
  // ============================================================================

  /**
   * Set the services instance for blockchain operations
   */
  setServices(services: any): void {
    this._services = services
  }

  /**
   * Get the services instance for blockchain operations
   */
  getServices(): any {
    if (!this._services) {
      throw new Error('Services not initialized. Call setServices() first.')
    }
    return this._services
  }

  /**
   * Initialize backend services - required for wallet storage provider
   * This method sets up the necessary blockchain services for the storage
   */
  async initializeBackendServices(): Promise<void> {
    // Verify database is ready
    await this.verifyDB()

    // Services should already be set via setServices()
    if (!this._services) {
      throw new Error('Services must be set before initializing backend services')
    }

    console.log('[StorageExpoSQLite] Backend services initialized')
  }

  /**
   * Check if this is a storage provider (vs a remote storage client)
   * @returns true since this is a local storage provider
   */
  isStorageProvider(): boolean {
    return true
  }

  // ============================================================================
  // WalletStorageProvider list methods (required by wallet)
  // ============================================================================

  /**
   * List outputs for the authenticated user
   * Required by wallet for balance and UTXO operations
   */
  async listOutputs(auth: any, vargs: any): Promise<any> {
    const db = await this.verifyDB()
    const userId = auth.userId

    if (!userId) {
      throw new Error('auth.userId is required for listOutputs')
    }

    const limit = vargs.limit || 10
    const offset = vargs.offset || 0
    const basket = vargs.basket

    // Build query for outputs
    let query = `
      SELECT o.*, t.txid, t.status as txStatus
      FROM outputs o
      INNER JOIN transactions t ON o.transactionId = t.transactionId
      WHERE o.userId = ?
    `
    const params: any[] = [userId]

    // Filter by basket if specified
    if (basket) {
      const basketResult = await db.getAllAsync(
        'SELECT basketId FROM output_baskets WHERE userId = ? AND name = ?',
        [userId, basket]
      ) as any[]
      if (basketResult.length === 0) {
        return { totalOutputs: 0, outputs: [] }
      }
      query += ' AND o.basketId = ?'
      params.push(basketResult[0].basketId)
    }

    // Filter by spendable (exclude spent outputs by default)
    if (!vargs.includeSpent) {
      query += ' AND o.spendable = 1'
    }

    // Filter by transaction status (only completed, unproven, nosend)
    query += ' AND t.status IN (?, ?, ?)'
    params.push('completed', 'unproven', 'nosend')

    // Get total count first
    const countQuery = query.replace('SELECT o.*, t.txid, t.status as txStatus', 'SELECT COUNT(*) as total')
    const countResult = await db.getAllAsync(countQuery, params) as any[]
    const totalOutputs = countResult[0]?.total || 0

    // Add pagination
    query += ' LIMIT ? OFFSET ?'
    params.push(limit, offset)

    // Execute query
    const rows = await db.getAllAsync(query, params) as any[]

    // Transform to WalletOutput format
    const outputs = rows.map((row: any) => {
      const output: any = {
        satoshis: Number(row.satoshis),
        spendable: !!row.spendable,
        outpoint: row.outpoint
      }

      if (vargs.includeCustomInstructions && row.customInstructions) {
        output.customInstructions = row.customInstructions
      }

      return output
    })

    return {
      totalOutputs,
      outputs
    }
  }

  /**
   * List actions for the authenticated user
   * Required by wallet for transaction history
   */
  async listActions(auth: any, vargs: any): Promise<any> {
    const db = await this.verifyDB()
    const userId = auth.userId

    if (!userId) {
      throw new Error('auth.userId is required for listActions')
    }

    const limit = vargs.limit || 10
    const offset = vargs.offset || 0

    // Build query for transactions (actions)
    let query = `
      SELECT t.*
      FROM transactions t
      WHERE t.userId = ?
    `
    const params: any[] = [userId]

    // Filter by labels if specified
    if (vargs.labels && vargs.labels.length > 0) {
      query += ` AND t.transactionId IN (
        SELECT tlm.transactionId FROM tx_labels_map tlm
        INNER JOIN tx_labels tl ON tlm.txLabelId = tl.txLabelId
        WHERE tl.label IN (${vargs.labels.map(() => '?').join(',')})
      )`
      params.push(...vargs.labels)
    }

    // Order by created_at descending (most recent first)
    query += ' ORDER BY t.created_at DESC'

    // Get total count first
    const countQuery = query.replace('SELECT t.*', 'SELECT COUNT(*) as total').replace('ORDER BY t.created_at DESC', '')
    const countResult = await db.getAllAsync(countQuery, params) as any[]
    const totalActions = countResult[0]?.total || 0

    // Add pagination
    query += ' LIMIT ? OFFSET ?'
    params.push(limit, offset)

    // Execute query
    const rows = await db.getAllAsync(query, params) as any[]

    // Transform to action format
    const actions = rows.map((row: any) => ({
      txid: row.txid || row.reference,
      satoshis: Number(row.satoshis),
      status: row.status,
      isOutgoing: !!row.isOutgoing,
      description: row.description,
      version: Number(row.version),
      lockTime: Number(row.lockTime),
      reference: row.reference
    }))

    return {
      totalActions,
      actions
    }
  }

  /**
   * List certificates for the authenticated user
   * Required by wallet for identity operations
   */
  async listCertificates(auth: any, vargs: any): Promise<any> {
    const db = await this.verifyDB()
    const userId = auth.userId

    if (!userId) {
      throw new Error('auth.userId is required for listCertificates')
    }

    const limit = vargs.limit || 10
    const offset = vargs.offset || 0

    // Build query for certificates
    let query = `
      SELECT c.*
      FROM certificates c
      WHERE c.userId = ?
        AND c.isDeleted = 0
    `
    const params: any[] = [userId]

    // Filter by certifiers if specified
    if (vargs.certifiers && vargs.certifiers.length > 0) {
      query += ` AND c.certifier IN (${vargs.certifiers.map(() => '?').join(',')})`
      params.push(...vargs.certifiers)
    }

    // Filter by types if specified
    if (vargs.types && vargs.types.length > 0) {
      query += ` AND c.type IN (${vargs.types.map(() => '?').join(',')})`
      params.push(...vargs.types)
    }

    // Get total count first
    const countQuery = query.replace('SELECT c.*', 'SELECT COUNT(*) as total')
    const countResult = await db.getAllAsync(countQuery, params) as any[]
    const totalCertificates = countResult[0]?.total || 0

    // Add pagination
    query += ' LIMIT ? OFFSET ?'
    params.push(limit, offset)

    // Execute query
    const rows = await db.getAllAsync(query, params) as any[]

    // Transform to certificate format
    const certificates = rows.map((row: any) => ({
      type: row.type,
      subject: row.subject,
      serialNumber: row.serialNumber,
      certifier: row.certifier,
      revocationOutpoint: row.revocationOutpoint,
      signature: row.signature,
      fields: {} // Fields would be loaded separately if needed
    }))

    return {
      totalCertificates,
      certificates
    }
  }
}
