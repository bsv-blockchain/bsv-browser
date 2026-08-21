/**
 * MANUAL repro harness for the on-device backup restore.
 *
 * Runs the exact device path — StorageExpoSQLite.migrate → restoreOnImport →
 * processSyncChunk — against the PRODUCTION backup server, with expo-sqlite
 * shimmed onto node:sqlite so it runs in jest. Skipped unless explicitly asked
 * for, because it needs network and real recovery shares:
 *
 *   RESTORE_REPRO=1 RESTORE_SHARES='share1,share2' npx jest __tests__/manual/restoreRepro.test.ts
 *
 * On failure it prints the full stack, the chunk number, and (via the storage
 * shim) the last SQL statements executed — everything the device's one-line
 * modal hides.
 */
// ── expo-sqlite → node:sqlite shim ─────────────────────────────────────────
jest.mock('expo-sqlite', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DatabaseSync } = require('node:sqlite')
  const sqlLog = ((globalThis as any).__sqlLog = (globalThis as any).__sqlLog ?? [])
  const toParams = (params?: unknown[]): any[] =>
    (params ?? []).map(p => {
      if (p === undefined) return null
      if (p instanceof Uint8Array) return p
      if (Array.isArray(p)) return Uint8Array.from(p as number[])
      if (p instanceof Date) return (p as Date).toISOString()
      if (typeof p === 'boolean') return p ? 1 : 0
      return p
    })
  class Db {
    d: InstanceType<typeof DatabaseSync>
    constructor(name: string) {
      this.d = new DatabaseSync(':memory:')
    }
    async execAsync(sql: string) {
      sqlLog.push(sql.slice(0, 120))
      this.d.exec(sql)
    }
    async runAsync(sql: string, params?: unknown[]) {
      sqlLog.push(sql.slice(0, 120))
      const r = this.d.prepare(sql).run(...toParams(params))
      return { lastInsertRowId: Number(r.lastInsertRowid), changes: Number(r.changes) }
    }
    async getFirstAsync(sql: string, params?: unknown[]) {
      sqlLog.push(sql.slice(0, 120))
      return this.d.prepare(sql).get(...toParams(params)) ?? null
    }
    async getAllAsync(sql: string, params?: unknown[]) {
      sqlLog.push(sql.slice(0, 120))
      return this.d.prepare(sql).all(...toParams(params))
    }
    async withExclusiveTransactionAsync(fn: (tx: Db) => Promise<void>) {
      this.d.exec('BEGIN')
      try {
        await fn(this)
        this.d.exec('COMMIT')
      } catch (e) {
        this.d.exec('ROLLBACK')
        throw e
      }
    }
    async closeAsync() {
      this.d.close()
    }
  }
  return {
    openDatabaseAsync: async (name: string) => new Db(name),
    deleteDatabaseAsync: async () => {}
  }
})

// Native/expo modules the storage layer touches incidentally.
jest.mock('@/utils/diskSpace', () => ({
  availableDiskBytes: jest.fn(async () => 10_000_000_000),
  diskPressure: jest.fn(async () => ({ pressured: false }))
}))

import { Mnemonic } from '@bsv/sdk'
import { recoverSecretFromShares } from '@/utils/backupShares'
import { recoverMnemonicWallet } from '@/utils/mnemonicWallet'
import { restoreOnImport } from '@/utils/backup/restoreOnImport'
import { StorageExpoSQLite } from '@/storage/StorageExpoSQLite'
import { StorageProvider } from '@bsv/wallet-toolbox-mobile'

const RUN = process.env.RESTORE_REPRO === '1'
const BASE_URL = process.env.RESTORE_BASE_URL ?? 'https://backup.bsvblockchain.tech'

;(RUN ? describe : describe.skip)('manual: full restore against production backup server', () => {
  jest.setTimeout(300_000)

  it('replays every chunk into a fresh database', async () => {
    const shares = (process.env.RESTORE_SHARES ?? '').split(',').map(s => s.trim()).filter(Boolean)
    expect(shares.length).toBeGreaterThanOrEqual(2)

    const secret = recoverSecretFromShares(shares)
    let primaryKey: number[]
    let identityKey: string
    if (secret.kind === 'entropy') {
      const mnemonic = Mnemonic.fromEntropy(secret.entropy).toString()
      const w = recoverMnemonicWallet(mnemonic)
      primaryKey = w.primaryKey
      identityKey = w.identityKey
    } else {
      throw new Error('legacy shares: extend harness')
    }
    // eslint-disable-next-line no-console
    console.log('identityKey:', identityKey)

    const storage = new StorageExpoSQLite({
      ...StorageProvider.createStorageBaseOptions('main'),
      feeModel: { model: 'sat/kb', value: 100 },
      identityKey,
      databaseName: 'repro-restore'
    } as any)
    await storage.migrate('bsv-wallet', identityKey)

    try {
      const result = await restoreOnImport({
        storage,
        primaryKey,
        identityKey,
        baseUrl: BASE_URL,
        onProgress: (chunks, total) => {
          // eslint-disable-next-line no-console
          console.log(`chunk ${chunks}/${total}`)
        }
      })
      // eslint-disable-next-line no-console
      console.log('RESTORE RESULT:', JSON.stringify(result))
      expect(result.restored).toBe(true)
      const db = (storage as any).db
      for (const t of ['transactions', 'outputs', 'proven_txs', 'proven_tx_reqs', 'output_baskets', 'certificates']) {
        const r = await db.getFirstAsync(`SELECT COUNT(*) AS n FROM ${t}`)
        // eslint-disable-next-line no-console
        console.log(`${t}: ${r.n}`)
      }
      const bal = await db.getFirstAsync(
        "SELECT SUM(satoshis) AS sats, COUNT(*) AS n FROM outputs WHERE spendable = 1"
      )
      // eslint-disable-next-line no-console
      console.log(`spendable outputs: ${bal.n}, total sats: ${bal.sats}`)
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('RESTORE FAILED:', e)
      // eslint-disable-next-line no-console
      console.error('last SQL:', ((globalThis as any).__sqlLog as string[]).slice(-15).join('\n'))
      throw e
    }
  })
})
