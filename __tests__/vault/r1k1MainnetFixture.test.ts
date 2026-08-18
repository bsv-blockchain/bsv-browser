import { Hash, Utils } from '@bsv/sdk'
import {
  MAINNET_LOCKING_SCRIPT_LENGTH,
  MAINNET_LOCKING_SCRIPT_SHA256,
  MAINNET_SCRIPT_CODE_LENGTH,
  MAINNET_SCRIPT_CODE_SHA256,
  buildMainnetFixtureScript,
  rebuildMainnetFixtureScriptUncached
} from './fixtures/r1k1MainnetFixture'

describe('vault template codec: real mainnet fixture', () => {
  // Rebuilding the ~960 KB script is not free — build it once for the whole
  // suite via the memoized helper rather than per test. The "stable across
  // two independent builds" test below deliberately bypasses that memo (see
  // its own comment) so it is a genuine second build, not a second read of
  // the same cached result.
  let scriptBytes: number[]

  beforeAll(async () => {
    scriptBytes = await buildMainnetFixtureScript()
  })

  it('rebuilds a script of the recorded mainnet length', () => {
    expect(scriptBytes.length).toBe(MAINNET_LOCKING_SCRIPT_LENGTH)
  })

  it('rebuilds the mined mainnet script byte-for-byte: SHA-256 matches the recorded digest', () => {
    // This is the assertion that matters: a script built from the pinned
    // template, using only the commitment and k1PublicKeyHash actually mined
    // on mainnet (txid 6c947ae3..., vout 0), hashes to the exact digest
    // recorded from that real, already-mined output. If @bsv/templates ever
    // changes the R1K1 layout, this is what catches it.
    expect(Utils.toHex(Hash.sha256(scriptBytes))).toBe(MAINNET_LOCKING_SCRIPT_SHA256)
  })

  it('the recorded digest is stable across two independent builds', async () => {
    // Uses rebuildMainnetFixtureScriptUncached, NOT buildMainnetFixtureScript
    // — the latter is memoized, so a second call would just return a copy of
    // the same cached array and this test would be unable to fail no matter
    // what R1K1Wallet().lock() did. Calling the unmemoized builder twice
    // forces two real, independent invocations of R1K1Wallet().lock(), so a
    // genuine nondeterminism in the template would show up as a mismatch here.
    const first = await rebuildMainnetFixtureScriptUncached()
    const second = await rebuildMainnetFixtureScriptUncached()
    expect(second).toEqual(first)
    expect(Utils.toHex(Hash.sha256(first))).toBe(MAINNET_LOCKING_SCRIPT_SHA256)
    expect(Utils.toHex(Hash.sha256(second))).toBe(MAINNET_LOCKING_SCRIPT_SHA256)
  })

  it('scriptCode (lockingScript.subarray(60)) hashes to the recorded digest', () => {
    // Cross-validates the region-0x02 pinned constants (Task 3) against this
    // same real mainnet output, not just against a freshly-built script.
    const scriptCode = scriptBytes.slice(60)
    expect(scriptCode.length).toBe(MAINNET_SCRIPT_CODE_LENGTH)
    expect(Utils.toHex(Hash.sha256(scriptCode))).toBe(MAINNET_SCRIPT_CODE_SHA256)
  })
})
