import { databaseDirectoryUri } from './fileUris'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { File } from 'expo-file-system'
import { defaultDatabaseDirectory, openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite'
import { PrivateKey } from '@bsv/sdk'
import { type sdk, type Services, WalletStorageManager } from '@bsv/wallet-toolbox-mobile'
import { StorageExpoSQLite } from '@bsv/expo-wallet-toolbox/core/storage/StorageExpoSQLite'
import { WalletDataStorageManager } from './WalletDataStorageManager'
import { archiveStageDigest, exportArchiveStage, loadArchiveJob, newArchiveId, openExistingArchiveDatabase, runArchiveOperation, saveArchiveJob, withVerifiedArchive, type ArchiveJob } from './native'
import { captureSqliteArchive, restoreStageDatabase, verifyArchiveStorageBinding } from './sqliteArchive'
import { checkCancelled, PortabilityError, type ArchiveChain } from './schema'
import { validateArchiveStage } from './staging'


export interface WalletDataBinding {
  databaseName: string; storageIdentityKey: string; activatedAt: string; archiveJobId: string
}
const bindingKey = (chain: ArchiveChain, identityKey: string) => `wallet.portability.primary.v1:${chain}:${identityKey}`
export async function loadWalletDataBinding(chain: ArchiveChain, identityKey: string): Promise<WalletDataBinding | undefined> {
  const json = await AsyncStorage.getItem(bindingKey(chain, identityKey))
  if (!json) return undefined
  try {
    const value = JSON.parse(json)
    if (!value || typeof value.databaseName !== 'string' || !/^wallet-recovery-[a-f0-9]{32}\.db$/.test(value.databaseName) || !/^[a-f0-9]{64}$/.test(value.storageIdentityKey)) throw new Error('binding')
    return value
  } catch { throw new PortabilityError('storage', 'saved primary selection requires recovery') }
}

class CheckedNativeStorage extends StorageExpoSQLite {
  override async processSyncChunk(...args: Parameters<StorageExpoSQLite['processSyncChunk']>): ReturnType<StorageExpoSQLite['processSyncChunk']> {
    const result = await super.processSyncChunk(...args)
    if (!result || result.error || !Number.isSafeInteger(result.inserts) || !Number.isSafeInteger(result.updates)) throw new PortabilityError('storage', 'synchronization page')
    return result
  }
}

async function nativeProvider(name: string, chain: ArchiveChain, storageIdentityKey: string, existing: boolean, identityKey?: string): Promise<StorageExpoSQLite> {
  if (existing !== new File(databaseDirectoryUri(defaultDatabaseDirectory), name).exists) throw new PortabilityError('storage', existing ? 'saved wallet database missing' : 'new database already exists')
  if (existing) {
    const check = await openExistingArchiveDatabase(name)
    try {
      await verifyArchiveStorageBinding(check, chain, storageIdentityKey, identityKey)
    } finally { await check.closeAsync() }
  }
  const provider = new CheckedNativeStorage({ databaseName: name, chain, commissionSatoshis: 0, feeModel: { model: 'sat/kb', value: 100 } })
  try {
    await provider.migrate('BSV Browser device wallet data', storageIdentityKey)
    await provider.makeAvailable()
    return provider
  } catch (error) { await provider.destroy(); throw error }
}
export const openBoundWalletData = (binding: WalletDataBinding, chain: ArchiveChain, identityKey: string) => nativeProvider(binding.databaseName, chain, binding.storageIdentityKey, true, identityKey)

async function materializeArchive(stage: SQLiteDatabase, chain: ArchiveChain, report: (message: string) => void, signal?: AbortSignal) {
  const name = `wallet-recovery-${newArchiveId()}.db`, key = PrivateKey.fromRandom().toHex()
  const db = await openDatabaseAsync(name)
  try { await restoreStageDatabase(stage, db, key, report, signal) }
  finally { await db.closeAsync() }
  return { name, key, provider: await nativeProvider(name, chain, key, true) }
}

export async function restoreSeparateWalletCopy(id: string, report: (message: string) => void, signal?: AbortSignal): Promise<ArchiveJob> {
  return await runArchiveOperation(() => withVerifiedArchive(id, async (stage, job) => {
    if (job.state === 'merging' || job.state === 'activating') throw new PortabilityError('busy')
    const copy = await materializeArchive(stage, job.summary!.chain, report, signal)
    await copy.provider.destroy()
    return await saveArchiveJob({ ...job, state: 'restored', recoveryDatabaseName: copy.name })
  }, signal))
}

/** A file never supplies signing authority. Before sign-in this only creates a
 * binding for its exact identity/network; matching recovered keys are still required. */
export async function activateRestoredWalletData(id: string, chain: ArchiveChain, report: (message: string) => void, signal?: AbortSignal, session?: WalletDataSession): Promise<void> {
  return await runArchiveOperation(() => withVerifiedArchive(id, async (stage, job) => {
    if (job.summary!.chain !== chain || (session && job.summary!.identityKey !== session.identityKey)) throw new PortabilityError('identity')
    if (job.state === 'merging') throw new PortabilityError('busy')
    const copy = await materializeArchive(stage, chain, report, signal)
    try {
      const identityKey = job.summary!.identityKey
      const user = await copy.provider.findUserByIdentityKey(identityKey)
      if (!user) throw new PortabilityError('identity')
      await copy.provider.setActive({ identityKey, userId: user.userId }, copy.key)
      await copy.provider.checkpointWal()
      const binding: WalletDataBinding = { databaseName: copy.name, storageIdentityKey: copy.key, activatedAt: new Date().toISOString(), archiveJobId: id }
      await saveArchiveJob({ ...job, state: 'activating', recoveryDatabaseName: copy.name })
      const commit = async () => {
        checkCancelled(signal)
        await AsyncStorage.setItem(bindingKey(chain, identityKey), JSON.stringify(binding))
        await saveArchiveJob({ ...job, state: 'active', recoveryDatabaseName: copy.name })
      }
      if (session) await session.closeForActivation(commit)
      else await commit()
    } finally { await copy.provider.destroy() }
  }, signal))
}

export class WalletDataSession {
  private readonly controller = new AbortController()
  private closePromise?: Promise<void>
  constructor(readonly identityKey: string, readonly chain: ArchiveChain, readonly manager: WalletDataStorageManager, readonly primary: sdk.WalletStorageProvider, private readonly services: Services, private readonly lifecycle: { pause(): Promise<() => void>; stop(): Promise<void> }) {}
  private async stopMonitoring(): Promise<void> { await this.lifecycle.stop() }
  get isDevicePrimary(): boolean { return this.primary instanceof StorageExpoSQLite }

  async close(): Promise<void> {
    if (this.closePromise) { await this.closePromise; return }
    this.controller.abort()
    this.closePromise = (async () => {
      await this.stopMonitoring()
      await this.manager.closeForRestore(async () => {
        if (this.primary instanceof StorageExpoSQLite) await this.primary.destroy()
      })
    })()
    await this.closePromise
  }
  async closeForActivation(commit: () => Promise<void>): Promise<void> {
    if (this.closePromise) throw new PortabilityError('busy')
    this.controller.abort()
    this.closePromise = (async () => {
      await this.stopMonitoring()
      await this.manager.closeForRestore(async () => {
        if (this.primary instanceof StorageExpoSQLite) await this.primary.destroy()
        await commit()
      })
    })()
    await this.closePromise
  }
  private async operation<T>(signal: AbortSignal | undefined, callback: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return await runArchiveOperation(async () => {
      const controller = new AbortController(), abort = () => controller.abort()
      if (signal?.aborted || this.controller.signal.aborted) abort()
      signal?.addEventListener('abort', abort, { once: true })
      this.controller.signal.addEventListener('abort', abort, { once: true })
      let resume: (() => void) | undefined
      try {
        checkCancelled(controller.signal)
        resume = await this.lifecycle.pause()
        checkCancelled(controller.signal)
        return await callback(controller.signal)
      }
      finally {
        if (!this.controller.signal.aborted) resume?.()
 signal?.removeEventListener('abort', abort); this.controller.signal.removeEventListener('abort', abort) }
    })
  }

  /** Caller holds the access queue through sync AND capture. A remote's own
   * internal sync history is not exposed; this captures the synchronized copy. */
  private async snapshot(active: sdk.WalletStorageSync, report: (message: string) => void, signal: AbortSignal): Promise<{ name: string; db: SQLiteDatabase }> {
    checkCancelled(signal)
    let copy: StorageExpoSQLite | undefined
    let source: SQLiteDatabase | undefined
    let stage: SQLiteDatabase | undefined
    try {
      let name: string
      if (this.primary instanceof StorageExpoSQLite) name = this.primary.dbName
      else {
        name = `wallet-sync-${newArchiveId()}.db`
        const key = PrivateKey.fromRandom().toHex()
        copy = await nativeProvider(name, this.chain, key, false)
        const user = (await copy.findOrInsertUser(this.identityKey)).user
        await copy.setActive({ identityKey: this.identityKey, userId: user.userId }, this.manager.getActiveStore())
        const reader = active.getSyncChunk.bind(active)
        // Scope the temporary reader wrapper to the held queue and restore it.
        active.getSyncChunk = async args => {
          checkCancelled(signal)
          const chunk = await reader({ ...args, maxRoughSize: Math.min(args.maxRoughSize, 2 * 1024 * 1024), maxItems: Math.min(args.maxItems, 250) })
          checkCancelled(signal)
          return chunk
        }
        try {
          report('Synchronizing a complete device copy before export…')
          await this.manager.syncToWriter({ identityKey: this.identityKey, userId: user.userId, isActive: false }, copy, active, undefined, message => { report(message); return message })
        } finally { active.getSyncChunk = reader }
      }
      checkCancelled(signal)
      source = await openDatabaseAsync(name, { useNewConnection: true })
      const stageName = `wallet-snapshot-${newArchiveId()}.db`
      stage = await openDatabaseAsync(stageName)
      await captureSqliteArchive(source, stage, this.identityKey, report, signal)
      const result = { name: stageName, db: stage }
      stage = undefined
      return result
    } finally { await stage?.closeAsync(); await source?.closeAsync(); await copy?.destroy() }
  }

  async export(password: string, report: (message: string) => void, signal?: AbortSignal): Promise<string> {
    return await this.operation(signal, async operationSignal => {
      const snapshot = await this.manager.runAsSync(active => this.snapshot(active, report, operationSignal))
      try { return await exportArchiveStage(snapshot.db, password, report, operationSignal) }
      finally { await snapshot.db.closeAsync() }
    })
  }

  async merge(id: string, report: (message: string) => void, signal?: AbortSignal): Promise<ArchiveJob> {
    return await this.operation(signal, operationSignal => this.manager.runAsSync(async active => {
      let job = await loadArchiveJob(id)
      if (job.summary?.identityKey !== this.identityKey || job.summary.chain !== this.chain) throw new PortabilityError('identity')
      const target = this.manager.getActiveStore()
      let merged: StorageExpoSQLite | undefined
      try {
        if (job.state === 'merging') {
          if (job.target !== target || !job.mergeDatabaseName || !job.mergeDigest || !job.mergeExportedAt) throw new PortabilityError('identity', 'merge destination changed')
          const db = await openExistingArchiveDatabase(job.mergeDatabaseName)
          let settings: { storageIdentityKey: string } | null
          try { settings = await db.getFirstAsync('SELECT storageIdentityKey FROM settings LIMIT 1') } finally { await db.closeAsync() }
          if (!settings) throw new PortabilityError('storage')
          const verification = await openDatabaseAsync(`wallet-merge-check-${newArchiveId()}.db`)
          const reader = await openExistingArchiveDatabase(job.mergeDatabaseName)
          try {
            await captureSqliteArchive(reader, verification, this.identityKey, report, operationSignal, job.mergeExportedAt)
            if (await archiveStageDigest(verification, operationSignal) !== job.mergeDigest) throw new PortabilityError('storage', 'saved merge copy changed')
          } finally { await reader.closeAsync(); await verification.closeAsync() }
          merged = await nativeProvider(job.mergeDatabaseName, this.chain, settings.storageIdentityKey, true)
        } else {
          if (!['ready', 'restored', 'merged'].includes(job.state)) throw new PortabilityError('busy')
          report('Saving a complete recovery point of the current wallet…')
          const before = await this.snapshot(active, report, operationSignal)
          try {
            const beforeDigest = await archiveStageDigest(before.db, operationSignal)
            const mutable = await materializeArchive(before.db, this.chain, report, operationSignal)
            merged = mutable.provider
            const user = await merged.findUserByIdentityKey(this.identityKey)
            if (!user) throw new PortabilityError('identity')
            await merged.setActive({ identityKey: this.identityKey, userId: user.userId }, mutable.key)
            const reconciler = new WalletStorageManager(this.identityKey)
            await reconciler.addWalletStorageProvider(merged)
            await withVerifiedArchive(id, async stage => {
              const incoming = await materializeArchive(stage, this.chain, report, operationSignal)
              try {
                report('Reconciling the import in a separate device copy…')
                await reconciler.syncFromReader(this.identityKey, incoming.provider)
              } finally { await incoming.provider.destroy() }
            }, operationSignal)
            const verification = await openDatabaseAsync(`wallet-merge-check-${newArchiveId()}.db`)
            const reader = await openDatabaseAsync(mutable.name, { useNewConnection: true })
            const mergeExportedAt = new Date().toISOString()
            let mergeDigest: string
            try {
              await captureSqliteArchive(reader, verification, this.identityKey, report, operationSignal, mergeExportedAt)
              await validateArchiveStage(verification, operationSignal)
              mergeDigest = await archiveStageDigest(verification, operationSignal)
            }
            finally { await reader.closeAsync(); await verification.closeAsync() }
            job = await saveArchiveJob({ ...job, state: 'merging', beforeDatabaseName: before.name, beforeDigest, mergeDatabaseName: mutable.name, mergeDigest, mergeExportedAt, target })
          } finally { await before.db.closeAsync() }
        }
        checkCancelled(operationSignal)
        report('Merging verified records into the current wallet. Completed pages are resumable…')
        const original = merged.getSyncChunk.bind(merged)
        merged.getSyncChunk = async args => { checkCancelled(operationSignal); return await original({ ...args, maxItems: Math.min(args.maxItems, 250), maxRoughSize: Math.min(args.maxRoughSize, 2 * 1024 * 1024) }) }
        await this.manager.syncFromReader(this.identityKey, merged, active)
        checkCancelled(operationSignal)
        return await saveArchiveJob({ ...job, state: 'merged', error: undefined })
      } finally { await merged?.destroy() }
    }))
  }
}
