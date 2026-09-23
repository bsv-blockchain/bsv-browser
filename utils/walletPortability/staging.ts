import type { SQLiteDatabase } from 'expo-sqlite'
import { ARCHIVE_TABLES, checkCancelled, PortabilityError, type ArchiveRow, type ArchiveSummary, type ArchiveTable } from './schema'
import type { ArchiveEvent } from './streamParser'

// Plaintext stays in an isolated app-private database. This database is never
// enrolled in a wallet manager, and only authenticated, validated jobs are ready.
export async function initializeArchiveStage(db: SQLiteDatabase): Promise<void> {
  await db.execAsync(`
    PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE archive_metadata (name TEXT PRIMARY KEY NOT NULL, json TEXT NOT NULL);
    CREATE TABLE archive_tables (name TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE archive_rows (name TEXT NOT NULL, ordinal INTEGER NOT NULL, rowKey TEXT NOT NULL, json TEXT NOT NULL,
      PRIMARY KEY(name, ordinal), UNIQUE(name, rowKey));
    CREATE TABLE archive_refs (name TEXT NOT NULL, ordinal INTEGER NOT NULL, field TEXT NOT NULL, value TEXT NOT NULL);
    CREATE INDEX archive_refs_lookup ON archive_refs(name, field, value);
  `)
}

const referenceFields = new Set(['userId', 'transactionId', 'provenTxId', 'basketId', 'spentBy', 'outputId', 'outputTagId', 'txLabelId', 'certificateId', 'txid'])
export async function storeArchiveEvents(db: SQLiteDatabase, events: ArchiveEvent[]): Promise<void> {
  if (!events.length) return
  await db.execAsync('BEGIN IMMEDIATE')
  try {
    for (const event of events) {
      if (event.kind === 'metadata') await db.runAsync('INSERT INTO archive_metadata(name,json) VALUES (?,?)', event.key, event.json)
      else if (event.kind === 'table') await db.runAsync('INSERT INTO archive_tables(name) VALUES (?)', event.table)
      else {
        await db.runAsync('INSERT INTO archive_rows(name,ordinal,rowKey,json) VALUES (?,?,?,?)', event.table, event.ordinal, event.rowKey, event.json)
        const row = JSON.parse(event.json) as ArchiveRow
        const refs = [...referenceFields].filter(field => row[field] !== undefined)
        if (refs.length) await db.runAsync(
          'INSERT INTO archive_refs(name,ordinal,field,value) VALUES ' + refs.map(() => '(?,?,?,?)').join(','),
          ...refs.flatMap(field => [event.table, event.ordinal, field, JSON.stringify(row[field])])
        )
      }
    }
    await db.execAsync('COMMIT')
  } catch (error) { await db.execAsync('ROLLBACK'); throw error }
}

export async function archiveMetadata(db: SQLiteDatabase): Promise<Record<string, any>> {
  const metadata = await db.getAllAsync<{ name: string; json: string }>('SELECT name,json FROM archive_metadata')
  return Object.fromEntries(metadata.map(row => [row.name, JSON.parse(row.json)]))
}

const references: Array<[ArchiveTable, string, ArchiveTable, string]> = [
  ['transactions', 'provenTxId', 'provenTxs', 'provenTxId'],
  ['outputs', 'transactionId', 'transactions', 'transactionId'],
  ['outputs', 'spentBy', 'transactions', 'transactionId'],
  ['outputs', 'basketId', 'outputBaskets', 'basketId'],
  ['commissions', 'transactionId', 'transactions', 'transactionId'],
  ['outputTagMaps', 'outputId', 'outputs', 'outputId'],
  ['outputTagMaps', 'outputTagId', 'outputTags', 'outputTagId'],
  ['txLabelMaps', 'transactionId', 'transactions', 'transactionId'],
  ['txLabelMaps', 'txLabelId', 'txLabels', 'txLabelId'],
  ['certificateFields', 'certificateId', 'certificates', 'certificateId'],
  ['provenTxReqs', 'provenTxId', 'provenTxs', 'provenTxId'],
  ['provenTxReqs', 'txid', 'transactions', 'txid']
]

/** SQL-backed closure checks retain only small identifiers in memory, even when
 * raw transactions and proofs comprise hundreds of megabytes. */
