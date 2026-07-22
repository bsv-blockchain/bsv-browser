/**
 * M5.6 (native-crypto, issue #24) — shadow-mode unit tests for the patched
 * @bsv/wallet-toolbox-mobile `verifyUnlockScripts` (Tier-3 engine VERIFY leg).
 *
 * The JS `Spend` loop stays AUTHORITATIVE this rung. The engine's
 * `batchVerifyP2pkhInputs` runs ALONGSIDE it (ONE async crossing), verdicts are
 * compared, and ANY divergence is logged loudly + counted on
 * `globalThis.__bsvEngineShadow` — but the JS verdict is never replaced.
 *
 * These tests fake the engine at `globalThis.__bsvEngineNative` (jest never
 * loads Nitro) and assert the shadow's observe-don't-replace contract:
 *   • agree  — engine all-valid ⇒ 0 divergences, JS returns (no throw)
 *   • diverge— engine says a P2PKH input is invalid ⇒ divergence logged,
 *              JS STILL authoritative (verifyUnlockScripts does not throw)
 *   • poison — engine rejects an eligible JS-valid tx ⇒ divergence logged,
 *              never crashes the authoritative path (fallback)
 *   • absent — no engine ⇒ shadow skipped gracefully
 *   • mixed  — a non-P2PKH input ⇒ shadow skips the WHOLE tx, the engine is
 *              never called, and the full JS `Spend` still ran every input
 *              (no silent weakening of validation)
 *   • reject — a corrupted unlock ⇒ JS throws BEFORE the shadow (JS remains
 *              authoritative for rejects too)
 */
import {
  Beef,
  LockingScript,
  P2PKH,
  PrivateKey,
  Transaction,
  UnlockingScript
} from '@bsv/sdk'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { verifyUnlockScripts } = require('@bsv/wallet-toolbox-mobile/out/src/signer/methods/completeSignedTransaction.js')

const g = globalThis as Record<string, any>

interface ShadowState {
  verifyChecks: number
  verifyEligible: number
  verifySkipped: number
  verifyDivergences: number
  verifyAgreeInputs: number
  pending: Promise<void>
  lastDivergence: unknown
}

/** Build a fully-signed 2-input P2PKH tx + a beef containing it and its source. */
async function buildP2pkhBeef (): Promise<{ txid: string; beef: Beef; nInputs: number }> {
  const p2pkh = new P2PKH()
  const keys = [new PrivateKey(200001), new PrivateKey(200002)]
  const srcTx = new Transaction()
  for (let i = 0; i < 2; i++) srcTx.addOutput({ lockingScript: p2pkh.lock(keys[i].toAddress()), satoshis: 1000 + i })
  const srcId = srcTx.id('hex')
  const spend = new Transaction()
  for (let i = 0; i < 2; i++) {
    spend.addInput({
      sourceTransaction: srcTx,
      sourceTXID: srcId,
      sourceOutputIndex: i,
      unlockingScriptTemplate: p2pkh.unlock(keys[i]),
      sequence: 0xffffffff
    })
  }
  spend.addOutput({ lockingScript: p2pkh.lock(new PrivateKey(999).toAddress()), satoshis: 1500 })
  await spend.sign()
  const beef = new Beef()
  beef.mergeTransaction(srcTx)
  beef.mergeTransaction(spend)
  return { txid: spend.id('hex'), beef, nInputs: 2 }
}

/** Signed tx mixing a P2PKH input with a non-P2PKH (OP_1) input. */
async function buildMixedBeef (): Promise<{ txid: string; beef: Beef }> {
  const p2pkh = new P2PKH()
  const k = new PrivateKey(200003)
  const srcP = new Transaction()
  srcP.addOutput({ lockingScript: p2pkh.lock(k.toAddress()), satoshis: 1000 })
  const srcTrue = new Transaction()
  srcTrue.addOutput({ lockingScript: LockingScript.fromHex('51'), satoshis: 5 }) // OP_1 — truthy, non-P2PKH
  const trueTmpl = { sign: async () => new UnlockingScript([]), estimateLength: async () => 1 }
  const spend = new Transaction()
  spend.addInput({ sourceTransaction: srcP, sourceTXID: srcP.id('hex'), sourceOutputIndex: 0, unlockingScriptTemplate: p2pkh.unlock(k), sequence: 0xffffffff })
  spend.addInput({ sourceTransaction: srcTrue, sourceTXID: srcTrue.id('hex'), sourceOutputIndex: 0, unlockingScriptTemplate: trueTmpl as any, sequence: 0xffffffff })
  spend.addOutput({ lockingScript: p2pkh.lock(new PrivateKey(999).toAddress()), satoshis: 900 })
  await spend.sign()
  const beef = new Beef()
  beef.mergeTransaction(srcP)
  beef.mergeTransaction(srcTrue)
  beef.mergeTransaction(spend)
  return { txid: spend.id('hex'), beef }
}

