import { HeaderStore } from '@/utils/headers/headerStore'
import { memoryHeaderFs } from '@/utils/headers/fs'
import { Utils } from '@bsv/sdk'

// Two real consecutive ttn headers, heights 1 and 2, from
// GET /getHeaders?height=1&count=2 on the ttn chaintracks deployment. Verified:
// header 1's previousHash is TTN_ANCHOR.hash, header 2's previousHash is header
// 1's hash, and both declare bits 0x1d00ffff, which their hashes satisfy.
// 320 hex characters = 2 x 80 bytes. Keep each header on one line: a bad line
// split silently changes the fixture into a different, invalid chain.
const TTN_ANCHOR = { height: 0, hash: '000000000499eabba0a88f5b3747231c74b9191c1a4a04b2c2ea817976b7776d' }
// prettier-ignore
const TTN_1_AND_2 = '000000206d77b7767981eac2b2044a1a1c19b9741c2347375b8fa8a0bbea990400000000f824a7d1f9f896347f9b5272b0ba7db7af6934d02fa94ed9c8545b70e90e652e0dcaa468ffff001dd21635fa000000204bd109783c507e98b9da565c304e1313b085a54e0d4618ccf1e3d8b000000000fc8f1cc1c283eb968aea8d6217ce8e1868c4dd1bc90dc4afeeba622e21de176817caa468ffff001d05d356b3'

const bytes = () => new Uint8Array(Utils.toArray(TTN_1_AND_2, 'hex'))

