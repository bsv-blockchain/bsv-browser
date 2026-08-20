/**
 * Typed storage failures.
 *
 * expo-sqlite gives every failure the same `code`: `ERR_INTERNAL_SQLITE_ERROR`,
 * for a full disk, a locked database, corruption and a syntax error alike. So a
 * handler keyed on `code` cannot tell "free some space" from "another reader
 * holds the lock" — and this project already has a storage-lock stall issue, so
 * that confusion is not hypothetical.
 *
 * Classification therefore reads the message text, and does so carefully:
 *
 *  - Match the SQLITE text, never the prefix. Android builds its message with
 *    `result += code` on an int, so SQLITE_FULL arrives as
 *    `Error code \r: database or disk is full`. Anchoring on `^Error code`
 *    would also miss every execAsync failure, which returns the bare errmsg on
 *    both platforms — including the BEGIN/COMMIT/ROLLBACK that
 *    withExclusiveTransactionAsync issues. Matching the sqlite text survives
 *    both forms, and survives the Android prefix being fixed upstream.
 *  - Never parse a number out of the message, for the same reason.
 *  - `database is locked` is classified as its own code and explicitly NOT as
 *    storage pressure.
 *
 * Shaped after services/vault/types.ts, which is the established pattern here
 * for turning a native error string into a branded code.
 */

export type StorageErrorCode =
  /** The volume is full: the write did not happen and will not until space is freed. */
  | 'disk-full'
  /** The device reported an I/O failure. Transient or hardware; not a quota. */
  | 'disk-io'
  /** Another reader or writer holds the lock. NOT a storage-pressure problem. */
  | 'locked'
  /** Recognisably a storage failure, but none of the above. */
  | 'unknown'

export class StorageError extends Error {
  code: StorageErrorCode
  /** The original failure, kept so a log can carry the untranslated text. */
  cause?: unknown

  constructor(code: StorageErrorCode, message?: string, cause?: unknown) {
    super(message ?? code)
    this.name = 'StorageError'
    this.code = code
    this.cause = cause
  }
}

/** Unanchored, deliberately — see the module doc. */
const PATTERNS: { code: StorageErrorCode; re: RegExp }[] = [
  { code: 'disk-full', re: /database or disk is full/i },
  { code: 'disk-full', re: /disk full/i },
  { code: 'disk-io', re: /disk i\/o error/i },
  { code: 'locked', re: /database is locked/i },
  { code: 'locked', re: /database table is locked/i }
]

/**
 * Classify a failure as a storage problem, or return null.
 *
 * Null means "not recognisably about storage" and the caller must rethrow the
 * original untouched: guessing would turn a schema bug into a misleading
 * "free up space" prompt.
 */
export function storageErrorFromSqlite(e: unknown): StorageError | null {
  if (!(e instanceof Error)) return null
  const message = e.message ?? ''
  for (const { code, re } of PATTERNS) {
    if (re.test(message)) return new StorageError(code, message, e)
  }
  return null
}
