import { syncHeaders } from '@/utils/headers/syncHeaders'
import { HeaderStore } from '@/utils/headers/headerStore'
import { memoryHeaderFs } from '@/utils/headers/fs'

// Same two verified ttn headers as __tests__/headerStore.test.ts, one per line.
const ANCHOR = { height: 0, hash: '000000000499eabba0a88f5b3747231c74b9191c1a4a04b2c2ea817976b7776d' }
// prettier-ignore
const H1 = '000000206d77b7767981eac2b2044a1a1c19b9741c2347375b8fa8a0bbea990400000000f824a7d1f9f896347f9b5272b0ba7db7af6934d02fa94ed9c8545b70e90e652e0dcaa468ffff001dd21635fa'
// prettier-ignore
const H2 = '000000204bd109783c507e98b9da565c304e1313b085a54e0d4618ccf1e3d8b000000000fc8f1cc1c283eb968aea8d6217ce8e1868c4dd1bc90dc4afeeba622e21de176817caa468ffff001d05d356b3'

const store = () => HeaderStore.open(memoryHeaderFs(), 'ttn', ANCHOR)

describe('syncHeaders', () => {
  it('pulls chunks until it reaches the present height', async () => {
    const calls: [number, number][] = []
    const client = {
      getPresentHeight: async () => 2,
      getHeaders: async (height: number, count: number) => {
        calls.push([height, count])
        return height === 1 ? H1 : H2
      }
    }
    const s = await store()
    const r = await syncHeaders({ store: s, client, chunkSize: 1 })
    expect(r.added).toBe(2)
    expect(r.tipHeight).toBe(2)
    expect(calls).toEqual([
      [1, 1],
      [2, 1]
    ])
  })

  it('does nothing when already at the tip', async () => {
    const client = { getPresentHeight: async () => 0, getHeaders: async () => '' }
    const s = await store()
    const r = await syncHeaders({ store: s, client })
    expect(r.added).toBe(0)
  })

  it('stops without error when the service returns no headers', async () => {
    const client = { getPresentHeight: async () => 500, getHeaders: async () => '' }
    const s = await store()
    const r = await syncHeaders({ store: s, client })
    expect(r.added).toBe(0)
    expect(r.tipHeight).toBe(0)
  })

  it('honours shouldStop between chunks', async () => {
    let served = 0
    const client = {
      getPresentHeight: async () => 2,
      getHeaders: async (height: number) => {
        served++
        return height === 1 ? H1 : H2
      }
    }
    const s = await store()
    const r = await syncHeaders({ store: s, client, chunkSize: 1, shouldStop: () => served >= 1 })
    expect(r.added).toBe(1)
    expect(served).toBe(1)
  })

  it('reports progress per chunk', async () => {
    const progress: number[] = []
    const client = {
      getPresentHeight: async () => 2,
      getHeaders: async (height: number) => (height === 1 ? H1 : H2)
    }
    const s = await store()
    await syncHeaders({ store: s, client, chunkSize: 1, onProgress: tip => progress.push(tip) })
    expect(progress).toEqual([1, 2])
  })

  it('propagates a validation failure rather than silently truncating', async () => {
    const client = { getPresentHeight: async () => 2, getHeaders: async () => H2 }
    const s = await store()
    await expect(syncHeaders({ store: s, client, chunkSize: 1 })).rejects.toThrow(/previous hash/i)
  })
})