describe('HeaderStore', () => {
  it('starts empty at the anchor', async () => {
    const store = await HeaderStore.open(memoryHeaderFs(), 'ttn', TTN_ANCHOR)
    expect(store.count).toBe(0)
    expect(store.tipHeight).toBe(0)
    expect(store.tipHash).toBe(TTN_ANCHOR.hash)
    expect(store.rootForHeight(1)).toBeUndefined()
  })

  it('appends a chain that links to the anchor and indexes its roots', async () => {
    const store = await HeaderStore.open(memoryHeaderFs(), 'ttn', TTN_ANCHOR)
    const added = await store.append(bytes(), 1)
    expect(added).toBe(2)
    expect(store.count).toBe(2)
    expect(store.tipHeight).toBe(2)
    // Display order, i.e. the on-wire 32 bytes reversed — which is what
    // findHeaderHexForHeight reports and what Beef.verify compares against.
    expect(store.rootForHeight(1)).toBe('2e650ee9705b54c8d94ea92fd03469afb77dbab072529b7f3496f8f9d1a724f8')
    expect(store.rootForHeight(2)).toBe('6817de212e62baeeafc40dc91bddc468188ece17628dea8a96eb83c2c11c8ffc')
  })

  it('refuses a chunk that does not link to the current tip', async () => {
    const store = await HeaderStore.open(memoryHeaderFs(), 'ttn', { height: 0, hash: 'ff'.repeat(32) })
    await expect(store.append(bytes(), 1)).rejects.toThrow(/previous hash/i)
    expect(store.count).toBe(0)
  })

  it('refuses a chunk starting at the wrong height', async () => {
    const store = await HeaderStore.open(memoryHeaderFs(), 'ttn', TTN_ANCHOR)
    await expect(store.append(bytes(), 5)).rejects.toThrow(/height/i)
  })

  it('refuses a buffer that is not a multiple of 80 bytes', async () => {
    const store = await HeaderStore.open(memoryHeaderFs(), 'ttn', TTN_ANCHOR)
    await expect(store.append(bytes().subarray(0, 100), 1)).rejects.toThrow(/80/)
  })

  it('refuses a header whose hash does not meet its target', async () => {
    const store = await HeaderStore.open(memoryHeaderFs(), 'ttn', TTN_ANCHOR)
    const b = bytes()
    // Tighten the difficulty of header 1 to an impossible target: bits live at
    // offset 72..76 of the 80-byte header.
    b[72] = 0x01
    b[73] = 0x00
    b[74] = 0x00
    b[75] = 0x00
    await expect(store.append(b, 1)).rejects.toThrow()
    expect(store.count).toBe(0)
  })

  it('reloads its index and tip from the filesystem', async () => {
    const fs = memoryHeaderFs()
    const first = await HeaderStore.open(fs, 'ttn', TTN_ANCHOR)
    await first.append(bytes(), 1)
    const second = await HeaderStore.open(fs, 'ttn', TTN_ANCHOR)
    expect(second.count).toBe(2)
    expect(second.tipHeight).toBe(2)
    expect(second.tipHash).toBe(first.tipHash)
    expect(second.rootForHeight(2)).toBe(first.rootForHeight(2))
  })

  it('discards a stored window whose anchor no longer matches', async () => {
    const fs = memoryHeaderFs()
    const first = await HeaderStore.open(fs, 'ttn', TTN_ANCHOR)
    await first.append(bytes(), 1)
    const moved = await HeaderStore.open(fs, 'ttn', { height: 10, hash: 'ab'.repeat(32) })
    expect(moved.count).toBe(0)
    expect(moved.tipHeight).toBe(10)
  })

  // A checkpoint bump (app update) is the only thing that resets the window, and
  // until the reset deleted the .bin it was the one event that could serve wrong
  // merkle roots forever: appendBytes APPENDS, so the old anchor's headers stayed
  // in front of the new window, meta.count counted only the new ones, and open()
  // rebuilt the root index from the FIRST count*80 bytes — the old anchor's.
  // Nothing self-healed: the bin.length < count*80 guard cannot see a file that
  // is too LONG. None of the tests above catch it because none of them append
  // after a reset.
  describe('after a reset', () => {
    // Same hash, moved height. `open` resets on either field, and the real
    // fixture still validates under the moved anchor because a header names its
    // predecessor's HASH, not its height — so these are two genuinely different
    // windows over the same bytes, which is all this needs.
    const MOVED = { height: 100, hash: TTN_ANCHOR.hash }
    const ROOT_1 = '2e650ee9705b54c8d94ea92fd03469afb77dbab072529b7f3496f8f9d1a724f8'
    const ROOT_2 = '6817de212e62baeeafc40dc91bddc468188ece17628dea8a96eb83c2c11c8ffc'

    it('deletes the stored headers rather than leaving them on disk', async () => {
      const fs = memoryHeaderFs()
      const first = await HeaderStore.open(fs, 'ttn', TTN_ANCHOR)
      await first.append(bytes(), 1)
      expect(await fs.readBytes('ttn.bin')).toBeDefined()

      await HeaderStore.open(fs, 'ttn', MOVED)
      expect(await fs.readBytes('ttn.bin')).toBeUndefined()
    })

    it('serves the right roots for a window appended after the bump', async () => {
      const fs = memoryHeaderFs()
      const first = await HeaderStore.open(fs, 'ttn', TTN_ANCHOR)
      // ONE header under the old anchor, two under the new, so a stale leading
      // header shifts the index rather than coinciding with it.
      await first.append(bytes().subarray(0, 80), 1)
      expect(first.count).toBe(1)

      const moved = await HeaderStore.open(fs, 'ttn', MOVED)
      expect(moved.count).toBe(0)
      expect(await moved.append(bytes(), 101)).toBe(2)

      const reopened = await HeaderStore.open(fs, 'ttn', MOVED)
      expect(reopened.count).toBe(2)
      expect(reopened.rootForHeight(101)).toBe(ROOT_1)
      // The one a stale leading header corrupts: index 1 would land on the old
      // anchor's only header instead of the new window's second.
      expect(reopened.rootForHeight(102)).toBe(ROOT_2)
    })

    it('keeps the extra roots, which are anchor-independent facts', async () => {
      const fs = memoryHeaderFs()
      const first = await HeaderStore.open(fs, 'ttn', TTN_ANCHOR)
      await first.putExtraRoot(7, 'aa'.repeat(32))
      const moved = await HeaderStore.open(fs, 'ttn', MOVED)
      expect(moved.rootForHeight(7)).toBe('aa'.repeat(32))
    })
  })

  describe('memoryHeaderFs.deleteFile', () => {
    it('treats an absent path as already deleted', async () => {
      await expect(memoryHeaderFs().deleteFile('nothing-here.bin')).resolves.toBeUndefined()
    })

    it('removes bytes and text written under the same path', async () => {
      const fs = memoryHeaderFs()
      await fs.appendBytes('x.bin', new Uint8Array([1, 2, 3]))
      await fs.writeText('x.bin', 'text')
      await fs.deleteFile('x.bin')
      expect(await fs.readBytes('x.bin')).toBeUndefined()
      expect(await fs.readText('x.bin')).toBeUndefined()
    })
  })

  it('serves and persists extra roots below the window', async () => {
    const fs = memoryHeaderFs()
    const store = await HeaderStore.open(fs, 'ttn', TTN_ANCHOR)
    await store.putExtraRoot(7, 'aa'.repeat(32))
    expect(store.rootForHeight(7)).toBe('aa'.repeat(32))
    const reopened = await HeaderStore.open(fs, 'ttn', TTN_ANCHOR)
    expect(reopened.rootForHeight(7)).toBe('aa'.repeat(32))
  })

  describe('putExtraRoots (batch)', () => {
    it('persists every entry across a reopen', async () => {
      const fs = memoryHeaderFs()
      const store = await HeaderStore.open(fs, 'ttn', TTN_ANCHOR)
      await store.putExtraRoots([
        { height: 7, root: 'aa'.repeat(32) },
        { height: 9, root: 'bb'.repeat(32) }
      ])
      expect(store.rootForHeight(7)).toBe('aa'.repeat(32))
      expect(store.rootForHeight(9)).toBe('bb'.repeat(32))
      const reopened = await HeaderStore.open(fs, 'ttn', TTN_ANCHOR)
      expect(reopened.rootForHeight(7)).toBe('aa'.repeat(32))
      expect(reopened.rootForHeight(9)).toBe('bb'.repeat(32))
    })

    it('returns the count of newly-added entries', async () => {
      const store = await HeaderStore.open(memoryHeaderFs(), 'ttn', TTN_ANCHOR)
      const added = await store.putExtraRoots([
        { height: 7, root: 'aa'.repeat(32) },
        { height: 9, root: 'bb'.repeat(32) },
        { height: 11, root: 'cc'.repeat(32) }
      ])
      expect(added).toBe(3)
    })

    it('skips entries already present with the same root', async () => {
      const fs = memoryHeaderFs()
      const store = await HeaderStore.open(fs, 'ttn', TTN_ANCHOR)
      await store.putExtraRoot(7, 'aa'.repeat(32))
      const added = await store.putExtraRoots([
        { height: 7, root: 'aa'.repeat(32) }, // already present, same value
        { height: 8, root: 'cc'.repeat(32) } // new
      ])
      expect(added).toBe(1)
      expect(store.rootForHeight(8)).toBe('cc'.repeat(32))
    })

    it('does not double-count an exact duplicate height+root within one batch', async () => {
      const store = await HeaderStore.open(memoryHeaderFs(), 'ttn', TTN_ANCHOR)
      const added = await store.putExtraRoots([
        { height: 7, root: 'aa'.repeat(32) },
        { height: 7, root: 'aa'.repeat(32) } // same height, same root, repeated
      ])
      expect(added).toBe(1)
      expect(store.rootForHeight(7)).toBe('aa'.repeat(32))
    })

    it('writes the extra-roots file exactly once, not once per entry', async () => {
      const base = memoryHeaderFs()
      let writeCount = 0
      const countingFs = {
        ...base,
        writeText: async (path: string, text: string) => {
          writeCount++
          await base.writeText(path, text)
        }
      }
      const store = await HeaderStore.open(countingFs, 'ttn', TTN_ANCHOR)
      writeCount = 0 // ignore the writeMeta() call from open()
      const added = await store.putExtraRoots([
        { height: 7, root: 'aa'.repeat(32) },
        { height: 8, root: 'bb'.repeat(32) },
        { height: 9, root: 'cc'.repeat(32) },
        { height: 10, root: 'dd'.repeat(32) },
        { height: 11, root: 'ee'.repeat(32) }
      ])
      expect(added).toBe(5)
      expect(writeCount).toBe(1)
    })
  })
})
