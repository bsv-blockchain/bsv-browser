import { prewarmOwnRoots } from '@/utils/headers/prewarm'
import { HeaderStore } from '@/utils/headers/headerStore'
import { memoryHeaderFs } from '@/utils/headers/fs'

const ANCHOR = { height: 100, hash: '00'.repeat(32) }

describe('prewarmOwnRoots', () => {
  it('copies proven roots into the store', async () => {
    const store = await HeaderStore.open(memoryHeaderFs(), 'ttn', ANCHOR)
    const added = await prewarmOwnRoots({
      rows: [
        { height: 7, merkleRoot: 'aa'.repeat(32) },
        { height: 9, merkleRoot: 'bb'.repeat(32) }
      ],
      store
    })
    expect(added).toBe(2)
    expect(store.rootForHeight(7)).toBe('aa'.repeat(32))
    expect(store.rootForHeight(9)).toBe('bb'.repeat(32))
  })

  it('skips rows already covered and malformed rows', async () => {
    const store = await HeaderStore.open(memoryHeaderFs(), 'ttn', ANCHOR)
    await store.putExtraRoot(7, 'aa'.repeat(32))
    const added = await prewarmOwnRoots({
      rows: [
        { height: 7, merkleRoot: 'aa'.repeat(32) },
        { height: 0, merkleRoot: '' },
        { height: 8, merkleRoot: 'cc'.repeat(32) }
      ],
      store
    })
    expect(added).toBe(1)
    expect(store.rootForHeight(8)).toBe('cc'.repeat(32))
  })
})
