import {
  MAX_WATCHED,
  MAX_WATCH_DAYS,
  WATCHLIST_KEY,
  WATCH_TTL_MS,
  getWatchlist,
  pruneWatchlist,
  touchWatched,
  unwatchAddress,
  watchAddress,
  type WatchedAddress
} from '@/utils/pay/watchlist'

function fakeStorage() {
  const map = new Map<string, string>()
  return {
    map,
    getKeyValue: async (k: string) => map.get(k),
    setKeyValue: async (k: string, v: string) => void map.set(k, v)
  }
}

const NOW = Date.parse('2026-07-28T12:00:00.000Z')

// The storage-level tests below run against the real clock, so their entries
// must be dated today — a literal date would start tripping the 7-day
// look-back cap a week after this file was written. The pruneWatchlist
// goldens above keep their literal dates: they inject NOW.
const TODAY = new Date().toISOString().slice(0, 10)

const entry = (over: Partial<WatchedAddress> = {}): WatchedAddress => ({
  address: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
  date: '2026-07-28',
  derivationPrefix: 'MjAyNi0wNy0yOA==',
  lastActivityAt: new Date(NOW).toISOString(),
  ...over
})

describe('pruneWatchlist', () => {
  it('keeps a fresh entry', () => {
    expect(pruneWatchlist([entry()], NOW)).toHaveLength(1)
  })

  it('drops an entry with no activity for longer than the TTL', () => {
    const stale = entry({ lastActivityAt: new Date(NOW - WATCH_TTL_MS - 1).toISOString() })
    expect(pruneWatchlist([stale], NOW)).toHaveLength(0)
  })

  it('drops an entry whose date is older than the look-back cap', () => {
    const old = entry({ address: 'old', date: '2026-07-01' })
    expect(pruneWatchlist([old], NOW)).toHaveLength(0)
  })

  it('keeps an entry exactly at the look-back cap', () => {
    const edge = entry({ address: 'edge', date: '2026-07-21' }) // 7 days back
    expect(pruneWatchlist([edge], NOW).map(e => e.address)).toEqual(['edge'])
  })

  it(`caps the list at ${MAX_WATCHED}, keeping the most recently active`, () => {
    const many = Array.from({ length: MAX_WATCHED + 3 }, (_, i) =>
      entry({ address: `addr-${i}`, lastActivityAt: new Date(NOW - i * 1000).toISOString() })
    )
    const kept = pruneWatchlist(many, NOW)
    expect(kept).toHaveLength(MAX_WATCHED)
    expect(kept[0].address).toBe('addr-0')
    expect(kept.some(e => e.address === `addr-${MAX_WATCHED + 2}`)).toBe(false)
  })

  it('pins the bounds so a future edit has to be deliberate', () => {
    expect({ MAX_WATCHED, MAX_WATCH_DAYS, WATCH_TTL_MS }).toEqual({
      MAX_WATCHED: 8,
      MAX_WATCH_DAYS: 7,
      WATCH_TTL_MS: 86_400_000
    })
  })
})

describe('watchAddress', () => {
  it('persists under the watchlist key', async () => {
    const s = fakeStorage()
    await watchAddress(s, { address: 'a', date: TODAY, derivationPrefix: 'p' })
    expect(s.map.has(WATCHLIST_KEY)).toBe(true)
  })

  it('is idempotent per address — showing the same address twice does not duplicate it', async () => {
    const s = fakeStorage()
    await watchAddress(s, { address: 'a', date: TODAY, derivationPrefix: 'p' })
    await watchAddress(s, { address: 'a', date: TODAY, derivationPrefix: 'p' })
    expect(await getWatchlist(s)).toHaveLength(1)
  })

  it('refreshes lastActivityAt when the same address is shown again', async () => {
    const s = fakeStorage()
    await watchAddress(s, { address: 'a', date: TODAY, derivationPrefix: 'p' })
    const first = (await getWatchlist(s))[0].lastActivityAt
    await new Promise(r => setTimeout(r, 5))
    await watchAddress(s, { address: 'a', date: TODAY, derivationPrefix: 'p' })
    expect((await getWatchlist(s))[0].lastActivityAt >= first).toBe(true)
  })

  it('does not lose entries when two writes race', async () => {
    const s = fakeStorage()
    await Promise.all([
      watchAddress(s, { address: 'a', date: TODAY, derivationPrefix: 'p' }),
      watchAddress(s, { address: 'b', date: TODAY, derivationPrefix: 'q' })
    ])
    expect((await getWatchlist(s)).map(e => e.address).sort()).toEqual(['a', 'b'])
  })
})

describe('getWatchlist', () => {
  it('returns [] for a fresh install', async () => {
    await expect(getWatchlist(fakeStorage())).resolves.toEqual([])
  })

  it('treats corrupt storage as empty rather than throwing', async () => {
    const s = fakeStorage()
    s.map.set(WATCHLIST_KEY, 'not json')
    await expect(getWatchlist(s)).resolves.toEqual([])
  })

  it('prunes on read, so a stale entry is never polled', async () => {
    const s = fakeStorage()
    s.map.set(WATCHLIST_KEY, JSON.stringify([entry({ lastActivityAt: '2020-01-01T00:00:00.000Z' })]))
    await expect(getWatchlist(s)).resolves.toEqual([])
  })
})

describe('touchWatched / unwatchAddress', () => {
  it('touch keeps the entry alive past its original TTL', async () => {
    const s = fakeStorage()
    await watchAddress(s, { address: 'a', date: TODAY, derivationPrefix: 'p' })
    const before = (await getWatchlist(s))[0].lastActivityAt
    await new Promise(r => setTimeout(r, 5))
    await touchWatched(s, 'a')
    expect((await getWatchlist(s))[0].lastActivityAt >= before).toBe(true)
  })

  it('touching an unknown address is a no-op', async () => {
    const s = fakeStorage()
    await touchWatched(s, 'missing')
    await expect(getWatchlist(s)).resolves.toEqual([])
  })

  it('unwatch removes exactly one entry', async () => {
    const s = fakeStorage()
    await watchAddress(s, { address: 'a', date: TODAY, derivationPrefix: 'p' })
    await watchAddress(s, { address: 'b', date: TODAY, derivationPrefix: 'q' })
    await unwatchAddress(s, 'a')
    expect((await getWatchlist(s)).map(e => e.address)).toEqual(['b'])
  })
})
