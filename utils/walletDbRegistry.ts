import AsyncStorage from '@react-native-async-storage/async-storage'

/**
 * Wallet database filename registry.
 *
 * Tracks all known wallet `.db` filenames per identityKey-suffix + chain in
 * AsyncStorage so the wallet init code can pick the one with the highest
 * timestamp without needing to scan the filesystem (which is unreliable on
 * Android).
 *
 * Filename formats:
 *   Legacy  : wallet-<keySuffix>-<chain>net.db          → timestamp = 0
 *   Current : wallet-<keySuffix>-<chain>net-<unix_s>.db  → timestamp = <unix_s>
 */

// ── Filename parsing ────────────────────────────────────────────────────────

/**
 * Regex that matches both legacy and timestamped wallet DB filenames.
 *
 * Groups:
 *   1 – keySuffix  (8 hex chars from the end of the identityKey)
 *   2 – chain      (main | test | teratest)
 *   3 – timestamp  (digits, optional)
 */
const DB_FILENAME_RE = /^wallet-([a-fA-F0-9]{8})-(main|test|teratest)net(?:-(\d+))?\.db$/

export interface ParsedDbFilename {
  keySuffix: string
  chain: string // 'main' | 'test' | 'teratest'
  timestamp: number // 0 for legacy files without a timestamp segment
}

/**
 * Parse a wallet database filename into its constituent parts.
 * Returns `null` if the filename does not match the expected pattern.
 */
export function parseDbFilename(name: string): ParsedDbFilename | null {
  const m = DB_FILENAME_RE.exec(name)
  if (!m) return null
  return {
    keySuffix: m[1],
    chain: m[2],
    timestamp: m[3] ? Number(m[3]) : 0
  }
}

/**
 * Extract just the timestamp from a wallet DB filename.
 * Returns `0` for legacy (no-timestamp) filenames, or `-1` if the name is
 * not a valid wallet DB filename at all.
 */
export function parseTimestampFromFilename(name: string): number {
  const parsed = parseDbFilename(name)
  return parsed ? parsed.timestamp : -1
}

// ── Selection ───────────────────────────────────────────────────────────────

/**
 * Given an array of wallet DB filenames, return the one whose embedded
 * timestamp is the highest (i.e. the most recent database).
 *
 * If the array is empty an error is thrown.
 */
export function selectLatestDb(filenames: string[]): string {
  if (filenames.length === 0) {
    throw new Error('[walletDbRegistry] selectLatestDb called with empty list')
  }
  let best = filenames[0]
  let bestTs = parseTimestampFromFilename(best)
  for (let i = 1; i < filenames.length; i++) {
    const ts = parseTimestampFromFilename(filenames[i])
    if (ts > bestTs) {
      best = filenames[i]
      bestTs = ts
    }
  }
  return best
}

// ── AsyncStorage-backed registry ────────────────────────────────────────────

function registryKey(keySuffix: string, chain: string): string {
  return `walletDbs-${keySuffix}-${chain}net`
}

/**
 * Return all registered wallet DB filenames for the given identity + chain.
 */
export async function getRegisteredDbs(keySuffix: string, chain: string): Promise<string[]> {
  const raw = await AsyncStorage.getItem(registryKey(keySuffix, chain))
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

/**
 * Append a filename to the registry (no-op if already present).
 */
export async function registerDb(keySuffix: string, chain: string, filename: string): Promise<void> {
  const existing = await getRegisteredDbs(keySuffix, chain)
  if (existing.includes(filename)) return
  existing.push(filename)
  await AsyncStorage.setItem(registryKey(keySuffix, chain), JSON.stringify(existing))
}
