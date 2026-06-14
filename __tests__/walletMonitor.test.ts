import {
  configureNewHeaderPolling,
  NEW_HEADER_FAILURE_BACKOFF_MS,
  NEW_HEADER_POLL_INTERVAL_MS
} from '@/utils/walletMonitor'

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