const allValidEngine = (): { batchVerifyP2pkhInputs: (t: ArrayBuffer, m: ArrayBuffer) => Promise<ArrayBuffer> } => ({
  batchVerifyP2pkhInputs: async (_t, m) => new Uint8Array(new Array(m.byteLength / 37).fill(1)).buffer
})

describe('M5.6 verifyUnlockScripts shadow-mode routing (issue #24)', () => {
  let errorSpy: jest.SpyInstance

  beforeEach(() => {
    delete g.__bsvEngineShadow
    delete g.__bsvEngineNative
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    errorSpy.mockRestore()
    delete g.__bsvEngineShadow
    delete g.__bsvEngineNative
  })

  it('agree: engine all-valid ⇒ 0 divergences, JS authoritative (no throw)', async () => {
    const { txid, beef, nInputs } = await buildP2pkhBeef()
    g.__bsvEngineNative = allValidEngine()
    expect(() => verifyUnlockScripts(txid, beef)).not.toThrow()
    const s = g.__bsvEngineShadow as ShadowState
    await s.pending
    expect(s.verifyEligible).toBe(1)
    expect(s.verifyDivergences).toBe(0)
    expect(s.verifyAgreeInputs).toBe(nInputs)
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('diverge: engine flags a P2PKH input invalid ⇒ logged, JS stays authoritative', async () => {
    const { txid, beef } = await buildP2pkhBeef()
    g.__bsvEngineNative = {
      batchVerifyP2pkhInputs: async (_t: ArrayBuffer, m: ArrayBuffer) => {
        const a = new Array(m.byteLength / 37).fill(1)
        a[1] = 0 // engine disagrees on input 1
        return new Uint8Array(a).buffer
      }
    }
    // JS said all valid ⇒ verifyUnlockScripts must NOT throw despite the shadow disagreeing.
    expect(() => verifyUnlockScripts(txid, beef)).not.toThrow()
    const s = g.__bsvEngineShadow as ShadowState
    await s.pending
    expect(s.verifyDivergences).toBe(1)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('VERIFY DIVERGENCE'))
  })

  it('poison: engine rejects an eligible JS-valid tx ⇒ divergence logged, no crash (fallback)', async () => {
    const { txid, beef } = await buildP2pkhBeef()
    g.__bsvEngineNative = { batchVerifyP2pkhInputs: async () => { throw new Error('poison') } }
    expect(() => verifyUnlockScripts(txid, beef)).not.toThrow()
    const s = g.__bsvEngineShadow as ShadowState
    await s.pending
    expect(s.verifyDivergences).toBe(1)
    expect(s.verifyAgreeInputs).toBe(0)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('VERIFY DIVERGENCE'))
  })

  it('absent: no engine ⇒ shadow skipped gracefully', async () => {
    const { txid, beef } = await buildP2pkhBeef()
    expect(() => verifyUnlockScripts(txid, beef)).not.toThrow()
    const s = g.__bsvEngineShadow as ShadowState
    expect(s.verifyEligible).toBe(0)
    expect(s.verifySkipped).toBe(1)
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('mixed: a non-P2PKH input ⇒ shadow skips the whole tx, engine never called, JS Spend still validated every input', async () => {
    const { txid, beef } = await buildMixedBeef()
    let engineCalls = 0
    g.__bsvEngineNative = {
      batchVerifyP2pkhInputs: async (_t: ArrayBuffer, m: ArrayBuffer) => {
        engineCalls++
        return new Uint8Array(new Array(m.byteLength / 37).fill(1)).buffer
      }
    }
    // No throw ⇒ the full JS Spend validated BOTH the P2PKH and the OP_1 input.
    expect(() => verifyUnlockScripts(txid, beef)).not.toThrow()
    const s = g.__bsvEngineShadow as ShadowState
    if (s.pending != null) await s.pending
    expect(engineCalls).toBe(0) // shadow skipped — no silent weakening
    expect(s.verifyEligible).toBe(0)
    expect(s.verifySkipped).toBe(1)
  })

  it('reject: a corrupted unlock ⇒ JS throws BEFORE the shadow (JS authoritative for rejects)', async () => {
    const { txid, beef } = await buildP2pkhBeef()
    // Corrupt input 0's signature so the JS Spend fails.
    const tx = beef.findTxid(txid)?.tx as Transaction
    const unlock = tx.inputs[0].unlockingScript as UnlockingScript
    unlock.chunks[0].data![5] ^= 0xff // flip a byte inside the DER body
    g.__bsvEngineNative = allValidEngine()
    expect(() => verifyUnlockScripts(txid, beef)).toThrow()
    // Shadow never ran (JS threw first) — engine parity is unaffected by the reject.
    expect(g.__bsvEngineShadow?.verifyChecks ?? 0).toBe(0)
  })
})
