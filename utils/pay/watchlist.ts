/**
 * Which addresses the background sweeper is allowed to poll.
 *
 * The sweeper never derives an address on its own initiative: it polls exactly
 * the addresses this app has put in front of a user, because those are the only
 * ones anyone could have been asked to pay. That is what makes the background
 * work bounded — an unbounded look-back would be a WoC request per day per
 * poll, for money that was never requested.
 *
 * Bounds (spec open question 5):
 *   · at most MAX_WATCHED addresses, most-recently-active kept
 *   · dropped after WATCH_TTL_MS with no activity (issue or successful sweep)
 *   · never older than MAX_WATCH_DAYS by its issue date
 *
 * A dropped address is not lost money: the Get paid → conventional wallet view
 * re-registers today's address every time it is opened, and the earlier-day
 * recovery stepper can reach back MAX_RECOVERY_DAYS and sweep by hand.
 */

export const WATCHLIST_KEY = 'pay_address_watchlist'
export const MAX_WATCHED = 8
export const WATCH_TTL_MS = 86_400_000
export const MAX_WATCH_DAYS = 7

export interface WatchedAddress {
  address: string
  /** The YYYY-MM-DD the address was derived for. */
  date: string
  /** base64 of `date` — carried so a sweep needs no re-derivation. */
  derivationPrefix: string
  /** ISO 8601. The later of issue and last successful sweep. */
  lastActivityAt: string
}

export interface KVStorage {
  getKeyValue(k: string): Promise<string | undefined>
  setKeyValue(k: string, v: string): Promise<void>
}

// Same discipline as utils/localpay/pending.ts: every read-modify-write on the
// single storage key runs through one chain, or a write built from a stale read
// silently drops entries.
let queueLock: Promise<unknown> = Promise.resolve()

function withQueueLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = queueLock.then(fn, fn)
  queueLock = run.catch(() => undefined)
  return run
}

const DAY_MS = 86_400_000

export function pruneWatchlist(list: WatchedAddress[], nowMs: number): WatchedAddress[] {
  // The date cap is a CALENDAR-day comparison, not a rolling MAX_WATCH_DAYS ×
  // 24h window. `date` is a midnight-UTC day stamp while nowMs carries a time
  // of day, so a naive `nowMs - MAX_WATCH_DAYS * DAY_MS` lands part-way
  // through day 7 and drops an address issued that morning — money issued
  // inside the advertised look-back would stop being swept. Floor now to its
  // own UTC midnight first, so an address dated exactly MAX_WATCH_DAYS ago is
  // still swept for the whole of that day.
  const todayStart = Math.floor(nowMs / DAY_MS) * DAY_MS
  const oldestAllowed = todayStart - MAX_WATCH_DAYS * DAY_MS
  return list
    .filter(e => {
      const activity = Date.parse(e.lastActivityAt)
      if (!Number.isFinite(activity) || nowMs - activity > WATCH_TTL_MS) return false
      const issued = Date.parse(`${e.date}T00:00:00Z`)
      if (!Number.isFinite(issued) || issued < oldestAllowed) return false
      return true
    })
    .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt))
    .slice(0, MAX_WATCHED)
}

async function readAll(storage: KVStorage): Promise<WatchedAddress[]> {
  const raw = await storage.getKeyValue(WATCHLIST_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as WatchedAddress[]) : []
  } catch {
    return []
  }
}

async function writeAll(storage: KVStorage, list: WatchedAddress[]): Promise<void> {
  await storage.setKeyValue(WATCHLIST_KEY, JSON.stringify(list))
}

/** Register (or refresh) an address the user has just been shown. */
export async function watchAddress(storage: KVStorage, entry: Omit<WatchedAddress, 'lastActivityAt'>): Promise<void> {
  return withQueueLock(async () => {
    const now = Date.now()
    const existing = (await readAll(storage)).filter(e => e.address !== entry.address)
    const next = pruneWatchlist([{ ...entry, lastActivityAt: new Date(now).toISOString() }, ...existing], now)
    await writeAll(storage, next)
  })
}

/** The addresses the sweeper may poll right now. Prunes as a side effect of reading. */
export async function getWatchlist(storage: KVStorage): Promise<WatchedAddress[]> {
  return pruneWatchlist(await readAll(storage), Date.now())
}

/** Extend an address's life — called after a successful sweep, so more can arrive. */
export async function touchWatched(storage: KVStorage, address: string): Promise<void> {
  return withQueueLock(async () => {
    const all = await readAll(storage)
    if (!all.some(e => e.address === address)) return
    const now = Date.now()
    const next = all.map(e => (e.address === address ? { ...e, lastActivityAt: new Date(now).toISOString() } : e))
    await writeAll(storage, pruneWatchlist(next, now))
  })
}

export async function unwatchAddress(storage: KVStorage, address: string): Promise<void> {
  return withQueueLock(async () => {
    const all = await readAll(storage)
    await writeAll(
      storage,
      all.filter(e => e.address !== address)
    )
  })
}
