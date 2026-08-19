/**
 * Free-space probe.
 *
 * THE API NAME MATTERS. In expo-file-system 55.0.22 the reading is
 * `Paths.availableDiskSpace` — a SYNCHRONOUS getter, no await, no parens.
 * `getFreeDiskStorageAsync` is still exported from the bare specifier and still
 * type-checks, but THROWS at runtime; the only valid async form is
 * `expo-file-system/legacy`. Code using the wrong one compiles, passes review,
 * and fails only on device.
 *
 * THRESHOLDS ARE ABSOLUTE, never percentages. `Paths.totalDiskSpace` returns
 * FREE space on iOS in this version (upstream bug), so `available / total` reads
 * ~1.0 regardless of state and any percentage gate silently never fires there.
 *
 * THE READING CAN BE NULL. The native getters are `Int64?` and return nil on
 * failure while TypeScript claims `number`, so an unguarded `free < THRESHOLD`
 * evaluates false and the gate never triggers. Everything here treats an
 * unusable reading as 'unknown' and callers must fail OPEN on it: refusing to
 * write because we could not read the disk is worse than the problem.
 *
 * On iOS this is the raw `.systemFreeSize`, which excludes whatever purgeable
 * cache the OS is holding — so it under-reports what the system could actually
 * free on demand. That direction is the safe one for a warning.
 */

/** Warn the user below this. */
export const DISK_WARN_BYTES = 200 * 1024 * 1024

/** Refuse non-essential writes below this. */
export const DISK_BLOCK_BYTES = 50 * 1024 * 1024

export type DiskPressure = 'ok' | 'warn' | 'block' | 'unknown'

/**
 * Bytes available on the volume, or null when the platform gave nothing usable.
 *
 * expo-file-system is a native module, so the import is lazy: a pure helper must
 * not require the native side to exist in order to be loaded.
 */
export function availableDiskBytes(): number | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Paths } = require('expo-file-system') as typeof import('expo-file-system')
    const free = (Paths as unknown as { availableDiskSpace?: unknown }).availableDiskSpace
    return typeof free === 'number' && Number.isFinite(free) && free >= 0 ? free : null
  } catch {
    return null
  }
}

/**
 * Classify a free-space reading.
 *
 * Pass a value to test it; omit it to read the device.
 */
export function diskPressure(free?: number | null): DiskPressure {
  const bytes = free === undefined ? availableDiskBytes() : free
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return 'unknown'
  if (bytes < DISK_BLOCK_BYTES) return 'block'
  if (bytes < DISK_WARN_BYTES) return 'warn'
  return 'ok'
}
