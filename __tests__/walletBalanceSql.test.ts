/**
 * The wallet balance query, run against the REAL schema.
 *
 * node:sqlite gives us the actual SQLite engine in jest, so these tests execute
 * `createTables()` and then the same SQL the app runs on device — a filter that
 * silently stopped matching, or a column that a migration renamed, fails here
 * rather than showing the user the wrong money.
 */
import { DatabaseSync } from 'node:sqlite'
import { createTables } from '@/storage/schema/createTables'
import { readWalletBalance, BALANCE_BASKET } from '@/storage/methods/walletBalanceSql'
import { StorageExpoSQLite } from '@/storage/StorageExpoSQLite'
import { listOutputsSql } from '@/storage/methods/listOutputsSql'
import { sdk } from '@bsv/wallet-toolbox-mobile'

/** expo-sqlite's async surface over node:sqlite's sync one — only the handful of
 * methods the code under test calls. */
function adapt(db: DatabaseSync) {
  return {
    execAsync: async (sql: string) => {
      db.exec(sql)
    },
    getAllAsync: async (sql: string, params: unknown[] = []) => db.prepare(sql).all(...(params as never[])),
    getFirstAsync: async (sql: string, params: unknown[] = []) =>
      db.prepare(sql).get(...(params as never[])) ?? null,
    runAsync: async (sql: string, params: unknown[] = []) => db.prepare(sql).run(...(params as never[]))
  }
}

type Db = ReturnType<typeof adapt>

const NOW = '2026-08-18T00:00:00.000Z'
let raw: DatabaseSync
let db: Db
let storage: StorageExpoSQLite

