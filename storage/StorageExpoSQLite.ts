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

    // Open database
    this.db = await SQLite.openDatabaseAsync(this.dbName)

    // Create tables
    await createTables(this.db)

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

    return this.db
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
        conditions.push(`${key} = ?`)
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
}
