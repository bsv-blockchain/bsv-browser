import { databaseDirectoryUri } from './fileUris'
import { Buffer } from '@craftzdog/react-native-buffer'
import { Directory, File, Paths } from 'expo-file-system'
import { openDatabaseAsync, defaultDatabaseDirectory, type SQLiteDatabase } from 'expo-sqlite'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'react-native-quick-crypto'
import { installNativeArgon2idBackend } from '../nativeArgon2'
import { checkArchiveSize, checkCancelled, PortabilityError, type ArchiveSummary } from './schema'
import { ArchiveStreamParser } from './streamParser'
import { decodeArchiveStream, encodeArchiveStream, FILE_CHUNK_BYTES, type ArchiveCrypto } from './streamCrypto'
import { canonicalStageBytes, initializeArchiveStage, storeArchiveEvents, validateArchiveStage } from './staging'

export interface ArchiveJob {
  id: string
  state: 'preparing' | 'ready' | 'restored' | 'merging' | 'merged' | 'activating' | 'active' | 'interrupted'
  createdAt: string
  fileName: string
  fileBytes: number
  originalUri: string
  databaseName: string
  format?: 'brc38' | 'brc39'
  digest?: string
  summary?: ArchiveSummary
  recoveryDatabaseName?: string
  beforeDatabaseName?: string
  beforeDigest?: string
  mergeDatabaseName?: string
  mergeDigest?: string
  mergeExportedAt?: string
  target?: string
  error?: string
}
const folder = () => {
  const directory = new Directory(Paths.document, 'wallet-portability-v1')
  directory.create({ idempotent: true, intermediates: true })
  return directory
}
export const newArchiveId = () => randomBytes(16).toString('hex')
function relocateArchiveJob(job: ArchiveJob): ArchiveJob {
  if (!/^[a-f0-9]{32}$/.test(job.id)) throw new PortabilityError('storage', 'invalid recovery identifier')
  // iOS may move the app container during an update. Resolve retained files
  // from the stable journal ID inside today's document directory, never the
  // absolute URI recorded by an earlier installation.
  return { ...job, originalUri: new File(folder(), `${job.id}.original`).uri }
}
const yieldTask = () => new Promise<void>(resolve => setTimeout(resolve, 0))
let journalPromise: Promise<SQLiteDatabase> | undefined
function journal(): Promise<SQLiteDatabase> {
  return journalPromise ??= (async () => {
    const db = await openDatabaseAsync('wallet-portability-journal-v1.db')
    await db.execAsync('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY NOT NULL, json TEXT NOT NULL)')
    return db
  })().catch(error => { journalPromise = undefined; throw error })
}
export async function saveArchiveJob(job: ArchiveJob): Promise<ArchiveJob> {
  await (await journal()).runAsync('INSERT OR REPLACE INTO jobs(id,json) VALUES (?,?)', job.id, JSON.stringify(job))
  return job
}
export async function loadArchiveJob(id: string): Promise<ArchiveJob> {
  const row = await (await journal()).getFirstAsync<{ json: string }>('SELECT json FROM jobs WHERE id=?', id)
  if (!row) throw new PortabilityError('storage')
  return relocateArchiveJob(JSON.parse(row.json))
}
export async function listArchiveJobs(): Promise<ArchiveJob[]> {
  const rows = await (await journal()).getAllAsync<{ json: string }>('SELECT json FROM jobs')
  return rows.map(row => relocateArchiveJob(JSON.parse(row.json))).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export interface SavedWalletExport { name: string; uri: string; bytes: number }
/** Only atomically completed encrypted files are offered after a restart.
 * Resolve them in the current container just like retained imports. */
export function listWalletExports(): SavedWalletExport[] {
  return folder().list()
    .filter((file): file is File => file instanceof File && /^wallet-data-\d{4}-\d{2}-\d{2}-[a-f0-9]{8}\.brc39$/.test(file.name))
    .map(file => ({ name: file.name, uri: file.uri, bytes: file.size }))
    .sort((a, b) => b.name.localeCompare(a.name))
}

export const nativeArchiveCrypto: ArchiveCrypto = {
  randomBytes: length => Uint8Array.from(randomBytes(length)),
  deriveKey: async options => {
    const backend = installNativeArgon2idBackend()
    if (!backend) throw new PortabilityError('resources', 'native Argon2id unavailable')
    await backend.preload()
    return await backend.deriveKey(options)
  },
  cipher: (key, nonce, decrypt) => {
    const cipher = decrypt
      ? createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
      : createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
    return {
      update: bytes => cipher.update(bytes), final: () => cipher.final(),
      getAuthTag: () => cipher.getAuthTag(), setAuthTag: tag => { cipher.setAuthTag(Buffer.from(tag)) }
    }
  }
}

export async function archiveStageDigest(db: SQLiteDatabase, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  for await (const bytes of canonicalStageBytes(db, signal)) {
    hash.update(bytes)
    bytes.fill(0)
  }
  return hash.digest('hex')
}

export async function openExistingArchiveDatabase(name: string): Promise<SQLiteDatabase> {
  if (!/^[a-zA-Z0-9_.-]+\.db$/.test(name) || !new File(databaseDirectoryUri(defaultDatabaseDirectory), name).exists) throw new PortabilityError('storage', 'saved recovery database missing')
  return await openDatabaseAsync(name)
}

let running = false
export async function runArchiveOperation<T>(operation: () => Promise<T>): Promise<T> {
  if (running) throw new PortabilityError('busy')
  running = true
  try { return await operation() } finally { running = false }
}

export async function importWalletFile(
  uri: string, fileName: string, password: string, report: (message: string) => void, signal?: AbortSignal
): Promise<ArchiveJob> {
  return await runArchiveOperation(async () => {
    const source = new File(uri)
    checkArchiveSize(source.size)
    const id = newArchiveId(), retained = new File(folder(), `${id}.original`)
    let job: ArchiveJob = { id, state: 'preparing', createdAt: new Date().toISOString(), fileName, fileBytes: source.size, originalUri: retained.uri, databaseName: `wallet-archive-${id}.db` }
    await saveArchiveJob(job)
    let db: SQLiteDatabase | undefined
    try {
      report('Retaining the original file on this device…')
      checkCancelled(signal)
      await source.copy(retained)
      checkArchiveSize(retained.size)
      if (retained.size !== source.size) throw new PortabilityError('storage', 'file copy incomplete')
      db = await openDatabaseAsync(job.databaseName)
      await initializeArchiveStage(db)
      const stage = db
      const parser = new ArchiveStreamParser()
      let format: 'brc38' | 'brc39'
      const handle = retained.open()
      try {
        report('Unlocking and validating the file into a separate copy…')
        let read = 0
        format = await decodeArchiveStream({ size: retained.size, read: (offset, length) => { handle.offset = offset; return handle.readBytes(length) } }, password, nativeArchiveCrypto, async bytes => {
          await storeArchiveEvents(stage, parser.write(bytes))
          read += bytes.length
          report(`Validating ${Math.floor(read / 1024 / 1024).toLocaleString()} MiB…`)
          await yieldTask()
        }, signal)
        await storeArchiveEvents(stage, parser.end())
      } finally { handle.close() }
      report('Verifying all record references and recovery data…')
      const summary = await validateArchiveStage(stage, signal)
      const digest = await archiveStageDigest(stage, signal)
      checkCancelled(signal)
      await stage.execAsync('PRAGMA wal_checkpoint(TRUNCATE)')
      job = await saveArchiveJob({ ...job, state: 'ready', summary, digest, format })
      return job
    } catch (error) {
      // No interrupted or unauthenticated stage is eligible for merge/activation.
      await saveArchiveJob({ ...job, state: 'interrupted', error: error instanceof PortabilityError ? error.message : 'The complete copy could not be saved. Your original file is retained.' })
      throw error
    } finally { await db?.closeAsync() }
  })
}

export async function withVerifiedArchive<T>(id: string, operation: (db: SQLiteDatabase, job: ArchiveJob) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const job = await loadArchiveJob(id)
  if (!job.summary || !job.digest || ['preparing', 'interrupted'].includes(job.state)) throw new PortabilityError('storage', 'unverified import')
  const db = await openExistingArchiveDatabase(job.databaseName)
  try {
    await validateArchiveStage(db, signal)
    if (await archiveStageDigest(db, signal) !== job.digest) throw new PortabilityError('storage', 'recovery copy changed')
    return await operation(db, job)
  } finally { await db.closeAsync() }
}

export async function exportArchiveStage(
  db: SQLiteDatabase, password: string, report: (message: string) => void, signal?: AbortSignal
): Promise<string> {
  await validateArchiveStage(db, signal)
  const id = newArchiveId()
  const temporary = new File(folder(), `${id}.partial`)
  const destination = new File(folder(), `wallet-data-${new Date().toISOString().slice(0, 10)}-${id.slice(0, 8)}.brc39`)
  temporary.create()
  const handle = temporary.open()
  let sinceYield = 0
  try {
    report('Encrypting your wallet data…')
    await encodeArchiveStream(canonicalStageBytes(db, signal), password, nativeArchiveCrypto, async bytes => {
      // Quick Crypto returns a Buffer subclass. Expo's native typed-array
      // bridge identifies kinds by constructor name and cannot accept Buffer.
      // A standard view preserves the exact byte range without copying it.
      handle.writeBytes(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
      sinceYield += bytes.length
      if (sinceYield >= FILE_CHUNK_BYTES) { sinceYield = 0; await yieldTask() }
    }, signal)
    handle.close()
    checkCancelled(signal)
    await temporary.move(destination)
    report('Encrypted file ready to save or share.')
    return destination.uri
  } catch (error) {
    try { handle.close() } catch { /* already closed */ }
    // Only this operation's unpublished partial output is removed.
    if (temporary.exists) temporary.delete()
    throw error
  }
}


export async function exportBeforeMergeRecoveryPoint(id: string, password: string, report: (message: string) => void, signal?: AbortSignal): Promise<string> {
  return await runArchiveOperation(async () => {
    const job = await loadArchiveJob(id)
    if (!job.beforeDatabaseName || !job.beforeDigest) throw new PortabilityError('storage', 'no verified before-merge recovery point')
    const db = await openExistingArchiveDatabase(job.beforeDatabaseName)
    try {
      await validateArchiveStage(db, signal)
      if (await archiveStageDigest(db, signal) !== job.beforeDigest) throw new PortabilityError('storage', 'before-merge recovery point changed')
      return await exportArchiveStage(db, password, report, signal)
    } finally { await db.closeAsync() }
  })
}


export async function exportRetainedWalletImport(id: string, password: string, report: (message: string) => void, signal?: AbortSignal): Promise<string> {
  return await runArchiveOperation(() => withVerifiedArchive(id, async db => await exportArchiveStage(db, password, report, signal), signal))
}
