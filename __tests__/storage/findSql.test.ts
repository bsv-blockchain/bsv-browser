/**
 * SQL construction for the storage read paths.
 *
 * The drift test at the bottom is the load-bearing one: an explicit projection
 * needs a hardcoded column list, and a list that falls behind the schema would
 * silently drop a column from every read that projects.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BLOB_COLUMNS,
  PROVEN_HEIGHTS_SQL,
  TABLE_COLUMNS,
  buildFindSql,
  columnsExcluding,
  rangeReadSql
} from '@/storage/methods/findSql'

describe('columnsExcluding', () => {
  it('returns undefined when nothing is excluded, meaning SELECT *', () => {
    // Callers with no reason to project must generate byte-identical SQL to
    // before this change, or the projection could alter their result rows.
    expect(columnsExcluding('outputs', [])).toBeUndefined()
  })

  it('names every non-excluded column so the blob is never read', () => {
    const cols = columnsExcluding('outputs', ['lockingScript'])!
    expect(cols).not.toContain('lockingScript')
    // The two columns that make the range-read path work must survive: with
    // maxOutputScript = 1024 a vault output stores offsets, not the script.
    expect(cols).toContain('scriptOffset')
    expect(cols).toContain('scriptLength')
    expect(cols).toContain('outputId')
  })

  it('returns undefined for a table it has no column list for', () => {
    expect(columnsExcluding('users', ['nope'])).toBeUndefined()
  })
})

describe('buildFindSql', () => {
  it('emits SELECT * when no column list is given', () => {
    const sql = buildFindSql({ table: 'outputs', whereSql: '', hasSince: false, pkCol: 'outputId' })
    expect(sql).toContain('SELECT * FROM "outputs"')
  })

  it('emits an explicit projection that does not name the blob column', () => {
    const sql = buildFindSql({
      table: 'outputs',
      whereSql: 'WHERE "spendable" = ?',
      hasSince: false,
      pkCol: 'outputId',
      columns: columnsExcluding('outputs', ['lockingScript'])
    })
    expect(sql).not.toMatch(/lockingScript/)
    expect(sql.startsWith('SELECT "outputId"')).toBe(true)
    expect(sql).toContain('WHERE "spendable" = ?')
    expect(sql).toContain('ORDER BY "outputId" ASC')
  })

  it('quotes identifiers, because proven_txs has a column named index', () => {
    const sql = buildFindSql({
      table: 'proven_txs',
      whereSql: '',
      hasSince: false,
      pkCol: 'provenTxId',
      columns: columnsExcluding('proven_txs', ['rawTx', 'merklePath'])
    })
    expect(sql).toContain('"index"')
    expect(sql).not.toMatch(/[^"]index/)
  })

  it('introduces WHERE for since when there is no where clause', () => {
    const sql = buildFindSql({ table: 'transactions', whereSql: '', hasSince: true, pkCol: 'transactionId' })
    expect(sql).toContain('WHERE updated_at >= ?')
  })

  it('preserves since, extra conditions, order and paging exactly as before', () => {
    const sql = buildFindSql({
      table: 'transactions',
      whereSql: 'WHERE "userId" = ?',
      hasSince: true,
      extraConditions: ['status IN (?,?)'],
      pkCol: 'transactionId',
      orderDescending: true,
      limit: 10,
      offset: 5
    })
    expect(sql).toContain('AND updated_at >= ?')
    expect(sql).toContain('AND status IN (?,?)')
    expect(sql).toContain('ORDER BY "transactionId" DESC')
    expect(sql).toContain('LIMIT 10')
    expect(sql).toContain('OFFSET 5')
  })

  it('omits OFFSET when there is no LIMIT, matching the original', () => {
    const sql = buildFindSql({
      table: 'outputs',
      whereSql: '',
      hasSince: false,
      pkCol: 'outputId',
      offset: 20
    })
    expect(sql).not.toContain('OFFSET')
  })
})

describe('rangeReadSql', () => {
  it('filters proven_tx_reqs by the same statuses getProvenOrRawTx accepts', () => {
    // A divergence here would make a range read see a row the full read
    // refuses, or vice versa.
    const sql = rangeReadSql('proven_tx_reqs')
    for (const status of ['unsent', 'unmined', 'unconfirmed', 'sending', 'nosend', 'completed']) {
      expect(sql).toContain(`'${status}'`)
    }
  })

  it('applies no status filter to proven_txs', () => {
    expect(rangeReadSql('proven_txs')).not.toContain('status')
  })
})

describe('PROVEN_HEIGHTS_SQL', () => {
  it('selects only the two columns the height map needs', () => {
    expect(PROVEN_HEIGHTS_SQL).toBe('SELECT txid, height FROM proven_txs')
    expect(PROVEN_HEIGHTS_SQL).not.toMatch(/rawTx|merklePath|\*/)
  })
})

describe('column lists match the schema', () => {
  // Parses createTables.ts rather than trusting the hardcoded lists. A column
  // added to the schema but not here would be silently dropped from every
  // projected read — invisible in any test that does not compare the two.
  const ddl = readFileSync(join(__dirname, '../../storage/schema/createTables.ts'), 'utf8')

  const columnsFromDdl = (table: string): string[] => {
    const create = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n {4}\\);`).exec(ddl)
    if (!create) throw new Error(`no CREATE TABLE found for ${table}`)
    const cols: string[] = []
    for (const rawLine of create[1].split('\n')) {
      const line = rawLine.trim()
      if (!line || /^(FOREIGN KEY|PRIMARY KEY|UNIQUE|CONSTRAINT|CHECK)\b/i.test(line)) continue
      const m = /^"?([A-Za-z_][A-Za-z0-9_]*)"?\s/.exec(line)
      if (m) cols.push(m[1])
    }
    for (const alter of ddl.matchAll(
      new RegExp(`ALTER TABLE ${table} ADD COLUMN "?([A-Za-z_][A-Za-z0-9_]*)"?`, 'g')
    )) {
      if (!cols.includes(alter[1])) cols.push(alter[1])
    }
    return cols
  }

  for (const table of Object.keys(TABLE_COLUMNS)) {
    it(`${table} has exactly the columns the schema declares`, () => {
      expect(TABLE_COLUMNS[table]).toEqual(columnsFromDdl(table))
    })

    it(`${table} blob columns are all real columns`, () => {
      for (const blob of BLOB_COLUMNS[table]) {
        expect(TABLE_COLUMNS[table]).toContain(blob)
      }
    })
  }
})
