/**
 * Run a block of token operations against a live key connection, hiding the
 * transport difference:
 *
 * - **session-based (iOS NFC):** the scan sheet is a system modal that covers
 *   the app, so you cannot collect a PIN while it is up. Callers MUST gather all
 *   user input (PIN, new PIN, nickname) BEFORE calling this; then this opens the
 *   NFC session, waits for the tap to connect, runs every token op in that one
 *   tap, and always closes the session afterwards (dismissing the sheet).
 * - **persistent (Android USB / mock):** the key is already on the reader, so
 *   `work` runs immediately; the reader's lifecycle is left untouched
 *   (WalletContext owns it for relock-on-unplug).
 *
 * `onWaiting` fires when we begin waiting for the tap, so the UI can prompt
 * "hold your key to the top of your phone".
 */
import { VaultDriver } from './driver'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
}
function defer<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

export async function withKeySession<T>(
  driver: VaultDriver,
  work: () => Promise<T>,
  onWaiting?: () => void
): Promise<T> {
  if (!driver.sessionBased) {
    return work()
  }
  const connected = defer<void>()
  const off = driver.onKeyEvent(e => {
    if (e.type === 'attached') connected.resolve()
  })
  onWaiting?.()
  driver.start()
  try {
    await connected.promise
    return await work()
  } finally {
    off()
    try {
      driver.stop()
    } catch {
      /* stop is best-effort — dismissing the sheet must never throw */
    }
  }
}
