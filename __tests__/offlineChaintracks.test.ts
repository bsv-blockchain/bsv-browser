import { OfflineFirstChaintracks } from '@/utils/headers/OfflineFirstChaintracks'
import { HeaderStore } from '@/utils/headers/headerStore'
import { memoryHeaderFs } from '@/utils/headers/fs'

const ANCHOR = { height: 0, hash: '00'.repeat(32) }
const ROOT = 'ab'.repeat(32)

async function storeWithExtraRoot(height: number, root: string) {
  const s = await HeaderStore.open(memoryHeaderFs(), 'ttn', ANCHOR)
  await s.putExtraRoot(height, root)
  return s
}

function remote(overrides: Record<string, unknown> = {}) {
  return {
    findHeaderForHeight: jest.fn().mockResolvedValue({ merkleRoot: ROOT, height: 5 }),
    currentHeight: jest.fn().mockResolvedValue(999),
    isValidRootForHeight: jest.fn().mockResolvedValue(true),
    getChain: jest.fn().mockResolvedValue('ttn'),
    getHeaders: jest.fn().mockResolvedValue(''),
    getPresentHeight: jest.fn().mockResolvedValue(999),
    ...overrides
  } as never
}

describe('OfflineFirstChaintracks', () => {
  it('answers from the store without touching the network', async () => {
    const r = remote()
    const ct = new OfflineFirstChaintracks(r, async () => true)
    ct.setStore(await storeWithExtraRoot(5, ROOT))
    expect(await ct.isValidRootForHeight(ROOT, 5)).toBe(true)
    expect((r as never as { findHeaderForHeight: jest.Mock }).findHeaderForHeight).not.toHaveBeenCalled()
  })

  it('consults the network when the local root disagrees, still rejecting a genuinely wrong root', async () => {
    // Network is authoritative and returns ROOT for height 5.
    const r = remote()
    const ct = new OfflineFirstChaintracks(r, async () => true)
    ct.setStore(await storeWithExtraRoot(5, ROOT))
    // A local DISAGREEMENT is not trusted blindly (it may be a poisoned/stale
    // cache), so we ask the network — which also rejects 'cd…'.
    expect(await ct.isValidRootForHeight('cd'.repeat(32), 5)).toBe(false)
    expect((r as never as { findHeaderForHeight: jest.Mock }).findHeaderForHeight).toHaveBeenCalled()
  })

  it('heals a poisoned local root: confirms a valid root via the network and refreshes the cache', async () => {
    // Regression for the chain-tracker bug: the store cached a WRONG root for a
    // height (e.g. from a bad String(bytes) conversion), which made valid proofs
    // for that height fail forever. Now the disagreement is re-checked online.
    const r = remote() // network returns the correct ROOT for height 5
    const ct = new OfflineFirstChaintracks(r, async () => true)
    const store = await storeWithExtraRoot(5, 'ff'.repeat(32)) // poisoned entry
    ct.setStore(store)
    expect(await ct.isValidRootForHeight(ROOT, 5)).toBe(true)
    expect(store.rootForHeight(5)).toBe(ROOT) // cache healed to the authoritative value
  })

  it('offline: a local disagreement stays rejected (cannot consult the network)', async () => {
    const r = remote()
    const ct = new OfflineFirstChaintracks(r, async () => false)
    ct.setStore(await storeWithExtraRoot(5, ROOT))
    expect(await ct.isValidRootForHeight('cd'.repeat(32), 5)).toBe(false)
    expect((r as never as { findHeaderForHeight: jest.Mock }).findHeaderForHeight).not.toHaveBeenCalled()
  })

  it('falls back to the network on a miss while online and caches the root', async () => {
    const r = remote()
    const store = await HeaderStore.open(memoryHeaderFs(), 'ttn', ANCHOR)
    const ct = new OfflineFirstChaintracks(r, async () => true)
    ct.setStore(store)
    expect(await ct.isValidRootForHeight(ROOT, 5)).toBe(true)
    expect(store.rootForHeight(5)).toBe(ROOT)
  })

  it('refuses on a miss while offline and records the missed height', async () => {
    const r = remote()
    const ct = new OfflineFirstChaintracks(r, async () => false)
    ct.setStore(await HeaderStore.open(memoryHeaderFs(), 'ttn', ANCHOR))
    expect(await ct.isValidRootForHeight(ROOT, 5)).toBe(false)
    expect(ct.lastMissHeight).toBe(5)
    expect((r as never as { findHeaderForHeight: jest.Mock }).findHeaderForHeight).not.toHaveBeenCalled()
  })

  it('refuses on a miss with no store at all', async () => {
    const ct = new OfflineFirstChaintracks(remote(), async () => false)
    expect(await ct.isValidRootForHeight(ROOT, 5)).toBe(false)
  })

  it('returns false rather than throwing when the network lookup fails', async () => {
    const r = remote({ findHeaderForHeight: jest.fn().mockRejectedValue(new Error('down')) })
    const ct = new OfflineFirstChaintracks(r, async () => true)
    ct.setStore(await HeaderStore.open(memoryHeaderFs(), 'ttn', ANCHOR))
    expect(await ct.isValidRootForHeight(ROOT, 5)).toBe(false)
  })

  it('reports the store tip as the current height while offline', async () => {
    const ct = new OfflineFirstChaintracks(remote(), async () => false)
    ct.setStore(await storeWithExtraRoot(5, ROOT))
    expect(await ct.currentHeight()).toBe(0)
  })

  it('reports the remote height while online', async () => {
    const ct = new OfflineFirstChaintracks(remote(), async () => true)
    expect(await ct.currentHeight()).toBe(999)
  })

  it('delegates everything else to the remote client', async () => {
    const r = remote()
    const ct = new OfflineFirstChaintracks(r, async () => true)
    expect(await ct.getChain()).toBe('ttn')
    expect((r as never as { getChain: jest.Mock }).getChain).toHaveBeenCalled()
  })
})
