/**
 * Pushes wallet-database deltas to the encrypted backup log.
 *
 * Triggering mirrors TaskSendOffline: gated on the app's single online signal, with an
 * immediate pass when something changes and exponential backoff after failures.
 *
 * All state is static and process-global BY DESIGN. The monitor is torn down and rebuilt on
 * network switches and wallet rebuilds, and backup progress — particularly the backoff after
 * a failing server — must survive that. A per-instance version would reset its backoff every
 * rebuild and hammer a service that is down.
 *
 * The work itself is deliberately small. Monitor tasks run back-to-back with no yielding, so
 * a pass takes at most one chunk and the interval floor keeps it off the JS thread the rest
 * of the time.
 */
import { WalletMonitorTask } from '@bsv/wallet-toolbox-mobile/out/src/monitor/tasks/WalletMonitorTask'
import type { Monitor } from '@bsv/wallet-toolbox-mobile'
import { MIN_PUSH_INTERVAL_MS } from '../backup/constants'
import type { PushResult } from '../backup/push'

export class TaskBackupPush extends WalletMonitorTask {
  static taskName = 'BackupPush'

  static readonly BASE_BACKOFF_MS = 30_000
  static readonly MAX_BACKOFF_MS = 900_000

  /**
   * Re-check even when nothing has announced a change.
   *
   * `noteChanged` is wired to the paths we know about, but the wallet database can be
   * written by paths that do not announce themselves — a dApp creating an action produces
   * no status *transition*, so the Monitor's onTransactionStatusChanged never fires for it.
   * Rather than depend on having found every writer, this floor guarantees the log
   * converges: the cost of a needless check is one local getSyncChunk that returns empty.
   */
  static readonly IDLE_RECHECK_MS = 300_000

  /** Last observation from the app's online listener. Gates the trigger entirely. */
  static onlineNow = false
  /** The database may hold un-pushed changes. Set pessimistically; a clean pass clears it. */
  static hasChanges = false
  /** An immediate pass has been requested. Consumed at the top of runTask. */
  static checkNow = false
  /** Earliest time the next pass may run. */
  static nextDueAt = 0
  /** When the last pass started, for the idle re-check floor. */
  static lastRunAt = 0
  static backoffMs = TaskBackupPush.BASE_BACKOFF_MS
  /** Last error, kept so settings can show why backups are not progressing. */
  static lastError: string | undefined
  /** Time of the last successful pass, for the backup-health display. */
  static lastSuccessAt: number | undefined

  static noteConnectivity (online: boolean): void {
    TaskBackupPush.onlineNow = online
    if (online) {
      TaskBackupPush.checkNow = true
      TaskBackupPush.backoffMs = TaskBackupPush.BASE_BACKOFF_MS
      TaskBackupPush.nextDueAt = 0
    }
  }

  /** New wallet activity. Cheap to over-call: one idle pass clears the flag. */
  static noteChanged (): void {
    TaskBackupPush.hasChanges = true
  }

  /** User asked for an immediate backup. */
  static requestNow (): void {
    TaskBackupPush.checkNow = true
    TaskBackupPush.backoffMs = TaskBackupPush.BASE_BACKOFF_MS
    TaskBackupPush.nextDueAt = 0
  }

  static noteRan (at: number): void {
    TaskBackupPush.nextDueAt = at + MIN_PUSH_INTERVAL_MS
    TaskBackupPush.lastRunAt = at
  }

  static noteFailure (at: number): void {
    TaskBackupPush.nextDueAt = at + TaskBackupPush.backoffMs
    TaskBackupPush.backoffMs = Math.min(
      TaskBackupPush.backoffMs * 2,
      TaskBackupPush.MAX_BACKOFF_MS
    )
  }

  /** Test seam; also used when the user signs out. */
  static reset (): void {
    TaskBackupPush.onlineNow = false
    TaskBackupPush.hasChanges = false
    TaskBackupPush.checkNow = false
    TaskBackupPush.nextDueAt = 0
    TaskBackupPush.lastRunAt = 0
    TaskBackupPush.backoffMs = TaskBackupPush.BASE_BACKOFF_MS
    TaskBackupPush.lastError = undefined
    TaskBackupPush.lastSuccessAt = undefined
  }

  constructor (
    monitor: Monitor,
    private readonly push: () => Promise<PushResult>
  ) {
    super(monitor, TaskBackupPush.taskName)
  }

  trigger (nowMsecsSinceEpoch: number): { run: boolean } {
    if (!TaskBackupPush.onlineNow) return { run: false }
    if (TaskBackupPush.checkNow) return { run: true }
    if (TaskBackupPush.hasChanges) {
      return { run: nowMsecsSinceEpoch >= TaskBackupPush.nextDueAt }
    }
    // Safety net for writers that never announced themselves.
    return { run: nowMsecsSinceEpoch >= TaskBackupPush.lastRunAt + TaskBackupPush.IDLE_RECHECK_MS }
  }

  async runTask (): Promise<string> {
    TaskBackupPush.checkNow = false
    const startedAt = Date.now()

    try {
      const r = await this.push()
      TaskBackupPush.noteRan(startedAt)
      TaskBackupPush.backoffMs = TaskBackupPush.BASE_BACKOFF_MS
      TaskBackupPush.lastError = undefined
      TaskBackupPush.lastSuccessAt = startedAt

      // A window that closed with nothing to send means the log has caught up. Anything
      // else means there is more to drain, so keep the flag set for the next pass.
      if (r.windowClosed && r.pushed === 0) {
        TaskBackupPush.hasChanges = false
      } else {
        TaskBackupPush.checkNow = true
      }

      return r.pushed > 0 ? `backup: pushed 1 chunk, ${r.bytes} bytes` : ''
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      TaskBackupPush.lastError = message
      TaskBackupPush.noteFailure(startedAt)
      return `backup: push failed, retrying after ${TaskBackupPush.backoffMs}ms: ${message}`
    }
  }
}
