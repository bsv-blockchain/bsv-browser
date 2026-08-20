import { StorageError, storageErrorFromSqlite } from '@/storage/errors'

/** Every expo-sqlite failure carries this same code, whatever went wrong. */
const sqliteError = (message: string) => Object.assign(new Error(message), { code: 'ERR_INTERNAL_SQLITE_ERROR' })

describe('storageErrorFromSqlite', () => {
  it('classifies a full disk from the bare sqlite message', () => {
    const e = storageErrorFromSqlite(sqliteError('database or disk is full'))
    expect(e).toBeInstanceOf(StorageError)
    expect(e!.code).toBe('disk-full')
  })

  it('classifies the Android message form, whose prefix is corrupt', () => {
    // Android builds the prefix with `result += code` on an int, so the code
    // renders as a raw control character. Matching the sqlite text rather than
    // the prefix survives that — and survives it being fixed upstream.
    expect(storageErrorFromSqlite(sqliteError('Error code \r: database or disk is full'))!.code).toBe('disk-full')
    expect(storageErrorFromSqlite(sqliteError('Error code 13: database or disk is full'))!.code).toBe('disk-full')
  })

  it('classifies an I/O error separately from a quota', () => {
    // Different remedy: a full disk needs space freed, an I/O error is
    // transient or hardware and telling the user to delete things is wrong.
    expect(storageErrorFromSqlite(sqliteError('disk I/O error'))!.code).toBe('disk-io')
  })

  it('does NOT treat a locked database as storage pressure', () => {
    // One shared code covers every sqlite failure, and this project has a known
    // storage-lock stall issue — so a handler that read SQLITE_BUSY as a full
    // disk would tell users to free space over a contended reader lock.
    expect(storageErrorFromSqlite(sqliteError('database is locked'))!.code).toBe('locked')
    expect(storageErrorFromSqlite(sqliteError('database table is locked'))!.code).toBe('locked')
  })

  it('returns null for failures that are not about storage at all', () => {
    // Guessing would turn a schema bug into a misleading "free up space" prompt.
    expect(storageErrorFromSqlite(sqliteError('no such column: bogus'))).toBeNull()
    expect(storageErrorFromSqlite(sqliteError('UNIQUE constraint failed: outputs.outputId'))).toBeNull()
    expect(storageErrorFromSqlite(new Error('network request failed'))).toBeNull()
  })

  it('returns null for things that are not errors', () => {
    expect(storageErrorFromSqlite('a string')).toBeNull()
    expect(storageErrorFromSqlite(undefined)).toBeNull()
    expect(storageErrorFromSqlite(null)).toBeNull()
    expect(storageErrorFromSqlite({ message: 'database or disk is full' })).toBeNull()
  })

  it('keeps the original error reachable for logging', () => {
    const original = sqliteError('database or disk is full')
    const e = storageErrorFromSqlite(original)!
    expect(e.cause).toBe(original)
    expect(e.message).toBe('database or disk is full')
  })

  it('matches regardless of case, since the text is not ours', () => {
    expect(storageErrorFromSqlite(sqliteError('DATABASE OR DISK IS FULL'))!.code).toBe('disk-full')
  })
})
