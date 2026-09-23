/**
 * Node/jest coverage for utils/engineFixtures.ts — no native modules loaded,
 * follows the style of __tests__/sdkSignRouting.test.ts.
 *
 * @bsv/sdk 2.8.0 added monetary-range validation (MAX_SATOSHIS = 21e14) that
 * many of the 53 native-engine-poc/fixtures/engine-sim-fixtures.json
 * sign-flow fixtures' deliberately u64-scale amounts now fall outside of.
 * This proves, in plain node with no Nitro/native modules present, the same
 * three classes utils/engineNativeProof.ts's runRoutedParity exercises
 * on-device:
 *
 *   (a) in-range fixtures sign with the pure-JS SDK to exactly the recorded
 *       oracle bytes (expectedSignedTx).
 *   (b) out-of-range fixtures are rejected by tx.sign(), with no unlocking
 *       script applied to any input.
 *   (c) each out-of-range fixture's deterministic rescaled variant
 *       (rescaleFixtureInRange) is itself in range and signs reproducibly
 *       (two independent signs of the same variant give identical bytes).
 *
 * A final, optional block additionally routes a sample of the rescaled
 * variants through a mock `globalThis.__bsvEngineNative`, the way
 * sdkSignRouting.test.ts's tier-1 tests do, to show the routed engine tier
 * and the pure-JS tier agree on those variants too.
 */
import { type Transaction } from '@bsv/sdk'
import fixtures from '../native-engine-poc/fixtures/engine-sim-fixtures.json'
import { isFixtureInRange, rescaleFixtureInRange, txFromFixture } from '../utils/engineFixtures'

const g = globalThis as Record<string, any>

afterEach(() => {
  delete g.__bsvEngineNative
  delete g.__bsvSecpNative
})

const inRangeFixtures = fixtures.signFlow.filter((f) => isFixtureInRange(f.unsignedTx, f.inputsMeta))
const outOfRangeFixtures = fixtures.signFlow.filter((f) => !isFixtureInRange(f.unsignedTx, f.inputsMeta))

describe('engine-sim-fixtures.json partitioned by sdk 2.8 monetary range', () => {
  it('11 fixtures are in range and 42 are out of range', () => {
    expect(inRangeFixtures.length).toBe(11)
    expect(outOfRangeFixtures.length).toBe(42)
    expect(inRangeFixtures.length + outOfRangeFixtures.length).toBe(fixtures.signFlow.length)
  })
})

describe('in-range fixtures sign with the pure-JS SDK to the recorded oracle bytes', () => {
  it.each(inRangeFixtures.map((f) => [f.caseIdx, f] as const))('case %i', async (_caseIdx, f) => {
    const tx = txFromFixture(f.unsignedTx, f.inputsMeta)
    await tx.sign()
    expect(tx.toHex()).toBe(f.expectedSignedTx)
  })
})

describe('out-of-range fixtures are rejected by tx.sign()', () => {
  it.each(outOfRangeFixtures.map((f) => [f.caseIdx, f] as const))('case %i', async (_caseIdx, f) => {
    const tx = txFromFixture(f.unsignedTx, f.inputsMeta)
    await expect(tx.sign()).rejects.toThrow()
    expect(tx.inputs.every((i) => i.unlockingScript == null)).toBe(true)
  })
})

describe('rescaled variants of out-of-range fixtures', () => {
  it.each(outOfRangeFixtures.map((f) => [f.caseIdx, f] as const))(
    'case %i: variant is in range and signs deterministically',
    async (_caseIdx, f) => {
      const variant = rescaleFixtureInRange(f.unsignedTx, f.inputsMeta)
      expect(isFixtureInRange(variant.unsignedTx, variant.inputsMeta)).toBe(true)

      const tx1 = txFromFixture(variant.unsignedTx, variant.inputsMeta)
      await tx1.sign()
      const tx2 = txFromFixture(variant.unsignedTx, variant.inputsMeta)
      await tx2.sign()
      expect(tx1.toHex()).toBe(tx2.toHex())
      expect(tx1.toHex().length).toBeGreaterThan(0)
    }
  )
})

/** Frame a twin's unlocking scripts as the engine reply for every input. */
function engineReplyFromTwin (twin: Transaction): ArrayBuffer {
  const parts: Uint8Array[] = []
  for (let i = 0; i < twin.inputs.length; i++) {
    const script = Uint8Array.from(twin.inputs[i].unlockingScript!.toBinary())
    const rec = new Uint8Array(5 + script.length)
    new DataView(rec.buffer).setUint32(0, i, true)
    rec[4] = script.length
    rec.set(script, 5)
    parts.push(rec)
  }
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out.buffer as ArrayBuffer
}

describe('rescaled variants through a mock engine (optional, mirrors sdkSignRouting.test.ts tier-1 tests)', () => {
  // A representative sample, not all 42 — this block is extra confidence on
  // top of the required pure-JS determinism check above, not the primary
  // coverage for the routed tier (utils/engineNativeProof.ts's
  // runRoutedParity does that end to end, on-device).
  it.each(outOfRangeFixtures.slice(0, 5).map((f) => [f.caseIdx, f] as const))(
    'case %i: engine-routed == pure-JS',
    async (_caseIdx, f) => {
      const variant = rescaleFixtureInRange(f.unsignedTx, f.inputsMeta)
      const twin = txFromFixture(variant.unsignedTx, variant.inputsMeta)
      await twin.sign()

      const calls: { skel: Uint8Array, metas: Uint8Array }[] = []
      g.__bsvEngineNative = {
        batchSignP2pkhInputs: async (skel: ArrayBuffer, metas: ArrayBuffer) => {
          calls.push({ skel: new Uint8Array(skel), metas: new Uint8Array(metas) })
          return engineReplyFromTwin(twin)
        }
      }
      const tx = txFromFixture(variant.unsignedTx, variant.inputsMeta)
      await tx.sign()
      expect(calls).toHaveLength(1)
      expect(tx.toHex()).toBe(twin.toHex())
    }
  )
})