/** Insert a transaction in `status` and one output in `basketId` against it. */
async function seedOutput(opts: {
  status: string
  basketId: number
  satoshis: number
  spendable?: boolean
  userId?: number
  vout?: number
}): Promise<void> {
  const userId = opts.userId ?? 1
  await db.runAsync(
    `INSERT INTO transactions (created_at, updated_at, userId, status, reference, isOutgoing, satoshis, txid)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    [NOW, NOW, userId, opts.status, `ref-${Math.random()}`, opts.satoshis, 'a'.repeat(64)]
  )
  const { transactionId } = (await db.getFirstAsync(
    'SELECT MAX(transactionId) as transactionId FROM transactions',
    []
  )) as { transactionId: number }
  await db.runAsync(
    `INSERT INTO outputs (created_at, updated_at, userId, transactionId, basketId, spendable, change,
       vout, satoshis, providedBy, txid, lockingScript)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 'you', ?, ?)`,
    [
      NOW,
      NOW,
      userId,
      transactionId,
      opts.basketId,
      opts.spendable === false ? 0 : 1,
      opts.vout ?? 0,
      opts.satoshis,
      'b'.repeat(64),
      new Uint8Array(25)
    ]
  )
}

async function seedBasket(name: string, userId = 1): Promise<number> {
  await db.runAsync(
    `INSERT INTO output_baskets (created_at, updated_at, userId, name, numberOfDesiredUTXOs, minimumDesiredUTXOValue)
     VALUES (?, ?, ?, ?, 6, 1000)`,
    [NOW, NOW, userId, name]
  )
  const { basketId } = (await db.getFirstAsync('SELECT MAX(basketId) as basketId FROM output_baskets', [])) as {
    basketId: number
  }
  return basketId
}

beforeEach(async () => {
  raw = new DatabaseSync(':memory:')
  db = adapt(raw)
  await createTables(db as never)
  // The real provider, over the real engine: only the native handle is swapped
  // out, so these tests run the SQL StorageExpoSQLite actually builds.
  storage = new StorageExpoSQLite({ chain: 'test' } as never)
  ;(storage as unknown as { db: unknown }).db = db
  // node:sqlite enforces foreign keys, so the two users these tests reference
  // have to exist.
  for (const identityKey of ['02' + 'a'.repeat(62), '02' + 'b'.repeat(62)]) {
    await db.runAsync('INSERT INTO users (created_at, updated_at, identityKey) VALUES (?, ?, ?)', [
      NOW,
      NOW,
      identityKey
    ])
  }
})

afterEach(() => {
  raw.close()
})

describe('readWalletBalance', () => {
  it('sums only spendable default-basket outputs in a counted transaction state', async () => {
    const dflt = await seedBasket(BALANCE_BASKET)
    const vault = await seedBasket('admin vault')

    await seedOutput({ status: 'completed', basketId: dflt, satoshis: 1000 })
    await seedOutput({ status: 'unproven', basketId: dflt, satoshis: 200, vout: 1 })
    await seedOutput({ status: 'nosend', basketId: dflt, satoshis: 30, vout: 2 })
    // Excluded, each for its own reason.
    await seedOutput({ status: 'completed', basketId: dflt, satoshis: 9_000, spendable: false, vout: 3 })
    await seedOutput({ status: 'failed', basketId: dflt, satoshis: 9_000, vout: 4 })
    await seedOutput({ status: 'unprocessed', basketId: dflt, satoshis: 9_000, vout: 5 })
    await seedOutput({ status: 'completed', basketId: vault, satoshis: 9_000, vout: 6 })
    await seedOutput({ status: 'completed', basketId: dflt, satoshis: 9_000, userId: 2, vout: 7 })

    expect(await readWalletBalance(storage, 1)).toBe(1230)
  })

  it('is zero, not null, for a wallet whose basket exists but holds nothing spendable', async () => {
    const dflt = await seedBasket(BALANCE_BASKET)
    await seedOutput({ status: 'completed', basketId: dflt, satoshis: 500, spendable: false })

    expect(await readWalletBalance(storage, 1)).toBe(0)
  })

  it('returns null — not 0 — when the default basket does not exist yet', async () => {
    // A wallet still building. 0 here would flash over the cached figure.
    expect(await readWalletBalance(storage, 1)).toBeNull()
  })

  it('scopes to the asking user', async () => {
    await seedBasket(BALANCE_BASKET, 1)
    const theirs = await seedBasket(BALANCE_BASKET, 2)
    await seedOutput({ status: 'completed', basketId: theirs, satoshis: 7777, userId: 2 })

    expect(await readWalletBalance(storage, 1)).toBe(0)
    expect(await readWalletBalance(storage, 2)).toBe(7777)
  })
})

describe('the queries behind the balance', () => {
  /** Every SQL string the provider sent, in order. */
  function recordSql(): string[] {
    const seen: string[] = []
    const getAll = db.getAllAsync
    db.getAllAsync = async (sql: string, params: unknown[] = []) => {
      seen.push(sql)
      return await getAll(sql, params)
    }
    const getFirst = db.getFirstAsync
    db.getFirstAsync = async (sql: string, params: unknown[] = []) => {
      seen.push(sql)
      return await getFirst(sql, params)
    }
    return seen
  }

  it('never fetches lockingScript for a noScript caller', async () => {
    const dflt = await seedBasket(BALANCE_BASKET)
    await seedOutput({ status: 'completed', basketId: dflt, satoshis: 1000 })

    const seen = recordSql()
    const outputs = await storage.findOutputs({ partial: { userId: 1 }, noScript: true } as never)

    expect(outputs).toHaveLength(1)
    expect(outputs[0].lockingScript).toBeUndefined()
    // The blob is 959,632 bytes for a vault output — this is the whole point:
    // it must not cross the bridge only to be dropped.
    const rowQuery = seen.find(q => q.includes('FROM "outputs"'))!
    expect(rowQuery).not.toContain('lockingScript')
    expect(rowQuery).toContain('"satoshis"')
    // Projected from the live schema, so a migration's new column still arrives.
    expect(rowQuery).toContain('"customInstructions"')
  })

  it('still returns the script when the caller wants it', async () => {
    const dflt = await seedBasket(BALANCE_BASKET)
    await seedOutput({ status: 'completed', basketId: dflt, satoshis: 1000 })

    const outputs = await storage.findOutputs({ partial: { userId: 1 } } as never)
    expect(outputs[0].lockingScript).toBeDefined()
  })

  it('answers the wallet-balance specOp with an aggregate, not a row scan', async () => {
    const dflt = await seedBasket(BALANCE_BASKET)
    await seedOutput({ status: 'completed', basketId: dflt, satoshis: 1000 })
    await seedOutput({ status: 'unproven', basketId: dflt, satoshis: 234, vout: 1 })

    const seen = recordSql()
    const r = await listOutputsSql(storage, { userId: 1, identityKey: 'k' } as never, {
      basket: sdk.specOpWalletBalance,
      tags: [],
      tagQueryMode: 'any',
      limit: 10,
      offset: 0
    } as never)

    expect(r).toEqual({ totalOutputs: 1234, outputs: [] })
    expect(seen.some(q => q.includes('SUM("satoshis")'))).toBe(true)
    // No query that would pull the rows themselves back into JS.
    expect(seen.some(q => q.startsWith('SELECT *') && q.includes('"outputs"'))).toBe(false)
  })
})
