import { WalletStorageManager, type StorageProvider, type sdk } from '@bsv/wallet-toolbox-mobile'

/** One access queue survives manager replacement and drains requests using old sessions. */
class WalletStorageAccess {
  private tail: Promise<void> = Promise.resolve()
  private closed = false

  async run<R> (operation: () => Promise<R>): Promise<R> {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>(resolve => { release = resolve })
    await previous
    try {
      if (this.closed) throw new Error('Wallet data was restored. Restart the wallet before continuing.')
      return await operation()
    } finally { release() }
  }

  async close (operation: () => Promise<void>): Promise<void> {
    await this.run(async () => { this.closed = true; await operation() })
  }
}

/** A provider may return an error-bearing page instead of throwing. Never
 * advance a recovery merge unless its destination acknowledged that page. */
function checkedSync(provider: sdk.WalletStorageSync): sdk.WalletStorageSync {
  return new Proxy(provider, {
    get(target, property) {
      if (property === 'processSyncChunk') return async (...args: Parameters<sdk.WalletStorageSync['processSyncChunk']>) => {
        const result = await target.processSyncChunk(...args)
        if (!result || result.error || !Number.isSafeInteger(result.inserts) || !Number.isSafeInteger(result.updates)) {
          throw new Error('Wallet storage did not acknowledge a complete synchronization page. Resume from the retained recovery copy.')
        }
        return result
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}

/** Published Toolbox versions identify remotes by constructor name, which bundling/subclassing changes. */
export class WalletDataStorageManager extends WalletStorageManager {
  constructor (
    private readonly walletIdentityKey: string,
    active?: sdk.WalletStorageProvider,
    backups?: sdk.WalletStorageProvider[],
    private readonly access = new WalletStorageAccess()
  ) {
    super(walletIdentityKey, active, backups)
  }

  createSession (): WalletDataStorageManager {
    const next = new WalletDataStorageManager(this.walletIdentityKey, undefined, undefined, this.access)
    next.setServices(this.getServices())
    return next
  }

  /** Drain old requests and fence every session before changing the on-disk binding. */
  async closeForRestore (operation: () => Promise<void>): Promise<void> {
    await this.access.close(operation)
  }

  override async runAsReader<R> (reader: (active: sdk.WalletStorageReader) => Promise<R>): Promise<R> {
    return await this.access.run(async () => super.runAsReader(reader))
  }

  override async runAsWriter<R> (writer: (active: sdk.WalletStorageWriter) => Promise<R>): Promise<R> {
    return await this.access.run(async () => super.runAsWriter(writer))
  }

  override async runAsSync<R> (
    sync: (active: sdk.WalletStorageSync) => Promise<R>, activeSync?: sdk.WalletStorageSync
  ): Promise<R> {
    // Toolbox passes an already-held sync provider to nested merge/copy operations.
    if (activeSync) return await super.runAsSync(active => sync(checkedSync(active)), activeSync)
    return await this.access.run(async () => super.runAsSync(active => sync(checkedSync(active))))
  }

  override async runAsStorageProvider<R> (sync: (active: StorageProvider) => Promise<R>): Promise<R> {
    return await this.access.run(async () => super.runAsStorageProvider(sync))
  }

  override getStoreEndpointURL (store: { storage: sdk.WalletStorageProvider }): string | undefined {
    const url = (store.storage as { endpointUrl?: unknown }).endpointUrl
    return typeof url === 'string' && url.length > 0 ? url : undefined
  }
}

