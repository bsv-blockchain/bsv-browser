/**
 * Wallet lifecycle guards — the four "double-monitor" defenses used by
 * context/WalletContext.tsx, extracted so they can be unit-tested
 * (__tests__/walletLifecycle.test.ts).
 *
 * Origin: the 2026-08-22 production crash. logout() tore down React state but
 * left the Monitor running, so logout-then-reimport put TWO monitors on one
 * SQLite file. Their overlapping task passes deadlocked expo-sqlite
 * ("database is locked") and corrupted its heap. Each guard below closes one
 * path to a second live monitor:
 *
 *  1. stopLeftoverMonitor    — buildWallet stops+nulls any leftover monitor
 *                              before constructing its replacement.
 *  2. startMonitorIfCurrent  — the InteractionManager-deferred startTasks
 *                              callback re-checks identity, because
 *                              Monitor.stopTasks() is only a flag write and
 *                              cannot cancel a start that has not run yet.
 *  3. stopMonitorAndDrain    — logout stops the monitor and waits for its run
 *                              loop to actually exit before storage.destroy().
 *  4. refuseRepeatBuild /    — the builders' repeat-build guard and the
 *     runAutoBuildSequence     auto-build effect's recovered-key fallback read
 *                              walletBuiltRef, never a stale closure's state.
 *
 * Everything here is injectable and React-free on purpose: the callers hand in
 * plain `{ current }` refs and callbacks, so the tests can drive the exact
 * sequences that crashed production without mounting the 2300-line context.
 */

/** Structural stand-in for React's MutableRefObject. */
export interface Ref<T> {
  current: T
}

/**
 * The slice of @bsv/wallet-toolbox-mobile's Monitor these guards rely on. The
 * contract is pinned against the real class by the test file:
 *
 *  - startTasks() flips `_tasksRunning` and assigns `_tasksRunningPromise`
 *    synchronously, then loops until the flag clears; both its own promise and
 *    `_tasksRunningPromise` resolve only when the loop has actually exited
 *    (Monitor.js startTasks).
 *  - stopTasks() is nothing but `this._tasksRunning = false` (Monitor.js
 *    stopTasks). It cannot cancel a startTasks() that has not run yet, and it
 *    does not wait for one that has — both waits are this module's job.
 */
export interface MonitorLifecycle {
  startTasks(): Promise<void>
  stopTasks(): void | Promise<void>
  _tasksRunningPromise?: PromiseLike<void>
}

/**
 * Guard 1 — buildWallet's belt-and-braces: if an earlier build's monitor is
 * somehow still installed when a new one is about to be constructed (a
 * teardown path was skipped or raced), stop it and clear the ref.
 *
 * The ref is nulled BEFORE stopTasks so that from the first line no other code
 * path (deferred start, foreground resume, diagnostics) can adopt the dying
 * monitor, even if stopTasks throws.
 *
 * @returns true when a leftover monitor existed (worth logging — with the
 * other guards in place this should never fire).
 */
export async function stopLeftoverMonitor(
  monitorRef: Ref<MonitorLifecycle | null>,
  warn?: (error: unknown) => void
): Promise<boolean> {
  const leftover = monitorRef.current
  if (!leftover) return false
  monitorRef.current = null
  try {
    await leftover.stopTasks()
  } catch (error) {
    warn?.(error)
  }
  return true
}

/**
 * Guard 2 — start a monitor's task loop only if it is still the installed one.
 *
 * buildWallet installs the monitor synchronously but defers startTasks past
 * the current interactions (cold-start contention). A rebuild, network switch,
 * or logout can land inside that window: it calls stopTasks() and clears the
 * ref, but stopTasks is only a flag write, so the deferred callback firing
 * afterwards would start the superseded monitor anyway — resurrecting it as an
 * orphan nothing will ever stop, alongside the next build's monitor. The
 * identity re-check is what kills that zombie.
 *
 * startTasks is deliberately not awaited: its promise resolves only after a
 * later stopTasks exits the loop. Errors go to onError, matching the previous
 * inline `.catch`.
 *
 * @returns false when the monitor was superseded and therefore not started.
 */
export function startMonitorIfCurrent(
  monitorRef: Ref<MonitorLifecycle | null>,
  monitor: MonitorLifecycle,
  onError?: (error: unknown) => void
): boolean {
  if (monitorRef.current !== monitor) return false
  // Synchronous on purpose: startTasks sets _tasksRunning before its first
  // await, so once this call returns true the monitor IS running and a
  // subsequent stopTasks will be seen by its loop. Deferring the call (e.g.
  // via a microtask) would reopen the very window this guard closes.
  monitor.startTasks().catch(error => onError?.(error))
  return true
}

