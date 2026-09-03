/**
 * The double-monitor guards from context/WalletContext.tsx, extracted to
 * utils/walletLifecycle.ts after the 2026-08-22 production crash:
 * logout-then-reimport orphaned a running monitor, two monitors landed on one
 * SQLite file, and the resulting "database is locked" contention corrupted the
 * expo-sqlite heap.
 *
 * The context itself has no test harness, so these tests drive the extracted
 * guards through the exact sequences that crashed production, and — like
 * walletMonitor.test.ts — pin the upstream Monitor contract the guards depend
 * on (startTasks/stopTasks in
 * @bsv/wallet-toolbox-mobile out/src/monitor/Monitor.js).
 */
import {
  refuseRepeatBuild,
  runAutoBuildSequence,
  startMonitorIfCurrent,
  stopMonitorAndDrain,
  type MonitorLifecycle,
  type Ref
} from '@/utils/walletLifecycle'
import { Monitor, Services } from '@bsv/wallet-toolbox-mobile'

/**
 * A real Monitor with no tasks and a fast run loop. The storage stub's
 * isStorageProvider() returns false, so runOnce touches nothing — the loop is
 * just flag + wait, which is all the lifecycle guards care about.
 */
function realMonitor(taskRunWaitMsecs = 10): Monitor {
  const services = new Services('test')
  const storageStub = { getActive: () => ({ isStorageProvider: () => false }) }
  const options = Monitor.createDefaultWalletMonitorOptions('test', storageStub as never, services)
  options.taskRunWaitMsecs = taskRunWaitMsecs
  const monitor = new Monitor(options)
  expect(monitor._tasks).toHaveLength(0)
  return monitor
}

/**
 * Mirrors the real Monitor's lifecycle semantics, instrumented: startTasks
 * flips _tasksRunning and assigns _tasksRunningPromise synchronously;
 * stopTasks only clears the flag; the "run loop" exits (resolving the
 * promise) only when the test calls completeRunLoop — standing in for the
 * loop noticing the flag at its next tick.
 */
class FakeMonitor implements MonitorLifecycle {
  _tasksRunning = false
  _tasksRunningPromise?: Promise<void>
  private resolveCompletion?: () => void

  constructor(
    private readonly name: string,
    private readonly events: string[]
  ) {}

  async startTasks(): Promise<void> {
    if (this._tasksRunning) throw new Error('monitor tasks are already running')
    this._tasksRunning = true
    this.events.push(`start:${this.name}`)
    this._tasksRunningPromise = new Promise(resolve => {
      this.resolveCompletion = resolve
    })
    return this._tasksRunningPromise
  }

  stopTasks(): void {
    this._tasksRunning = false
    this.events.push(`stop:${this.name}`)
  }

  completeRunLoop(): void {
    this.events.push(`loop-exit:${this.name}`)
    this.resolveCompletion?.()
    this.resolveCompletion = undefined
  }
}

describe('upstream Monitor contract (what makes the guards necessary)', () => {
  it('stopTasks is only a flag: it cannot cancel a startTasks that has not run yet', async () => {
    const monitor = realMonitor()

    // A rebuild "stops" the monitor while its deferred startTasks is still
    // queued behind InteractionManager…
    monitor.stopTasks()
    expect(monitor._tasksRunning).toBe(false)

    // …and when the deferred callback finally fires unguarded, the monitor
    // starts anyway. This zombie is the reason startMonitorIfCurrent exists.
    const run = monitor.startTasks()
    expect(monitor._tasksRunning).toBe(true)

    monitor.stopTasks()
    await run
    expect(monitor._tasksRunning).toBe(false)
  })

  it("startTasks' promise resolves only after the run loop exits, which is what the drain waits on", async () => {
    const monitor = realMonitor()
    const run = monitor.startTasks()
    expect(monitor._tasksRunningPromise).toBeDefined()

    let loopExited = false
    void monitor._tasksRunningPromise!.then(() => {
      loopExited = true
    })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(loopExited).toBe(false) // still looping

    monitor.stopTasks()
    await run // startTasks itself resolves only once the loop has exited…
    expect(loopExited).toBe(true) // …and _tasksRunningPromise resolved with it
  })
})

