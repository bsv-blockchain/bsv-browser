import { TaskBackupPush } from '@/utils/monitor/TaskBackupPush'
import { MIN_PUSH_INTERVAL_MS } from '@/utils/backup/constants'
import type { PushResult } from '@/utils/backup/push'

const monitor = {} as any

const ok = (over: Partial<PushResult> = {}): PushResult => ({
  pushed: 0, bytes: 0, windowClosed: true, rotated: false, ...over
})

function task (push: () => Promise<PushResult> = async () => ok()): TaskBackupPush {
  return new TaskBackupPush(monitor, push)
}

beforeEach(() => { TaskBackupPush.reset() })

describe('TaskBackupPush trigger', () => {
  it('never runs while offline', () => {
    // Pushing offline would burn the backoff on failures the app already knows about.
    TaskBackupPush.noteConnectivity(false)
    TaskBackupPush.noteChanged()
    TaskBackupPush.requestNow()

    expect(task().trigger(Date.now()).run).toBe(false)
  })

  it('runs immediately when connectivity returns', () => {
    TaskBackupPush.noteConnectivity(true)
    expect(task().trigger(Date.now()).run).toBe(true)
  })

  it('does not run when nothing has changed and a pass ran recently', () => {
    TaskBackupPush.noteConnectivity(true)
    const now = Date.now()
    TaskBackupPush.noteRan(now)
    TaskBackupPush.checkNow = false

    expect(task().trigger(now + 1_000).run).toBe(false)
  })

  it('runs when the database has changed and the interval has elapsed', () => {
    TaskBackupPush.noteConnectivity(true)
    TaskBackupPush.checkNow = false
    TaskBackupPush.noteChanged()

    expect(task().trigger(Date.now()).run).toBe(true)
  })

  it('respects the minimum interval between passes', () => {
    // The monitor ticks roughly every five seconds and runs tasks back-to-back without
    // yielding; pushing that often would compete with the UI for the JS thread.
    TaskBackupPush.noteConnectivity(true)
    TaskBackupPush.checkNow = false
    TaskBackupPush.noteChanged()

    const now = Date.now()
    const t = task()
    expect(t.trigger(now).run).toBe(true)

    TaskBackupPush.noteRan(now)
    expect(t.trigger(now + 5_000).run).toBe(false)
    expect(t.trigger(now + MIN_PUSH_INTERVAL_MS + 1).run).toBe(true)
  })

  it('honours an explicit request even inside the interval', () => {
    TaskBackupPush.noteConnectivity(true)
    const now = Date.now()
    TaskBackupPush.noteRan(now)
    TaskBackupPush.requestNow()

    expect(task().trigger(now + 1_000).run).toBe(true)
  })

  it('re-checks eventually even when nothing announced a change', () => {
    // Regression: a dApp creating an action writes rows but produces no status
    // *transition*, so the Monitor's onTransactionStatusChanged never fires and hasChanges
    // stays false. Observed live — a wallet created an event ticket and the chunk was never
    // pushed. The idle floor guarantees the log converges regardless of which writer ran.
    TaskBackupPush.noteConnectivity(true)
    const now = Date.now()
    TaskBackupPush.noteRan(now)
    TaskBackupPush.checkNow = false
    TaskBackupPush.hasChanges = false

    expect(task().trigger(now + 60_000).run).toBe(false)
    expect(task().trigger(now + TaskBackupPush.IDLE_RECHECK_MS + 1).run).toBe(true)
  })

  it('still never runs the idle re-check while offline', () => {
    TaskBackupPush.noteConnectivity(false)
    expect(task().trigger(Date.now() + TaskBackupPush.IDLE_RECHECK_MS * 10).run).toBe(false)
  })
})

describe('TaskBackupPush runTask', () => {
  it('clears the change flag once the log has caught up', async () => {
    TaskBackupPush.noteChanged()
    await task(async () => ok({ pushed: 0, windowClosed: true })).runTask()

    expect(TaskBackupPush.hasChanges).toBe(false)
    expect(TaskBackupPush.lastError).toBeUndefined()
    expect(TaskBackupPush.lastSuccessAt).toBeDefined()
  })

  it('keeps going while chunks are still being pushed', async () => {
    // A pass handles one chunk, so a successful push means there is probably more to drain.
    TaskBackupPush.noteChanged()
    await task(async () => ok({ pushed: 1, bytes: 100, windowClosed: false })).runTask()

    expect(TaskBackupPush.hasChanges).toBe(true)
    expect(TaskBackupPush.checkNow).toBe(true)
  })

  it('backs off exponentially on failure and records why', async () => {
    const failing = task(async () => { throw new Error('server unreachable') })

    await failing.runTask()
    const first = TaskBackupPush.backoffMs
    await failing.runTask()

    expect(TaskBackupPush.lastError).toBe('server unreachable')
    expect(TaskBackupPush.backoffMs).toBeGreaterThan(first)
  })

  it('caps the backoff', async () => {
    const failing = task(async () => { throw new Error('down') })
    for (let i = 0; i < 20; i++) await failing.runTask()

    expect(TaskBackupPush.backoffMs).toBeLessThanOrEqual(TaskBackupPush.MAX_BACKOFF_MS)
  })

  it('does not throw out of runTask', async () => {
    // The monitor runs tasks consecutively; throwing would take out the tasks after it.
    await expect(task(async () => { throw new Error('boom') }).runTask()).resolves.toContain('failed')
  })

  it('resets the backoff after a success', async () => {
    let fail = true
    const t = task(async () => {
      if (fail) throw new Error('temporary')
      return ok()
    })

    await t.runTask()
    expect(TaskBackupPush.backoffMs).toBeGreaterThan(TaskBackupPush.BASE_BACKOFF_MS)

    fail = false
    await t.runTask()
    expect(TaskBackupPush.backoffMs).toBe(TaskBackupPush.BASE_BACKOFF_MS)
  })
})
