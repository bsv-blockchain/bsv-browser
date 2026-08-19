/* eslint-disable import/first -- jest.mock must be hoisted above the imports it affects */
// Own AsyncStorage mock, matching backupPush.test.ts: the vault suites install a different
// one and a global mapper makes the resolver recurse between the two.
jest.mock('@react-native-async-storage/async-storage', () => {
  const store: Record<string, string> = {}
  return {
    __esModule: true,
    default: {
      getItem: async (k: string) => store[k] ?? null,
      setItem: async (k: string, v: string) => { store[k] = v },
      removeItem: async (k: string) => { delete store[k] },
      getAllKeys: async () => Object.keys(store),
      multiRemove: async (keys: string[]) => { for (const k of keys) delete store[k] },
      clear: async () => { for (const k of Object.keys(store)) delete store[k] }
    }
  }
})

import AsyncStorage from '@react-native-async-storage/async-storage'
import { PrivateKey } from '@bsv/sdk'
import { BackupHttpError } from '@/utils/backup/client'
import { cursorKey } from '@/utils/backup/constants'
import { freshCursor, loadCursor, saveCursor } from '@/utils/backup/cursor'
import { backupPseudonym } from '@/utils/backup/derive'
import { eraseRemoteBackup } from '@/utils/backup/erase'
import { isBackupPushEnabled, setBackupPushEnabled } from '@/utils/backup/preference'

const PRIMARY = new PrivateKey(31).toArray('be', 32)
const OTHER = new PrivateKey(32).toArray('be', 32)
const PSEUDONYM = backupPseudonym(PRIMARY)
const DEVICE = 'e'.repeat(32)

function fakeClient (over: { deleteAccount?: jest.Mock } = {}): any {
  return {
    deleteAccount: over.deleteAccount ?? jest.fn().mockResolvedValue({ deleted: 7 }),
    manifest: jest.fn(),
    index: jest.fn(),
    blob: jest.fn(),
    append: jest.fn(),
    pruneGeneration: jest.fn()
  }
}

const deps = (over: Record<string, unknown> = {}): any => ({
  primaryKey: PRIMARY,
  client: fakeClient(),
  ...over
})

beforeEach(async () => {
  await AsyncStorage.clear()
})

describe('eraseRemoteBackup', () => {
  it('reports what the server removed', async () => {
    const client = fakeClient()
    const result = await eraseRemoteBackup(deps({ client }))

    expect(result).toEqual({ deleted: 7 })
    expect(client.deleteAccount).toHaveBeenCalledTimes(1)
  })

  it('stops pushing BEFORE it deletes', async () => {
    // Ordering is the whole correctness argument: with the opt-out written afterwards, a
    // monitor pass landing in between appends a fresh chunk and leaves wallet data on a
    // server that just reported a successful erasure.
    const order: string[] = []
    const client = fakeClient({
      deleteAccount: jest.fn(async () => {
        order.push(`pushEnabled=${String(await isBackupPushEnabled())}`)
        return { deleted: 1 }
      })
    })

    await eraseRemoteBackup(deps({ client }))

    expect(order).toEqual(['pushEnabled=false'])
    expect(await isBackupPushEnabled()).toBe(false)
  })

  it('clears the push cursors for this wallet so a re-enable starts a fresh log', async () => {
    // A cursor pointing at seq 9 of generation 3 describes a log the server no longer has.
    // Keeping it would make the next append conflict instead of starting over.
    await saveCursor(PSEUDONYM, DEVICE, { ...freshCursor(), seq: 9, generation: 3 })

    await eraseRemoteBackup(deps())

    expect(await AsyncStorage.getItem(cursorKey(PSEUDONYM, DEVICE))).toBeNull()
    expect(await loadCursor(PSEUDONYM, DEVICE)).toEqual(freshCursor())
  })

  it('leaves another wallet’s cursors alone', async () => {
    const otherPseudonym = backupPseudonym(OTHER)
    await saveCursor(otherPseudonym, DEVICE, { ...freshCursor(), seq: 4 })

    await eraseRemoteBackup(deps())

    expect(await AsyncStorage.getItem(cursorKey(otherPseudonym, DEVICE))).not.toBeNull()
  })

  it('keeps the cursor when the server rejects the erasure', async () => {
    // Nothing was deleted, so the local bookkeeping must still describe the server's real
    // state — clearing it here would strand the existing log and silently orphan it.
    await saveCursor(PSEUDONYM, DEVICE, { ...freshCursor(), seq: 5 })
    const client = fakeClient({
      deleteAccount: jest.fn().mockRejectedValue(new BackupHttpError(500, 'ERR_INTERNAL', 'nope'))
    })

    await expect(eraseRemoteBackup(deps({ client }))).rejects.toBeInstanceOf(BackupHttpError)

    expect((await loadCursor(PSEUDONYM, DEVICE)).seq).toBe(5)
    // The opt-out stands, though: it was a deliberate act, and re-arming pushing after a
    // failed erasure would upload again while the user still wants their data gone.
    expect(await isBackupPushEnabled()).toBe(false)
  })

  it('is usable when the user had already opted out', async () => {
    await setBackupPushEnabled(false)
    const result = await eraseRemoteBackup(deps())
    expect(result.deleted).toBe(7)
  })

  it('requires either a client or a baseUrl', async () => {
    await expect(eraseRemoteBackup({ primaryKey: PRIMARY } as any)).rejects.toThrow(/baseUrl/)
  })
})
