/**
 * Bounding `proven_tx_reqs.history`.
 *
 * Every broadcast provider in the toolbox captures its full payload in an error
 * note — Arcade keeps the Extended Format hex, WhatsOnChain keeps `beef.toHex()`,
 * Bitails keeps the joined raw hex — and `transferNotesToReqHistories` copies
 * those notes verbatim into this TEXT column with no truncation. Worse,
 * `addHistoryNote`'s dedup does full string equality against every existing
 * note, so the second failure compares megabyte strings against megabyte
 * strings.
 *
 * A single failing vault broadcast therefore writes multi-megabyte hex into the
 * database and makes each subsequent attempt quadratic — precisely when things
 * are already going wrong. No rawTx codec touches this: the bytes arrive as hex
 * text inside a diagnostic string.
 *
 * The cap is deliberately applied to VALUES, not to the note count. History is
 * the only diagnostic trail for a stuck transaction, so losing entries would
 * cost real debuggability; losing the tail of one enormous hex string costs
 * nothing.
 */

/** Longest string value kept in a history note, including the ellipsis. */
export const NOTE_VALUE_MAX = 256

const truncate = (s: string): string => (s.length <= NOTE_VALUE_MAX ? s : `${s.slice(0, NOTE_VALUE_MAX - 1)}…`)

/**
 * Recursive copy of `value` with every over-long string truncated.
 *
 * Returns a copy rather than mutating: these objects are handed to us by
 * provider code that may still be using them, and a note is also frequently a
 * literal in the caller's own scope.
 */
export function scrubNoteValues<T>(value: T): T {
  if (typeof value === 'string') return truncate(value) as unknown as T
  if (Array.isArray(value)) return value.map(v => scrubNoteValues(v)) as unknown as T
  if (value != null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = scrubNoteValues(v)
    return out as unknown as T
  }
  return value
}

/**
 * Scrub the JSON text stored in `proven_tx_reqs.history`.
 *
 * Falls back to truncating the raw text when it does not parse: unparseable
 * history is already a bug, and letting a megabyte through because it was
 * malformed would defeat the point.
 */
export function scrubHistoryJson(history: unknown): unknown {
  if (typeof history !== 'string') return typeof history === 'undefined' ? history : scrubNoteValues(history)
  if (history.length <= NOTE_VALUE_MAX) return history
  try {
    return JSON.stringify(scrubNoteValues(JSON.parse(history)))
  } catch {
    return truncate(history)
  }
}
