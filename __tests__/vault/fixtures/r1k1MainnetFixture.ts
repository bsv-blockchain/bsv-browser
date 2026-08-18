/**
 * Real, mined mainnet R1-K1 vault locking script — used to prove the pinned
 * template still reproduces byte-identical output against an ACTUAL on-chain
 * script, not just a freshly-built one. See r1k1-mainnet-lockingScript.hex.md
 * for full provenance.
 *
 * We do not commit the 959,632-byte script itself (1.9 MB of hex in git to
 * test a compressor whose whole point is avoiding 1.9 MB would be
 * self-defeating). Instead we commit the 40 bytes that vary between vault
 * outputs — the R1 commitment and k1PublicKeyHash actually mined for this
 * output — plus SHA-256 digests of the full script and of its scriptCode.
 * `buildMainnetFixtureScript` rebuilds the full script from the CURRENT
 * `@bsv/templates` R1K1Wallet using those 40 bytes; the accompanying test
 * (`__tests__/vault/r1k1MainnetFixture.test.ts`) asserts the rebuilt script's
 * digest still equals `MAINNET_LOCKING_SCRIPT_SHA256`. If `@bsv/templates`
 * ever changes the R1K1 layout, that assertion fails loudly instead of the
 * compressed-fixture round trip silently reconstructing the wrong bytes for
 * a real, already-mined output.
 *
 * SECURITY: nothing secret here. txid/vout/commitment/k1PublicKeyHash are all
 * public on-chain data; the r1PublicKey/salt preimage behind the commitment
 * is not held anywhere and is not needed by this fixture.
 */
import { R1K1Wallet } from '@bsv/templates'

export const MAINNET_FIXTURE_TXID = '6c947ae3825b7a7ea1c61a27b64b39c5b8b424d460677addb896285222982697'
export const MAINNET_FIXTURE_VOUT = 0

export const MAINNET_LOCKING_SCRIPT_LENGTH = 959632
export const MAINNET_LOCKING_SCRIPT_SHA256 = 'f5f78dcf291c5a115a609c1040117e2d09fd7e1cdc2d4911c633b338545f3db8'

/** scriptCode = lockingScript.subarray(60); see services/vault/templateCodec.ts Task 3. */
export const MAINNET_SCRIPT_CODE_LENGTH = 959572
export const MAINNET_SCRIPT_CODE_SHA256 = 'aeb8d8544f5bc218543de986cd974e7e387e3f455cb53a7c7460b466c2db6de9'

/** R1 commitment (hash160(r1PublicKey ‖ salt)) actually mined at offsets
 * 17..36 of the real output. The r1PublicKey/salt preimage behind this
 * commitment is not held anywhere — this fixture proves the template
 * reproduces this exact, already-mined commitment byte-for-byte, not that
 * the commitment can be re-derived from scratch. */
export const MAINNET_COMMITMENT_HEX = '93d0d2a2a0e1f6411498d53c4fd9db0e543171b1'

/** k1PublicKeyHash actually mined at offsets 959609..959628 of the real output. */
export const MAINNET_K1_PUBLIC_KEY_HASH_HEX = '4c63d12b6237ddd07db2e8a08c984d7667b487d0'

/**
 * Build the real mainnet locking script from the CURRENT R1K1Wallet template,
 * using the real commitment/k1PublicKeyHash mined on-chain (above). ALWAYS
 * invokes `R1K1Wallet().lock()` — no memoization.
 *
 * Built via the underlying template directly — `R1K1Wallet().lock(commitment,
 * k1PublicKeyHash)` — rather than `buildVaultLockingScript`, because this
 * fixture holds the commitment itself, not the r1PublicKey/salt preimage
 * `buildVaultLockingScript` would hash160 to derive it.
 *
 * Exists so a genuine determinism check can force two independent builds
 * instead of reading a memo twice (see `buildMainnetFixtureScript` below,
 * and r1k1MainnetFixture.test.ts's "stable across two independent builds"
 * test, which calls this — not the memoized wrapper — precisely so that a
 * regression in `@bsv/templates` determinism has somewhere to show up).
 * Ordinary callers should use `buildMainnetFixtureScript` instead.
 */
export async function rebuildMainnetFixtureScriptUncached(): Promise<number[]> {
  const commitment = hexToBytes(MAINNET_COMMITMENT_HEX)
  const k1PublicKeyHash = hexToBytes(MAINNET_K1_PUBLIC_KEY_HASH_HEX)
  const script = await new R1K1Wallet().lock(commitment, k1PublicKeyHash)
  return script.toBinary()
}

let cachedScript: number[] | undefined

/**
 * Memoized wrapper around `rebuildMainnetFixtureScriptUncached`: building the
 * ~960 KB script is not free, and both this fixture's own test and later
 * tasks' round-trip tests call this repeatedly. Returns a fresh copy each
 * call so callers are free to mutate their result (as e.g.
 * templateCodec.test.ts's byte-flip tests do) without corrupting the cache
 * for the next caller.
 *
 * Because this memoizes after the first call, it must NOT be used to test
 * that the underlying build is deterministic — a second call here proves
 * only that `.slice()` copies correctly. Use
 * `rebuildMainnetFixtureScriptUncached` for that.
 */
export async function buildMainnetFixtureScript(): Promise<number[]> {
  if (!cachedScript) {
    cachedScript = await rebuildMainnetFixtureScriptUncached()
  }
  return cachedScript.slice()
}

/** Local, dependency-free hex decoder (avoids pulling in @bsv/sdk's Utils
 * just for this one call, and keeps this fixture's only import the template
 * it is fixturing). */
function hexToBytes(hex: string): number[] {
  const out: number[] = []
  for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16))
  return out
}
