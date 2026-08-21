import { TaskCompressAtRest } from '@/utils/monitor/TaskCompressAtRest'
import type { CompactionStep } from '@/storage/methods/compressAtRest'

const monitor = {} as any

const step = (over: Partial<CompactionStep> = {}): CompactionStep => ({
  table: 'proven_txs',
  column: 'rawTx',
  id: 2,
  before: 960_075,
  after: 700,
  ...over
})

function task (compact: () => Promise<CompactionStep | undefined>): TaskCompressAtRest {
  return new TaskCompressAtRest(monitor, compact)
}

beforeEach(() => TaskCompressAtRest.reset())

describe('TaskCompressAtRest trigger', () => {
  it('runs immediately while work may be pending', () => {
    expect(task(async () => undefined).trigger(Date.now()).run).toBe(true)
  })

  it('waits out the row interval between rows', async () => {
    const t = task(async () => step())
    const now = Date.now()
    await t.runTask()
    expect(t.trigger(now + 1000).run).toBe(false)
    expect(t.trigger(now + TaskCompressAtRest.ROW_INTERVAL_MS + 1000).run).toBe(true)
  })

  it('goes idle once drained, and re-probes only at the idle interval', async () => {
    const t = task(async () => undefined)
    const now = Date.now()
    await t.runTask()
    expect(TaskCompressAtRest.maybePending).toBe(false)
    expect(t.trigger(now + 3_600_000).run).toBe(false)
    expect(t.trigger(now + TaskCompressAtRest.IDLE_RECHECK_MS + 1000).run).toBe(true)
  })

  it('a restore wakes an idle task', async () => {
    const t = task(async () => undefined)
    await t.runTask()
    expect(t.trigger(Date.now()).run).toBe(false)
    TaskCompressAtRest.notePossibleWork()
    expect(t.trigger(Date.now()).run).toBe(true)
  })
})

describe('TaskCompressAtRest runTask', () => {
  it('reports the row it compacted', async () => {
    const r = await task(async () => step()).runTask()
    expect(r).toContain('proven_txs.rawTx')
    expect(r).toContain('960075 -> 700')
  })

  it('stays quiet when there is nothing to do', async () => {
    expect(await task(async () => undefined).runTask()).toBe('')
  })

  it('counts rows across passes', async () => {
    const t = task(async () => step())
    await t.runTask()
    await t.runTask()
    expect(TaskCompressAtRest.rowsCompacted).toBe(2)
  })
})
