import { TaskSendOffline } from '@/utils/monitor/TaskSendOffline'

function task(run: jest.Mock) {
  const t = new TaskSendOffline({ name: 'SendOffline' } as never, run as never)
  return t
}

describe('TaskSendOffline', () => {
  beforeEach(() => {
    TaskSendOffline.checkNow = false
  })

  it('does not run until checkNow is set', () => {
    const t = task(jest.fn())
    expect(t.trigger(Date.now()).run).toBe(false)
  })

  it('runs once checkNow is set', () => {
    TaskSendOffline.checkNow = true
    const t = task(jest.fn())
    expect(t.trigger(Date.now()).run).toBe(true)
  })

  it('clears checkNow so one reconnect causes one pass', async () => {
    TaskSendOffline.checkNow = true
    const run = jest.fn().mockResolvedValue({ sent: 1, rejected: 0, stopped: false })
    const t = task(run)
    await t.runTask()
    expect(TaskSendOffline.checkNow).toBe(false)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('reports what happened', async () => {
    const run = jest.fn().mockResolvedValue({ sent: 2, rejected: 1, stopped: true })
    const log = await task(run).runTask()
    expect(log).toMatch(/sent 2/)
    expect(log).toMatch(/rejected 1/)
    expect(log).toMatch(/stopped/)
  })

  it('returns an empty log when there was nothing to do', async () => {
    const run = jest.fn().mockResolvedValue({ sent: 0, rejected: 0, stopped: false })
    expect(await task(run).runTask()).toBe('')
  })

  it('swallows a failure so the monitor loop survives', async () => {
    const run = jest.fn().mockRejectedValue(new Error('boom'))
    const log = await task(run).runTask()
    expect(log).toMatch(/boom/)
  })

  it('surfaces a stall even when nothing was sent or rejected', async () => {
    const run = jest
      .fn()
      .mockResolvedValue({ sent: 0, rejected: 0, stopped: true, stalledOn: 'the beef of abc123 could not be read' })
    const log = await task(run).runTask()
    expect(log).not.toBe('')
    expect(log).toMatch(/stalled/)
    expect(log).toMatch(/abc123/)
  })
})
