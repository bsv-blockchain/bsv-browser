import {
  DISK_BLOCK_BYTES,
  DISK_WARN_BYTES,
  availableDiskBytes,
  diskPressure
} from '@/utils/diskSpace'

describe('diskPressure', () => {
  it('reports ok well above the warn threshold', () => {
    expect(diskPressure(5 * 1024 * 1024 * 1024)).toBe('ok')
  })

  it('warns below the warn threshold', () => {
    expect(diskPressure(DISK_WARN_BYTES - 1)).toBe('warn')
    expect(diskPressure(DISK_WARN_BYTES)).toBe('ok')
  })

  it('blocks below the block threshold', () => {
    expect(diskPressure(DISK_BLOCK_BYTES - 1)).toBe('block')
    expect(diskPressure(DISK_BLOCK_BYTES)).toBe('warn')
  })

  it('treats an unreadable value as unknown, never as pressure', () => {
    // The native getters are Int64? and return nil on failure while TypeScript
    // claims number, so an unguarded comparison would silently evaluate false.
    // Failing open is deliberate: refusing writes because the disk could not be
    // read is worse than the problem being guarded against.
    expect(diskPressure(null)).toBe('unknown')
    expect(diskPressure(Number.NaN)).toBe('unknown')
    expect(diskPressure(-1)).toBe('unknown')
    expect(diskPressure(Number.POSITIVE_INFINITY)).toBe('unknown')
  })

  it('treats zero free bytes as block, not as unknown', () => {
    // A genuinely full disk reads 0. It must not be confused with "unreadable".
    expect(diskPressure(0)).toBe('block')
  })

  it('uses absolute bytes, not a percentage of capacity', () => {
    // Paths.totalDiskSpace returns FREE space on iOS in expo-file-system
    // 55.0.22, so available/total reads ~1.0 whatever the state and any
    // percentage threshold silently never fires there.
    expect(DISK_WARN_BYTES).toBe(200 * 1024 * 1024)
    expect(DISK_BLOCK_BYTES).toBe(50 * 1024 * 1024)
    expect(DISK_BLOCK_BYTES).toBeLessThan(DISK_WARN_BYTES)
  })
})

describe('availableDiskBytes', () => {
  it('returns null rather than throwing when the native module is absent', () => {
    // Which is the case under Jest. A pure helper must be loadable without the
    // native side, and unreadable must degrade to null, not to an exception in
    // the middle of a storage write.
    expect(availableDiskBytes()).toBeNull()
  })

  it('makes diskPressure report unknown when it cannot read', () => {
    expect(diskPressure()).toBe('unknown')
  })
})
