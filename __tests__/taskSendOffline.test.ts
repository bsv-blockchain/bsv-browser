import { TaskSendOffline } from '@/utils/monitor/TaskSendOffline'
import type { ProcessOfflineActionsResult } from '@/storage/methods/processOfflineActions'

// The base class constructor only stores the monitor and name, so a bare
// object is enough — same trick the previous version of this suite used.
const monitor = {} as never

function task(results: ProcessOfflineActionsResult[], nowRef: { t: number }) {
  const calls: number[] = []
  const t = new TaskSendOffline(
    monitor,
    async () => {
      calls.push(nowRef.t)
      const r = results.shift()
      if (!r) throw new Error('release called more times than the test planned')
      return r
    },
    () => nowRef.t
  )
  return { t, calls }
}

const idle: ProcessOfflineActionsResult = { sent: 0, rejected: 0, stopped: false }
const stuck: ProcessOfflineActionsResult = { sent: 0, rejected: 0, stopped: true }

describe('TaskSendOffline trigger', () => {
  beforeEach(() => TaskSendOffline.resetForTests())

  it('never runs while offline, even with checkNow set', () => {
    TaskSendOffline.noteConnectivity(false)
    TaskSendOffline.checkNow = true
    const { t } = task([], { t: 0 })
    expect(t.trigger(0).run).toBe(false)
  })

  it('reconnecting arms an immediate run', () => {
    TaskSendOffline.noteConnectivity(true)
    const { t } = task([], { t: 0 })
    expect(t.trigger(0).run).toBe(true)
  })

  it('does not fire periodically with nothing pending', () => {
    TaskSendOffline.noteConnectivity(true)
    TaskSendOffline.checkNow = false
    const { t } = task([], { t: 0 })
    expect(t.trigger(1_000_000).run).toBe(false)
  })

  it('fires periodically while pending and online', () => {
    TaskSendOffline.noteConnectivity(true)
    TaskSendOffline.checkNow = false
    TaskSendOffline.noteEnqueued()
    const { t } = task([], { t: 0 })
    expect(t.trigger(0).run).toBe(true)
  })
})

describe('TaskSendOffline backoff', () => {
  beforeEach(() => TaskSendOffline.resetForTests())

  it('a stopped run schedules the next attempt 10s out, then doubles to the 5min cap', async () => {
    const nowRef = { t: 1_000 }
    TaskSendOffline.noteConnectivity(true)
    const { t } = task([stuck, stuck, stuck], nowRef)

    await t.runTask() // consumed checkNow, stopped → due at 11_000
    expect(t.trigger(10_999).run).toBe(false)
    expect(t.trigger(11_000).run).toBe(true)

    nowRef.t = 11_000
    await t.runTask() // due at 31_000 (20s)
    expect(t.trigger(30_999).run).toBe(false)
    expect(t.trigger(31_000).run).toBe(true)

    // Drive the doubling to the cap: 10,20,40,80,160,300,300...
    nowRef.t = 31_000
    await t.runTask().catch(() => {}) // third stuck result
    expect(TaskSendOffline.backoffMs).toBe(80_000)
    TaskSendOffline.backoffMs = 400_000 // beyond cap: next schedule must clamp
    nowRef.t = 500_000
    const { t: t2 } = task([stuck], nowRef)
    await t2.runTask()
    expect(TaskSendOffline.backoffMs).toBeLessThanOrEqual(TaskSendOffline.MAX_BACKOFF_MS)
  })

  it('a clean run clears pending and resets backoff', async () => {
    const nowRef = { t: 0 }
    TaskSendOffline.noteConnectivity(true)
    TaskSendOffline.noteEnqueued()
    const { t } = task([idle], nowRef)
    await t.runTask()
    expect(TaskSendOffline.hasPending).toBe(false)
    expect(TaskSendOffline.backoffMs).toBe(TaskSendOffline.BASE_BACKOFF_MS)
    expect(t.trigger(1_000_000).run).toBe(false)
  })

  it('a throwing release is a stopped run, not a dead task', async () => {
    const nowRef = { t: 0 }
    TaskSendOffline.noteConnectivity(true)
    const t = new TaskSendOffline(
      monitor,
      async () => {
        throw new Error('boom')
      },
      () => nowRef.t
    )
    const log = await t.runTask()
    expect(log).toContain('boom')
    expect(TaskSendOffline.hasPending).toBe(true)
    expect(t.trigger(TaskSendOffline.BASE_BACKOFF_MS).run).toBe(true)
  })

  it('requestNow and noteEnqueued reset the backoff', () => {
    TaskSendOffline.noteConnectivity(true)
    TaskSendOffline.backoffMs = 160_000
    TaskSendOffline.nextDueAt = 999_999
    TaskSendOffline.requestNow()
    expect(TaskSendOffline.backoffMs).toBe(TaskSendOffline.BASE_BACKOFF_MS)
    expect(TaskSendOffline.checkNow).toBe(true)

    TaskSendOffline.backoffMs = 160_000
    TaskSendOffline.nextDueAt = 999_999
    TaskSendOffline.noteEnqueued()
    expect(TaskSendOffline.backoffMs).toBe(TaskSendOffline.BASE_BACKOFF_MS)
    expect(TaskSendOffline.nextDueAt).toBe(0)
  })

  it('records the stall for the UI and clears it on a clean run', async () => {
    const nowRef = { t: 0 }
    TaskSendOffline.noteConnectivity(true)
    const { t } = task([{ ...stuck, stalledOn: 'txA has no request' }, idle], nowRef)
    await t.runTask()
    expect(TaskSendOffline.lastStall).toBe('txA has no request')
    await t.runTask()
    expect(TaskSendOffline.lastStall).toBeUndefined()
  })
})