describe('logout-then-reimport (drained teardown)', () => {
  it('stops and drains the old monitor before the new one starts', async () => {
    const events: string[] = []
    const oldMonitor = new FakeMonitor('old', events)
    const newMonitor = new FakeMonitor('new', events)
    const monitorRef: Ref<MonitorLifecycle | null> = { current: oldMonitor }

    // Session 1 built and started a monitor.
    expect(startMonitorIfCurrent(monitorRef, oldMonitor)).toBe(true)

    // logout(): stop, then wait for the run loop to actually exit before
    // storage.destroy() — completeRunLoop stands in for the loop noticing
    // the cleared flag at its next tick.
    const drain = stopMonitorAndDrain(monitorRef, { timeoutMs: 1_000 })
    oldMonitor.completeRunLoop()
    await expect(drain).resolves.toBe('drained')
    expect(monitorRef.current).toBeNull()

    // Re-import: buildWallet's leftover check finds nothing and installs the
    // new monitor.
    await expect(stopMonitorAndDrain(monitorRef)).resolves.toBe('no-monitor')
    monitorRef.current = newMonitor
    expect(startMonitorIfCurrent(monitorRef, newMonitor)).toBe(true)

    // The old monitor was stopped — and its loop had exited — before the new
    // one started. At no point were two monitors running.
    expect(events).toEqual(['start:old', 'stop:old', 'loop-exit:old', 'start:new'])
    expect(oldMonitor._tasksRunning).toBe(false)
    expect(newMonitor._tasksRunning).toBe(true)
  })

  it('buildWallet stops AND drains a leftover monitor a skipped teardown left behind (the pre-fix logout)', async () => {
    const events: string[] = []
    const orphan = new FakeMonitor('orphan', events)
    const newMonitor = new FakeMonitor('new', events)
    const monitorRef: Ref<MonitorLifecycle | null> = { current: orphan }
    expect(startMonitorIfCurrent(monitorRef, orphan)).toBe(true)

    // logout forgets the monitor (the 2026-08-22 bug) — the ref still holds
    // it when re-import reaches buildWallet, where the leftover check catches
    // it. Drained, not just stopped: a mid-pass leftover could otherwise
    // still be touching the same SQLite file the new build opens.
    const drain = stopMonitorAndDrain(monitorRef, { timeoutMs: 1_000 })
    orphan.completeRunLoop()
    await expect(drain).resolves.toBe('drained')
    expect(monitorRef.current).toBeNull()
    monitorRef.current = newMonitor
    expect(startMonitorIfCurrent(monitorRef, newMonitor)).toBe(true)

    expect(events).toEqual(['start:orphan', 'stop:orphan', 'loop-exit:orphan', 'start:new'])
    expect(orphan._tasksRunning).toBe(false)
    expect(newMonitor._tasksRunning).toBe(true)
  })

  it('stopMonitorAndDrain nulls the ref even when stopTasks throws', async () => {
    const error = new Error('already torn down')
    const warn = jest.fn()
    const monitorRef: Ref<MonitorLifecycle | null> = {
      current: {
        startTasks: async () => {},
        stopTasks: () => {
          throw error
        }
      }
    }
    // The monitor never started, so there is no run loop to drain past the
    // failed stop.
    await expect(stopMonitorAndDrain(monitorRef, { warn })).resolves.toBe('never-started')
    expect(monitorRef.current).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('stopTasks failed'), error)
  })
})

