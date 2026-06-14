export const NEW_HEADER_POLL_INTERVAL_MS = 60_000
export const NEW_HEADER_FAILURE_BACKOFF_MS = 5 * 60_000

interface NewHeaderTask {
  lastRunMsecsSinceEpoch: number
  triggerMsecs?: number
  trigger: (nowMsecsSinceEpoch: number) => { run: boolean }
  runTask: () => Promise<string>
}

interface NewHeaderPollingOptions {
  now?: () => number
  pollIntervalMs?: number
  failureBackoffMs?: number
  onFailure?: (error: unknown, retryAt: number) => void
}

/**
 * The wallet SDK's TaskNewHeader declares a one-minute interval but its
 * trigger currently returns true on every five-second monitor cycle. Enforce
 * the intended cadence and back off transient Chaintracks gateway failures.
 */
export function configureNewHeaderPolling(task: NewHeaderTask, options: NewHeaderPollingOptions = {}) {
  const now = options.now ?? Date.now
  const pollIntervalMs = options.pollIntervalMs ?? Math.max(task.triggerMsecs ?? 0, NEW_HEADER_POLL_INTERVAL_MS)
  const failureBackoffMs = options.failureBackoffMs ?? NEW_HEADER_FAILURE_BACKOFF_MS
  const originalRunTask = task.runTask.bind(task)
  let retryAt = 0

  task.trigger = (nowMsecsSinceEpoch: number) => ({
    run:
      nowMsecsSinceEpoch >= retryAt &&
      (task.lastRunMsecsSinceEpoch === 0 || nowMsecsSinceEpoch - task.lastRunMsecsSinceEpoch >= pollIntervalMs)
  })

  task.runTask = async () => {
    try {
      const log = await originalRunTask()
      retryAt = 0
      return log
    } catch (error) {
      retryAt = now() + failureBackoffMs
      options.onFailure?.(error, retryAt)
      return ''
    }
  }
}
