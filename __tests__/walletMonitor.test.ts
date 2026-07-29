import {
  configureNewHeaderPolling,
  NEW_HEADER_FAILURE_BACKOFF_MS,
  NEW_HEADER_POLL_INTERVAL_MS
} from '@/utils/walletMonitor'
import { Monitor, Services } from '@bsv/wallet-toolbox-mobile'
import { TaskSendOffline } from '@/utils/monitor/TaskSendOffline'

function createTask(runTask: () => Promise<string>) {
  return {
    lastRunMsecsSinceEpoch: 0,
    triggerMsecs: NEW_HEADER_POLL_INTERVAL_MS,
    trigger: (_nowMsecsSinceEpoch: number) => ({ run: true }),
    runTask
  }
}

describe('configureNewHeaderPolling', () => {
  it('runs immediately, then respects the one-minute polling interval', async () => {
    const task = createTask(async () => 'ok')
    configureNewHeaderPolling(task)

    expect(task.trigger(1_000).run).toBe(true)
    await expect(task.runTask()).resolves.toBe('ok')

    task.lastRunMsecsSinceEpoch = 1_000
    expect(task.trigger(1_000 + NEW_HEADER_POLL_INTERVAL_MS - 1).run).toBe(false)
    expect(task.trigger(1_000 + NEW_HEADER_POLL_INTERVAL_MS).run).toBe(true)
  })

  it('backs off after a transient endpoint failure', async () => {
    const error = new Error('Bad Gateway')
    const onFailure = jest.fn()
    const task = createTask(async () => {
      throw error
    })
    configureNewHeaderPolling(task, { now: () => 10_000, onFailure })

    await expect(task.runTask()).resolves.toBe('')
    expect(onFailure).toHaveBeenCalledWith(error, 10_000 + NEW_HEADER_FAILURE_BACKOFF_MS)

    task.lastRunMsecsSinceEpoch = 10_000
    expect(task.trigger(10_000 + NEW_HEADER_POLL_INTERVAL_MS).run).toBe(false)
    expect(task.trigger(10_000 + NEW_HEADER_FAILURE_BACKOFF_MS).run).toBe(true)
  })
})

/**
 * Why the drain is registered BEFORE addDefaultTasks() in
 * context/WalletContext.tsx.
 *
 * Monitor.runOnce collects due tasks by walking `_tasks` and runs them in that
 * order, awaiting each (Monitor.js:188-215). So if TaskSendOffline sits after
 * TaskSendWaiting, one pass can broadcast a child of a still-queued transaction
 * before the drain has posted its parent — an orphan rejection, which is the
 * exact outcome this feature's release ordering exists to prevent.
 *
 * WalletContext itself has no test harness, so what is pinned here is the
 * upstream contract that its one line of ordering depends on, and which a
 * toolbox upgrade could quietly change: `_tasks` is push-ordered and
 * addDefaultTasks() appends to it rather than resetting it, and
 * createDefaultWalletMonitorOptions defaults startupTaskMode to 'none' so the
 * constructor registers nothing of its own.
 */
describe('monitor task registration order', () => {
  const build = () => {
    const services = new Services('test')
    const options = Monitor.createDefaultWalletMonitorOptions('test', {} as never, services)
    // If this ever defaults to 'default', the constructor adds TaskSendWaiting
    // itself and registering "before addDefaultTasks" stops meaning anything.
    expect(options.startupTaskMode).toBe('none')
    const monitor = new Monitor(options)
    expect(monitor._tasks).toHaveLength(0)
    const drain = new TaskSendOffline(monitor, async () => ({ sent: 0, rejected: 0, stopped: false }))
    return { monitor, drain }
  }
  const names = (monitor: Monitor) => monitor._tasks.map(t => t.name)

  it('puts the drain ahead of SendWaiting when it is added before the defaults', () => {
    const { monitor, drain } = build()
    monitor.addTask(drain)
    monitor.addDefaultTasks()

    const order = names(monitor)
    expect(order[0]).toBe('SendOffline')
    expect(order.indexOf('SendOffline')).toBeLessThan(order.indexOf('SendWaiting'))
  })

  it('puts it behind SendWaiting when it is added after them — the order this fixed', () => {
    const { monitor, drain } = build()
    monitor.addDefaultTasks()
    monitor.addTask(drain)

    const order = names(monitor)
    expect(order.indexOf('SendOffline')).toBeGreaterThan(order.indexOf('SendWaiting'))
  })
})