describe('rebuild inside the deferred-startTasks window (startMonitorIfCurrent)', () => {
  it('never starts the stopped monitor: the stale deferred callback is refused', async () => {
    const monitor = realMonitor()
    const monitorRef: Ref<MonitorLifecycle | null> = { current: monitor }

    // buildWallet installed the monitor and deferred this callback…
    const deferredStart = () => startMonitorIfCurrent(monitorRef, monitor)

    // …but a rebuild lands first. The monitor never started, so there is no
    // run loop to drain.
    await expect(stopMonitorAndDrain(monitorRef, { timeoutMs: 50 })).resolves.toBe('never-started')

    const replacement = realMonitor()
    monitorRef.current = replacement
    expect(startMonitorIfCurrent(monitorRef, replacement)).toBe(true)

    // The stale callback finally fires: refused, and the superseded monitor
    // stays stopped instead of becoming an unstoppable orphan.
    expect(deferredStart()).toBe(false)
    expect(monitor._tasksRunning).toBe(false)
    expect(replacement._tasksRunning).toBe(true)

    await expect(stopMonitorAndDrain(monitorRef, { timeoutMs: 1_000 })).resolves.toBe('drained')
    expect(replacement._tasksRunning).toBe(false)
  })

  it('reports errors from a started monitor without throwing', async () => {
    const failure = new Error('SSE refused')
    const onError = jest.fn()
    const monitor: MonitorLifecycle = {
      startTasks: async () => {
        throw failure
      },
      stopTasks: () => {}
    }
    const monitorRef: Ref<MonitorLifecycle | null> = { current: monitor }
    expect(startMonitorIfCurrent(monitorRef, monitor, onError)).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(onError).toHaveBeenCalledWith(failure)
  })
})

