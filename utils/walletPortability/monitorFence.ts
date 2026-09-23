/** Fence the host's monitor while a file operation owns its storage.
 * The actual loop must finish; elapsed time never permits database closure. */
interface MonitorLike {
  _tasksRunningPromise?: PromiseLike<void>
  stopTasks(): void
  startTasks(): Promise<void>
  destroy(): Promise<void>
}
export class WalletDataMonitorFence<T extends MonitorLike> {
  private paused?: T
  private disposed = false
  constructor(private readonly get: () => T | null, private readonly set: (monitor: T | null) => void, private readonly wanted: () => boolean, private readonly onError: (error: unknown) => void) {}
  async pause(): Promise<() => void> {
    const monitor = this.get() ?? this.paused
    if (monitor) {
      this.paused = monitor
      this.set(null)
      monitor.stopTasks()
      await monitor._tasksRunningPromise
    }
    return () => {
      if (monitor && this.paused === monitor && !this.disposed && this.wanted()) {
        this.paused = undefined
        this.set(monitor)
        void monitor.startTasks().catch(this.onError)
      }
    }
  }
  async stop(): Promise<void> {
    this.disposed = true
    await this.pause()
    if (this.paused) { await this.paused.destroy(); this.paused = undefined }
  }
}
