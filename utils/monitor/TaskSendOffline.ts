/**
 * Releases held offline transactions when the device has signal again.
 *
 * Manually triggered, the same way `TaskCheckForProofs` and `TaskCheckNoSends`
 * are: `trigger` returns true only when `checkNow` has been set, so the task
 * costs nothing while underground and fires promptly on reconnect. The release
 * itself is injected rather than reached through the monitor, which keeps the
 * task testable and keeps the storage wiring in one place.
 */
import { WalletMonitorTask } from '@bsv/wallet-toolbox-mobile/out/src/monitor/tasks/WalletMonitorTask'
import type { Monitor } from '@bsv/wallet-toolbox-mobile'
import type { ProcessOfflineActionsResult } from '@/storage/methods/processOfflineActions'

export class TaskSendOffline extends WalletMonitorTask {
  static taskName = 'SendOffline'
  /** Set by the reconnect listener, and by a manual "send now" control. */
  static checkNow = false

  constructor(
    monitor: Monitor,
    private readonly release: () => Promise<ProcessOfflineActionsResult>
  ) {
    super(monitor, TaskSendOffline.taskName)
  }

  trigger(_nowMsecsSinceEpoch: number): { run: boolean } {
    return { run: TaskSendOffline.checkNow }
  }

  async runTask(): Promise<string> {
    TaskSendOffline.checkNow = false
    try {
      const r = await this.release()
      if (r.sent === 0 && r.rejected === 0 && !r.stalledOn) return ''
      let log = `sent ${r.sent}, rejected ${r.rejected}${r.stopped ? ', stopped early' : ''}`
      // A stall is distinct from the ordinary "signal went away again" stop: it
      // means retrying alone will not help, so it must not go unnoticed.
      if (r.stalledOn) log += ` — stalled: ${r.stalledOn}`
      return `${log}\n`
    } catch (e) {
      // A throw here would take down the monitor's whole run loop.
      return `SendOffline failed: ${e instanceof Error ? e.message : String(e)}\n`
    }
  }
}