describe('stopMonitorAndDrain', () => {
  it('returns no-monitor when nothing is installed', async () => {
    await expect(stopMonitorAndDrain({ current: null })).resolves.toBe('no-monitor')
  })

  it('does not resolve before the run loop exits', async () => {
    const events: string[] = []
    const monitor = new FakeMonitor('m', events)
    const monitorRef: Ref<MonitorLifecycle | null> = { current: monitor }
    expect(startMonitorIfCurrent(monitorRef, monitor)).toBe(true)

    let drained = false
    const drain = stopMonitorAndDrain(monitorRef, { timeoutMs: 1_000 }).then(outcome => {
      drained = true
      return outcome
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    // Flag is cleared but the loop is still mid-pass: destroying storage now
    // is the exact race that corrupted expo-sqlite. The drain must still be
    // pending.
    expect(monitor._tasksRunning).toBe(false)
    expect(drained).toBe(false)

    monitor.completeRunLoop()
    await expect(drain).resolves.toBe('drained')
  })

  it('times out (with a warning) instead of hanging on a run loop that never exits', async () => {
    const warn = jest.fn()
    const events: string[] = []
    const monitor = new FakeMonitor('stuck', events)
    const monitorRef: Ref<MonitorLifecycle | null> = { current: monitor }
    expect(startMonitorIfCurrent(monitorRef, monitor)).toBe(true)

    await expect(stopMonitorAndDrain(monitorRef, { timeoutMs: 25, warn })).resolves.toBe('timeout')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('25ms'))
  })

  it('drains a real Monitor end to end', async () => {
    const monitor = realMonitor()
    const monitorRef: Ref<MonitorLifecycle | null> = { current: monitor }
    expect(startMonitorIfCurrent(monitorRef, monitor)).toBe(true)
    expect(monitor._tasksRunning).toBe(true)

    await expect(stopMonitorAndDrain(monitorRef, { timeoutMs: 5_000 })).resolves.toBe('drained')
    expect(monitor._tasksRunning).toBe(false)
    expect(monitorRef.current).toBeNull()
  })
})

describe('repeat-build guard (refuseRepeatBuild)', () => {
  it('refuses build-while-built via walletBuiltRef even from a stale closure', () => {
    const built: Ref<boolean> = { current: false }
    const building: Ref<boolean> = { current: false }

    // A closure captured before any build — the auto-build effect's async
    // body, or an import screen's callback. The guard reads the refs at call
    // time, so what the closure captured cannot go stale.
    const guardFromStaleClosure = () => refuseRepeatBuild(built, building)
    expect(guardFromStaleClosure()).toBe(false)

    // First build runs to completion, transitioning the refs the way the
    // real builders do.
    building.current = true
    expect(guardFromStaleClosure()).toBe(true) // refused while building
    built.current = true
    building.current = false

    // The stale closure fires again — refused, because the ref is current
    // even though any walletBuilt state snapshot it captured still reads
    // false. That snapshot is exactly what the pre-fix guard consulted, and
    // why a second build (and second monitor) got through.
    expect(guardFromStaleClosure()).toBe(true)
  })
})

describe('auto-build sequence (runAutoBuildSequence)', () => {
  /**
   * Builders that transition the shared refs exactly like the real ones in
   * WalletContext, including their own refuseRepeatBuild guard — so these
   * sequences exercise both defense layers.
   */
  function makeHarness(opts: { hasMnemonic: boolean; recoveredKey: string | null }) {
    const built: Ref<boolean> = { current: false }
    const building: Ref<boolean> = { current: false }
    const calls: string[] = []
    const deps = {
      built,
      building,
      buildFromMnemonic: async () => {
        if (refuseRepeatBuild(built, building)) {
          calls.push('mnemonic:refused')
          return
        }
        building.current = true
        if (!opts.hasMnemonic) {
          calls.push('mnemonic:no-mnemonic')
          building.current = false
          return
        }
        built.current = true
        building.current = false
        calls.push('mnemonic:built')
      },
      getRecoveredKey: async () => {
        calls.push('getRecoveredKey')
        return opts.recoveredKey
      },
      buildFromRecoveredKey: async (wif: string) => {
        if (refuseRepeatBuild(built, building)) {
          calls.push('recovered:refused')
          return
        }
        building.current = true
        built.current = true
        building.current = false
        calls.push(`recovered:built:${wif}`)
      },
      onNoWalletFound: jest.fn()
    }
    return { built, building, calls, deps }
  }

  it('does not fall through to the recovered key after a successful mnemonic build', async () => {
    // The crash setup: the user once recovered from shares, so a leftover
    // recoveredKey sits in secure storage next to their current mnemonic.
    const { built, calls, deps } = makeHarness({ hasMnemonic: true, recoveredKey: 'KLeftoverWif' })

    await expect(runAutoBuildSequence(deps)).resolves.toBe('built')

    // The fallback was never even consulted — one wallet, one monitor.
    expect(calls).toEqual(['mnemonic:built'])
    expect(built.current).toBe(true)
    expect(deps.onNoWalletFound).not.toHaveBeenCalled()
  })

  it('falls back to the recovered key when there is no mnemonic', async () => {
    const { built, calls, deps } = makeHarness({ hasMnemonic: false, recoveredKey: 'KRecoveredWif' })

    await expect(runAutoBuildSequence(deps)).resolves.toBe('recovered-key')

    expect(calls).toEqual(['mnemonic:no-mnemonic', 'getRecoveredKey', 'recovered:built:KRecoveredWif'])
    expect(built.current).toBe(true)
    expect(deps.onNoWalletFound).not.toHaveBeenCalled()
  })

  it('reports no wallet when neither secret exists', async () => {
    const { built, calls, deps } = makeHarness({ hasMnemonic: false, recoveredKey: null })

    await expect(runAutoBuildSequence(deps)).resolves.toBe('no-wallet')

    expect(calls).toEqual(['mnemonic:no-mnemonic', 'getRecoveredKey'])
    expect(built.current).toBe(false)
    expect(deps.onNoWalletFound).toHaveBeenCalledTimes(1)
  })

  it('never races a build that is still in flight elsewhere', async () => {
    const { building, calls, deps } = makeHarness({ hasMnemonic: true, recoveredKey: 'KLeftoverWif' })
    // The mnemonic screen called the builder directly; its claim is still
    // held when the auto-build effect's sequence runs.
    building.current = true

    await expect(runAutoBuildSequence(deps)).resolves.toBe('building-elsewhere')

    expect(calls).toEqual(['mnemonic:refused'])
    expect(deps.onNoWalletFound).not.toHaveBeenCalled()
  })

  it('defense in depth: the builder itself refuses even if the sequence gate were bypassed', async () => {
    const { built, calls, deps } = makeHarness({ hasMnemonic: true, recoveredKey: 'KLeftoverWif' })
    await runAutoBuildSequence(deps)
    expect(built.current).toBe(true)

    // Simulate the pre-fix fall-through calling the builder directly from a
    // stale closure: refuseRepeatBuild inside the builder still refuses it.
    await deps.buildFromRecoveredKey('KLeftoverWif')
    expect(calls).toEqual(['mnemonic:built', 'recovered:refused'])
  })
})
