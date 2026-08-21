/**
 * Rewrites full-size R1-K1 blobs left by older builds into their compressed
 * form, one row per monitor pass.
 *
 * Companion to the write hooks in StorageExpoSQLite: hooks keep new rows
 * compressed, this retires the old ones. One row per pass because compressing
 * a ~960 KB transaction is synchronous CPU work and monitor tasks run
 * back-to-back without yielding — same discipline as TaskBackupPush.
 *
 * Static state is process-global by design (the monitor is rebuilt on network
 * switches); a rebuilt instance must not restart the scan from "maybe there is
 * work" every time once a full scan has come up empty.
 */
import { WalletMonitorTask } from '@bsv/wallet-toolbox-mobile/out/src/monitor/tasks/WalletMonitorTask'
import type { Monitor } from '@bsv/wallet-toolbox-mobile'
import { releaseTemplateCache } from '@/services/vault/templateCodec'
import type { CompactionStep } from '@/storage/methods/compressAtRest'

export class TaskCompressAtRest extends WalletMonitorTask {
  static taskName = 'CompressAtRest'

  /** Space between rows: enough for the UI to breathe between CPU bursts. */
  static readonly ROW_INTERVAL_MS = 15_000
  /** Once drained, re-probe occasionally — a restore can replay old rows. */
  static readonly IDLE_RECHECK_MS = 6 * 3_600_000

  /** False once a pass finds nothing to do; a restore or sign-in resets it. */
  static maybePending = true
  static nextDueAt = 0
  static lastDrainedAt = 0
  static rowsCompacted = 0

  /** New rows may have arrived at full size (a restore replaying an old log). */
  static notePossibleWork (): void {
    TaskCompressAtRest.maybePending = true
    TaskCompressAtRest.nextDueAt = 0
  }

  /** Test seam. */
  static reset (): void {
    TaskCompressAtRest.maybePending = true
    TaskCompressAtRest.nextDueAt = 0
    TaskCompressAtRest.lastDrainedAt = 0
    TaskCompressAtRest.rowsCompacted = 0
  }

  constructor (
    monitor: Monitor,
    private readonly compact: () => Promise<CompactionStep | undefined>
  ) {
    super(monitor, TaskCompressAtRest.taskName)
  }

  trigger (nowMsecsSinceEpoch: number): { run: boolean } {
    if (TaskCompressAtRest.maybePending) {
      return { run: nowMsecsSinceEpoch >= TaskCompressAtRest.nextDueAt }
    }
    return {
      run: nowMsecsSinceEpoch >= TaskCompressAtRest.lastDrainedAt + TaskCompressAtRest.IDLE_RECHECK_MS
    }
  }

  async runTask (): Promise<string> {
    const startedAt = Date.now()
    let step: CompactionStep | undefined
    try {
      step = await this.compact()
    } finally {
      // The codec's reference cache costs ~1 MB while held. One row per pass
      // means one inflate per row either way, and holding it between passes
      // would keep the megabyte through the 15 s gaps for no benefit.
      releaseTemplateCache()
    }

    if (!step) {
      TaskCompressAtRest.maybePending = false
      TaskCompressAtRest.lastDrainedAt = startedAt
      return ''
    }

    TaskCompressAtRest.rowsCompacted += 1
    TaskCompressAtRest.nextDueAt = startedAt + TaskCompressAtRest.ROW_INTERVAL_MS
    return (
      `compressed ${step.table}.${step.column} id=${step.id} · ` +
      `${step.before} -> ${step.after} bytes · total this process=${TaskCompressAtRest.rowsCompacted}`
    )
  }
}
