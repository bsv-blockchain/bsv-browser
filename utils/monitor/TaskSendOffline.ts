/**
 * Releases held offline transactions when the device has signal.
 *
 * Two triggers, both gated on the app's single online signal:
 *
 *  · `checkNow` — an immediate pass, set by reconnect (`noteConnectivity`),
 *    by the manual "Send now" control (`requestNow`), and by app foreground.
 *  · a periodic retry — while `hasPending` says the queue may hold releasable
 *    rows, fire every `backoffMs`, starting at 10 s and doubling to a 5 min
 *    cap. Rationale: users do not keep the app open for long, and once there
 *    IS network the first attempt almost always succeeds, so a short first
 *    gap is cheap; the doubling keeps a genuinely stuck queue from spamming
 *    services.
 *
 * All state is static and process-global BY DESIGN: the monitor is torn down
 * and rebuilt on network switches and wallet rebuilds, and a pending queue
 * must survive that. The previous one-shot version of this task lost its one
 * trigger whenever the first drain after reconnect failed — NetInfo often
 * reports online seconds before routes actually work — which is exactly the
 * "payments sit at nosend forever" bug this rewrite removes.
 */
import { WalletMonitorTask } from '@bsv/wallet-toolbox-mobile/out/src/monitor/tasks/WalletMonitorTask'
import type { Monitor } from '@bsv/wallet-toolbox-mobile'
import type { ProcessOfflineActionsResult } from '@/storage/methods/processOfflineActions'

export class TaskSendOffline extends WalletMonitorTask {
  static taskName = 'SendOffline'

  static readonly BASE_BACKOFF_MS = 10_000
  static readonly MAX_BACKOFF_MS = 300_000

  /** An immediate pass has been requested. Consumed at the top of runTask. */
  static checkNow = false
  /** Last observation from the app's single online listener. Gates trigger. */
  static onlineNow = false
  /** The queue may hold releasable rows. Set pessimistically; a clean run clears it. */
  static hasPending = false
  static backoffMs = TaskSendOffline.BASE_BACKOFF_MS
  static nextDueAt = 0
  /**
   * The most recent run's stalledOn, kept for the UI: a stall means retrying
   * alone will not help, and nothing else in the system records it.
   */
  static lastStall: string | undefined

  static noteConnectivity(online: boolean): void {
    TaskSendOffline.onlineNow = online
    if (online) {
      TaskSendOffline.checkNow = true
      TaskSendOffline.backoffMs = TaskSendOffline.BASE_BACKOFF_MS
      TaskSendOffline.nextDueAt = 0
    }
  }

  /** New work exists. Cheap to over-call: one idle drain clears it. */
  static noteEnqueued(): void {
    TaskSendOffline.hasPending = true
    TaskSendOffline.backoffMs = TaskSendOffline.BASE_BACKOFF_MS
    TaskSendOffline.nextDueAt = 0
  }

  /** The user's "Send now". */
  static requestNow(): void {
    TaskSendOffline.checkNow = true
    TaskSendOffline.backoffMs = TaskSendOffline.BASE_BACKOFF_MS
    TaskSendOffline.nextDueAt = 0
  }

  static resetForTests(): void {
    TaskSendOffline.checkNow = false
    TaskSendOffline.onlineNow = false
    TaskSendOffline.hasPending = false
    TaskSendOffline.backoffMs = TaskSendOffline.BASE_BACKOFF_MS
    TaskSendOffline.nextDueAt = 0
    TaskSendOffline.lastStall = undefined
  }

  constructor(
    monitor: Monitor,
    private readonly release: () => Promise<ProcessOfflineActionsResult>,
    private readonly now: () => number = () => Date.now()
  ) {
    super(monitor, TaskSendOffline.taskName)
  }

  trigger(nowMsecsSinceEpoch: number): { run: boolean } {
    if (!TaskSendOffline.onlineNow) return { run: false }
    return {
      run: TaskSendOffline.checkNow || (TaskSendOffline.hasPending && nowMsecsSinceEpoch >= TaskSendOffline.nextDueAt)
    }
  }

  private scheduleRetry(): void {
    TaskSendOffline.hasPending = true
    TaskSendOffline.nextDueAt = this.now() + TaskSendOffline.backoffMs
    TaskSendOffline.backoffMs = Math.min(TaskSendOffline.backoffMs * 2, TaskSendOffline.MAX_BACKOFF_MS)
  }

  async runTask(): Promise<string> {
    TaskSendOffline.checkNow = false
    try {
      const r = await this.release()
      TaskSendOffline.lastStall = r.stalledOn
      if (r.stopped) {
        this.scheduleRetry()
      } else {
        TaskSendOffline.hasPending = false
        TaskSendOffline.backoffMs = TaskSendOffline.BASE_BACKOFF_MS
      }
      if (r.sent === 0 && r.rejected === 0 && !r.stalledOn) return ''
      let log = `sent ${r.sent}, rejected ${r.rejected}${r.stopped ? ', stopped early' : ''}`
      // A stall is distinct from the ordinary "signal went away again" stop: it
      // means retrying alone will not help, so it must not go unnoticed.
      if (r.stalledOn) log += ` — stalled: ${r.stalledOn}`
      return `${log}\n`
    } catch (e) {
      // A throw would take down the monitor's whole run loop — and it is also
      // a failed drain, so it earns a retry rather than silence.
      this.scheduleRetry()
      return `SendOffline failed: ${e instanceof Error ? e.message : String(e)}\n`
    }
  }
}
