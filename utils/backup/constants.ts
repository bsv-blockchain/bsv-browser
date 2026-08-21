/**
 * Constants for the encrypted wallet backup log.
 *
 * @see docs/superpowers/specs/2026-08-14-encrypted-wallet-backup-log-design.md
 */
import type { WalletProtocol } from '@bsv/sdk'

/**
 * FROZEN. Do not change either value, ever.
 *
 * Restore has nothing but the user's seed to work from, so these must not vary by install,
 * device, build, or randomness. Changing them orphans every backup ever written, with no
 * error surfaced to anyone — the pseudonym simply becomes a different account holding no
 * data.
 *
 * NOTE: in TypeScript `WalletProtocol` is a TUPLE `[SecurityLevel, string]`, not the
 * `{securityLevel, protocol}` struct the Go SDK uses.
 *
 * Protocol names are validated at runtime: 5-400 chars, /^[a-z0-9 ]+$/, no double spaces,
 * and must not end in " protocol".
 */
export const BACKUP_PROTOCOL: WalletProtocol = [2, 'wallet backup log']
export const BACKUP_KEY_ID = '1'

/**
 * Delta chunk sizing.
 *
 * The protocol default `maxRoughSize` is 10,000,000, which is far too large to push from a
 * phone on cellular — and the toolbox's own size estimator re-marshals the accumulating
 * chunk on every page, so large values are quadratic. 512 KB of JSON comfortably encrypts
 * to under the server's 1 MiB cap.
 */
export const MAX_ROUGH_SIZE = 512_000
export const MAX_ITEMS = 200

/**
 * Start a fresh full snapshot once a generation exceeds this many chunks.
 *
 * An append-only delta log grows without bound, because soft deletes mean nothing ever
 * shrinks. Rotating bounds both server storage per user and restore time. The number is a
 * starting estimate and wants measuring against a real wallet's growth.
 */
export const GENERATION_CHUNK_THRESHOLD = 200

/**
 * Floor between push passes.
 *
 * The monitor loop ticks roughly every five seconds and runs its tasks back-to-back with no
 * yielding, so pushing on every tick would burn battery and compete with the UI for the JS
 * thread.
 */
export const MIN_PUSH_INTERVAL_MS = 60_000

/**
 * Historic server blob cap, kept as a conservative reference for tests.
 *
 * The live cap comes from the server itself — GET /v1/limits, surfaced as
 * `client.limits().maxBlobBytes` (200 MiB since the transaction-storage-capacity
 * work) — and the push gate uses that, not this. Chunk sizing still aims well
 * under this old 1 MiB figure because small chunks are what a phone on
 * cellular wants regardless of what the server would accept.
 */
export const MAX_BLOB_BYTES = 1 << 20

/** AsyncStorage keys. */
export const DEVICE_ID_KEY = 'backupDeviceId'
export const cursorKey = (pseudonym: string, deviceId: string): string =>
  `backupCursor-${pseudonym}-${deviceId}`