export async function validateArchiveStage(db: SQLiteDatabase, signal?: AbortSignal): Promise<ArchiveSummary> {
  const meta = await archiveMetadata(db)
  if (Object.keys(meta).length !== 6 || !meta.user || !meta.sourceStorage) throw new PortabilityError('invalid', 'metadata')
  const ends = await db.getAllAsync<{ name: string }>('SELECT name FROM archive_tables')
  if (ends.length !== ARCHIVE_TABLES.length || ends.some(row => !ARCHIVE_TABLES.includes(row.name as ArchiveTable))) throw new PortabilityError('invalid', 'categories')
  const otherUser = await db.getFirstAsync('SELECT 1 FROM archive_refs WHERE field=? AND value<>? LIMIT 1', 'userId', JSON.stringify(meta.user.userId))
  if (otherUser) throw new PortabilityError('invalid', 'record ownership')
  for (const [table, field, target, targetField] of references) {
    checkCancelled(signal)
    const missing = await db.getFirstAsync(`SELECT 1 FROM archive_refs src
      WHERE src.name=? AND src.field=? AND NOT EXISTS
      (SELECT 1 FROM archive_refs dst WHERE dst.name=? AND dst.field=? AND dst.value=src.value) LIMIT 1`, table, field, target, targetField)
    if (missing) throw new PortabilityError('invalid', `${table}.${field} reference`)
  }
  const counts = Object.fromEntries(ARCHIVE_TABLES.map(table => [table, 0])) as ArchiveSummary['counts']
  for (const row of await db.getAllAsync<{ name: ArchiveTable; count: number }>('SELECT name,COUNT(*) AS count FROM archive_rows GROUP BY name')) counts[row.name] = row.count
  const pending = await db.getFirstAsync<{ count: number }>(`SELECT COUNT(*) AS count FROM archive_rows WHERE name='transactions'
    AND json_extract(json,'$.status') IN ('unprocessed','unsigned','nosend','unproven','sending')`)
  return {
    identityKey: meta.user.identityKey, chain: meta.sourceStorage.chain, exportedAt: meta.exportedAt,
    sourceName: meta.sourceStorage.storageName, sourceIdentity: meta.sourceStorage.storageIdentityKey,
    counts, totalRecords: Object.values(counts).reduce((total, value) => total + value, 0), pendingTransactions: pending?.count ?? 0
  }
}

export async function* archiveRows(db: SQLiteDatabase, table: ArchiveTable, signal?: AbortSignal): AsyncGenerator<ArchiveRow> {
  // One record per page bounds memory by the largest individual record rather
  // than by maxItems times its size. Native iterators finalize on early return.
  for await (const row of db.getEachAsync<{ json: string }>('SELECT json FROM archive_rows WHERE name=? ORDER BY ordinal', table)) {
    checkCancelled(signal)
    yield JSON.parse(row.json)
  }
}

/** RFC 8785 top-level and table-key order, serialized in bounded row strings. */
export async function* canonicalStageBytes(db: SQLiteDatabase, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder()
  const meta = new Map((await db.getAllAsync<{ name: string; json: string }>('SELECT name,json FROM archive_metadata')).map(row => [row.name, row.json]))
  yield encoder.encode('{')
  const keys = [...meta.keys(), 'tables'].sort()
  for (let index = 0; index < keys.length; index++) {
    checkCancelled(signal)
    const key = keys[index]
    yield encoder.encode((index ? ',' : '') + JSON.stringify(key) + ':')
    if (key !== 'tables') yield encoder.encode(meta.get(key)!)
    else {
      yield encoder.encode('{')
      const tables = [...ARCHIVE_TABLES].sort()
      for (let tableIndex = 0; tableIndex < tables.length; tableIndex++) {
        const table = tables[tableIndex]
        yield encoder.encode((tableIndex ? ',' : '') + JSON.stringify(table) + ':[')
        let rowIndex = 0
        for await (const row of db.getEachAsync<{ json: string }>('SELECT json FROM archive_rows WHERE name=? ORDER BY ordinal', table)) {
          checkCancelled(signal)
          if (rowIndex++) yield encoder.encode(',')
          yield encoder.encode(row.json)
        }
        yield encoder.encode(']')
      }
      yield encoder.encode('}')
    }
  }
  yield encoder.encode('}')
}
