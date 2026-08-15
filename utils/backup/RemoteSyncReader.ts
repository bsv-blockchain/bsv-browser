/**
 * Restore side of the backup log.
 *
 * `WalletStorageSyncReader` is a two-method interface, and that is the entire restore
 * contract — so replaying an encrypted log into a fresh database needs no changes to the
 * toolbox at all. `WalletStorageManager.syncFromReader` drives this exactly as it would
 * drive a live remote storage provider.
 */
import type { CompletedProtoWallet } from '@bsv/sdk'
import type {
  RequestSyncChunkArgs,
  SyncChunk
} from '@bsv/wallet-toolbox-mobile/out/src/sdk/WalletStorage.interfaces'
import type { TableSettings } from '@bsv/wallet-toolbox-mobile/out/src/storage/schema/tables'
import type { BackupClient, LogEntry } from './client'
import { decodeChunk, emptyChunk } from './codec'

export class BackupChainError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'BackupChainError'
  }
}

export class RemoteSyncReader {
  private entries: LogEntry[] | null = null
  private next = 0

  constructor (
    private readonly client: BackupClient,
    private readonly wallet: CompletedProtoWallet,
    private readonly deviceId: string,
    private readonly generation: number,
    private readonly settings: TableSettings
  ) {}

  /** Settings for the storage being restored into. */
  async makeAvailable (): Promise<TableSettings> {
    return this.settings
  }

  /**
   * Return the next chunk in sequence.
   *
   * `args` is ignored deliberately: a live reader would honour `since` and `offsets`, but a
   * log is an ordered recording of chunks that were already produced against those very
   * arguments. Replaying them in order reproduces the original stream exactly, and second
   * -guessing it would risk skipping records.
   */
  async getSyncChunk (_args: RequestSyncChunkArgs): Promise<SyncChunk> {
    if (this.entries == null) {
      this.entries = await this.client.index(this.deviceId, this.generation)
      this.verifyChain(this.entries)
    }

    if (this.next >= this.entries.length) {
      // All twelve arrays present and empty: the completion sentinel.
      return emptyChunk(this.deviceId, this.settings.storageIdentityKey, '')
    }

    const entry = this.entries[this.next++]
    const ciphertext = await this.client.blob(this.deviceId, this.generation, entry.seq)
    return await decodeChunk(this.wallet, ciphertext)
  }

  /** Number of chunks in this generation, once the index has been read. */
  get length (): number {
    return this.entries?.length ?? 0
  }

  /**
   * Reject a log with a gap or a fork before any of it is replayed.
   *
   * A restore that silently stops halfway is worse than one that fails: the wallet would
   * look healthy while missing the outputs it needs to spend.
   */
  private verifyChain (entries: LogEntry[]): void {
    for (let i = 0; i < entries.length; i++) {
      const expectedSeq = i + 1
      if (entries[i].seq !== expectedSeq) {
        throw new BackupChainError(
          `backup chain has a gap: expected sequence ${expectedSeq}, found ${entries[i].seq}`
        )
      }
      if (i > 0 && entries[i].prevSha256 !== entries[i - 1].sha256) {
        throw new BackupChainError(
          `backup chain is forked at sequence ${entries[i].seq}: previous hash does not match`
        )
      }
    }
  }
}