/**
 * Bounded so a hung task cannot wedge logout/rebuild forever: one
 * taskRunWaitMsecs tick (5 s) plus slack for a task pass to finish.
 */
export const MONITOR_DRAIN_TIMEOUT_MS = 7_000

export type DrainOutcome = 'no-monitor' | 'never-started' | 'drained' | 'timeout'

/**
 * Guard 3 — logout's teardown: stop the installed monitor and wait for its run
 * loop to actually exit before the caller destroys the storage under it.
 *
 * stopTasks only clears a flag; the loop notices at its next iteration, up to
 * taskRunWaitMsecs (5 s) later, plus however long a task pass is mid-run. A
 * storage.destroy() issued in that gap closes the SQLite connection under a
 * task still inside runOnce — the pass rejects, and the loop's own logEvent
 * error write rejects again on the closed handle. So the drain awaits the
 * toolbox's own completion signal, `_tasksRunningPromise` (assigned
 * synchronously by startTasks, resolved by the loop on exit).
 *
 * The timeout is a backstop for a run loop that died on an unhandled error —
 * the toolbox never resolves `_tasksRunningPromise` in that case — so logout
 * cannot hang forever on it.
 */
export async function stopMonitorAndDrain(
  monitorRef: Ref<MonitorLifecycle | null>,
  options: {
    timeoutMs?: number
    warn?: (message: string, error?: unknown) => void
  } = {}
): Promise<DrainOutcome> {
  const { timeoutMs = MONITOR_DRAIN_TIMEOUT_MS, warn } = options
  const monitor = monitorRef.current
  if (!monitor) return 'no-monitor'
  monitorRef.current = null
  try {
    await monitor.stopTasks()
  } catch (error) {
    warn?.('stopTasks failed during monitor drain', error)
  }
  const runLoop = monitor._tasksRunningPromise
  if (!runLoop) return 'never-started'
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const outcome = await Promise.race([
      // A rejected run loop has exited just as surely as a resolved one.
      runLoop.then(
        () => 'drained' as const,
        () => 'drained' as const
      ),
      new Promise<'timeout'>(resolve => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs)
      })
    ])
    if (outcome === 'timeout') {
      warn?.(`monitor run loop still busy after ${timeoutMs}ms; proceeding without it`)
    }
    return outcome
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Guard 4a — the builders' repeat-build guard.
 *
 * Reads the refs at CALL time, so a builder invoked from a stale closure (the
 * auto-build effect's async body, an import screen's captured callback) still
 * sees the current truth. Its predecessor read the `walletBuilt` useState
 * snapshot — false forever inside any closure created before the first build
 * finished — which is what let a second build (and second monitor) through.
 *
 * `built` must be a ref the context keeps in lockstep with the walletBuilt
 * state at every transition (WalletContext's setWalletBuilt wrapper).
 */
export function refuseRepeatBuild(built: Ref<boolean>, building: Ref<boolean>): boolean {
  return built.current || building.current
}

export type AutoBuildOutcome = 'built' | 'building-elsewhere' | 'recovered-key' | 'no-wallet'

export interface AutoBuildDeps {
  /** walletBuiltRef — synced with walletBuilt state at every transition. */
  built: Ref<boolean>
  /** walletBuildingRef — claimed by whichever builder is mid-flight. */
  building: Ref<boolean>
  buildFromMnemonic: () => Promise<void>
  getRecoveredKey: () => Promise<string | null>
  buildFromRecoveredKey: (wif: string) => Promise<void>
  /** Neither a mnemonic nor a recovered key exists: clear the eager "building" signal. */
  onNoWalletFound: () => void
}

/**
 * Guard 4b — the auto-build effect's decision sequence: mnemonic first,
 * recovered key only as a fallback when the mnemonic pass genuinely built
 * nothing.
 *
 * The `built` check between the two steps is the load-bearing line. Without
 * it, a leftover recovered key (from an old share-scan recovery) made the
 * effect fall through into buildFromRecoveredKey right after a successful
 * mnemonic build — the second wallet, second monitor, and second half of the
 * 2026-08-22 crash. The state snapshot in the effect's closure could not catch
 * this: it was captured before the build flipped walletBuilt.
 */
export async function runAutoBuildSequence(deps: AutoBuildDeps): Promise<AutoBuildOutcome> {
  await deps.buildFromMnemonic()
  if (deps.built.current) return 'built'
  // A build claimed elsewhere (e.g. the mnemonic screen calling the builder
  // directly) may still be in flight; never race it with a fallback build.
  if (deps.building.current) return 'building-elsewhere'
  const recoveredWif = await deps.getRecoveredKey()
  if (recoveredWif) {
    await deps.buildFromRecoveredKey(recoveredWif)
    return 'recovered-key'
  }
  deps.onNoWalletFound()
  return 'no-wallet'
}
