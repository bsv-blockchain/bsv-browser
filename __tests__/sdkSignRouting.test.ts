/**
 * M5.5 (native-crypto, issue #23) — fallback-tier unit tests for the patched
 * @bsv/sdk Transaction.sign three-tier routing:
 *
 *   tier 1: engine-routed (globalThis.__bsvEngineNative.batchSignP2pkhInputs,
 *           ONE async crossing over a framed skeleton + 73B/input meta)
 *   tier 2: SecpNative-batched (batchEcdsaSign) — and, with no batch-capable
 *           native module at all, the SAME loop signing in pure JS with one
 *           shared SignatureHashCache
 *   tier 3: the original per-template path (untouched)
 *
 * The reference for every parity assertion is the ORIGINAL tier-3 semantics:
 * a twin transaction signed template-by-template via
 * `input.unlockingScriptTemplate.sign(tx, i)` — i.e. the unpatched SDK flow.
 * Native modules are faked at the globals; jest never loads Nitro.
 */
import { BigNumber, ECDSA, P2PKH, PrivateKey, Transaction, UnlockingScript } from '@bsv/sdk'

const g = globalThis as Record<string, any>

interface FixtureOpts {
  mixScopes?: boolean
  signOutputs?: 'all' | 'none' | 'single'
  nOutputs?: number
  lockingScriptOverride?: any
}

/** n-input P2PKH fixture (distinct keys, self-funded source tx). */
function fixture (n: number, opts: FixtureOpts = {}): { build: () => Transaction } {
  const p2pkh = new P2PKH()
  const keys: PrivateKey[] = []
  const srcTx = new Transaction()
  for (let i = 0; i < n; i++) {
    const k = new PrivateKey(200000 + i)
    keys.push(k)
    srcTx.addOutput({ lockingScript: p2pkh.lock(k.toAddress()), satoshis: 1000 + i })
  }
  const dest = new PrivateKey(999999).toAddress()
  const build = (): Transaction => {
    const tx = new Transaction()
    for (let i = 0; i < n; i++) {
      const signOutputs = opts.mixScopes ? (['all', 'none', 'single'] as const)[i % 3] : (opts.signOutputs ?? 'all')
      const anyoneCanPay = opts.mixScopes === true && i % 2 === 0
      tx.addInput({
        sourceTransaction: srcTx,
        sourceOutputIndex: i,
        unlockingScriptTemplate: opts.lockingScriptOverride != null
          ? p2pkh.unlock(keys[i], signOutputs, anyoneCanPay, 1000 + i, opts.lockingScriptOverride)
          : p2pkh.unlock(keys[i], signOutputs, anyoneCanPay),
        sequence: 0xffffffff
      })
    }
    const nOut = opts.nOutputs ?? 1
    for (let o = 0; o < nOut; o++) {
      tx.addOutput({ lockingScript: p2pkh.lock(dest), satoshis: Math.max(1, Math.floor((n * 1000 - 200) / nOut)) })
    }
    return tx
  }
  return { build }
}

/** ORIGINAL tier-3 semantics: sign template-by-template, no batch tiers. */
async function manualSign (tx: Transaction): Promise<Transaction> {
  for (let i = 0; i < tx.inputs.length; i++) {
    const t = tx.inputs[i].unlockingScriptTemplate
    if (typeof t === 'object' && t != null) {
      tx.inputs[i].unlockingScript = await t.sign(tx, i)
    }
  }
  return tx
}

/** Frame a twin's unlocking scripts as the engine reply for `indexes`. */
function engineReplyFromTwin (twin: Transaction, indexes: number[]): ArrayBuffer {
  const parts: Uint8Array[] = []
  for (const i of indexes) {
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

afterEach(() => {
  delete g.__bsvEngineNative
  delete g.__bsvSecpNative
  jest.restoreAllMocks()
})

describe('tier 2/3 — pure-JS fallback loop (no native modules at all)', () => {
  it.each([
    ['5 inputs, ALL', 5, {}],
    ['7 inputs, mixed ALL/NONE/SINGLE ± ANYONECANPAY', 7, { mixScopes: true }],
    ['1 input', 1, {}],
    ['3 inputs SINGLE with inputIndex >= outputs.length', 3, { signOutputs: 'single' as const, nOutputs: 1 }]
  ])('%s: shared-cache loop is byte-identical to per-template signing', async (_label, n, opts) => {
    const { build } = fixture(n, opts)
    const routed = build()
    await routed.sign()
    const twin = await manualSign(build())
    expect(routed.toHex()).toBe(twin.toHex())
  })
})

describe('tier 1 — engine-routed', () => {
  it('routes all P2PKH inputs through ONE batchSignP2pkhInputs crossing with correct framing', async () => {
    const n = 6
    const { build } = fixture(n)
    const twin = await manualSign(build())
    const calls: { skel: Uint8Array, metas: Uint8Array }[] = []
    g.__bsvEngineNative = {
      batchSignP2pkhInputs: async (skel: ArrayBuffer, metas: ArrayBuffer) => {
        calls.push({ skel: new Uint8Array(skel), metas: new Uint8Array(metas) })
        return engineReplyFromTwin(twin, [...Array(n).keys()])
      }
    }
    const tx = build()
    await tx.sign()
    expect(calls).toHaveLength(1)
    expect(tx.toHex()).toBe(twin.toHex())

    // meta: n fixed 73-byte records [u32 idx][32B privkey][u64 sats][u32 scope][25B lock]
    const metas = calls[0].metas
    expect(metas.length).toBe(n * 73)
    const mdv = new DataView(metas.buffer)
    for (let i = 0; i < n; i++) {
      const off = i * 73
      expect(mdv.getUint32(off, true)).toBe(i)
      const priv = new PrivateKey(200000 + i).toArray('be', 32)
      expect(Array.from(metas.subarray(off + 4, off + 36))).toEqual(priv)
      expect(mdv.getUint32(off + 36, true)).toBe(1000 + i) // sats lo
      expect(mdv.getUint32(off + 40, true)).toBe(0) // sats hi
      expect(mdv.getUint32(off + 44, true)).toBe(0x41) // SIGHASH_ALL | FORKID
      const lock = metas.subarray(off + 48, off + 73)
      expect(lock[0]).toBe(0x76)
      expect(lock[24]).toBe(0xac)
    }

    // skeleton: unsigned tx, every input script empty, outpoints in internal order
    const skel = calls[0].skel
    const sdv = new DataView(skel.buffer)
    expect(sdv.getUint32(0, true)).toBe(tx.version >>> 0)
    expect(skel[4]).toBe(n) // varint input count
    const srcIdHex: string = tx.inputs[0].sourceTransaction!.id('hex') as string
    let o = 5
    for (let i = 0; i < n; i++) {
      const txidInternal = Array.from(skel.subarray(o, o + 32))
        .reverse()
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
      expect(txidInternal).toBe(srcIdHex)
      expect(sdv.getUint32(o + 32, true)).toBe(i) // vout
      expect(skel[o + 36]).toBe(0) // empty script
      expect(sdv.getUint32(o + 37, true)).toBe(0xffffffff) // sequence
      o += 41
    }
    expect(skel[o]).toBe(1) // varint output count
    expect(sdv.getUint32(skel.length - 4, true)).toBe(0) // locktime
  })

  it('leaves template-less inputs untouched and routes only templated ones', async () => {
    const n = 4
    const { build } = fixture(n)
    const preset = UnlockingScript.fromHex('5151')
    const make = (): Transaction => {
      const tx = build()
      tx.inputs[2].unlockingScriptTemplate = undefined
      tx.inputs[2].unlockingScript = preset
      return tx
    }
    const twin = make()
    for (const i of [0, 1, 3]) {
      twin.inputs[i].unlockingScript = await twin.inputs[i].unlockingScriptTemplate!.sign(twin, i)
    }
    const calls: Uint8Array[] = []
    g.__bsvEngineNative = {
      batchSignP2pkhInputs: async (_skel: ArrayBuffer, metas: ArrayBuffer) => {
        calls.push(new Uint8Array(metas))
        return engineReplyFromTwin(twin, [0, 1, 3])
      }
    }
    const tx = make()
    await tx.sign()
    expect(calls).toHaveLength(1)
    expect(calls[0].length).toBe(3 * 73)
    const mdv = new DataView(calls[0].buffer)
    expect([mdv.getUint32(0, true), mdv.getUint32(73, true), mdv.getUint32(146, true)]).toEqual([0, 1, 3])
    expect(tx.inputs[2].unlockingScript!.toHex()).toBe('5151')
    expect(tx.toHex()).toBe(twin.toHex())
  })
})

describe('fallback contract — anything else leaves the engine tier', () => {
  it('engine rejection falls back and reproduces the SDK bytes exactly (dev-logged)', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const n = 4
    const { build } = fixture(n)
    const twin = await manualSign(build())
    let called = 0
    g.__bsvEngineNative = {
      batchSignP2pkhInputs: async () => {
        called++
        throw new Error('UnsupportedScope { input_index: 0 }')
      }
    }
    const tx = build()
    await tx.sign()
    expect(called).toBe(1)
    expect(tx.toHex()).toBe(twin.toHex())
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('[EngineNative]'))).toBe(true)
  })

  it('CR-5: a mixed tx SUBSET-routes its P2PKH inputs; the custom template signs itself', async () => {
    const n = 3
    const { build } = fixture(n)
    const custom = {
      sign: async () => UnlockingScript.fromHex('51'),
      estimateLength: async () => 1
    }
    const make = (): Transaction => {
      const tx = build()
      tx.inputs[1].unlockingScriptTemplate = custom // non-P2PKH template on input 1
      return tx
    }
    const twin = await manualSign(make())
    const calls: Uint8Array[] = []
    g.__bsvEngineNative = {
      batchSignP2pkhInputs: async (_skel: ArrayBuffer, metas: ArrayBuffer) => {
        calls.push(new Uint8Array(metas))
        return engineReplyFromTwin(twin, [0, 2]) // only the P2PKH subset
      }
    }
    const tx = make()
    await tx.sign()
    // engine engaged once, for the P2PKH subset [0, 2] only (2 × 73-byte meta)
    expect(calls).toHaveLength(1)
    expect(calls[0].length).toBe(2 * 73)
    const mdv = new DataView(calls[0].buffer)
    expect([mdv.getUint32(0, true), mdv.getUint32(73, true)]).toEqual([0, 2])
    // custom template signed itself; full tx byte-identical to per-template signing
    expect(tx.inputs[1].unlockingScript!.toHex()).toBe('51')
    expect(tx.toHex()).toBe(twin.toHex())
  })

  it('CR-5: a mixed-tx engine rejection falls back to tier 2 and reproduces the SDK bytes', async () => {
    const n = 3
    const { build } = fixture(n)
    const custom = {
      sign: async () => UnlockingScript.fromHex('51'),
      estimateLength: async () => 1
    }
    const make = (): Transaction => {
      const tx = build()
      tx.inputs[1].unlockingScriptTemplate = custom
      return tx
    }
    const twin = await manualSign(make())
    let called = 0
    g.__bsvEngineNative = { batchSignP2pkhInputs: async () => { called++; throw new Error('NotP2pkh { input_index: 0 }') } }
    const tx = make()
    await tx.sign()
    expect(called).toBe(1) // engine attempted the subset, then tier 2 carried the whole tx
    expect(tx.toHex()).toBe(twin.toHex())
  })

  it('a non-P2PKH lockingScript override on the P2PKH template is ineligible', async () => {
    const n = 2
    const weird = UnlockingScript.fromHex('76a95188ac') // not 25-byte P2PKH shape
    const { build } = fixture(n, { lockingScriptOverride: weird })
    const twin = await manualSign(build())
    let called = 0
    g.__bsvEngineNative = { batchSignP2pkhInputs: async () => { called++; throw new Error('never') } }
    const tx = build()
    await tx.sign()
    expect(called).toBe(0)
    expect(tx.toHex()).toBe(twin.toHex())
  })

  it('engine absent → tier 2 batchEcdsaSign carries the tx (one crossing, same bytes)', async () => {
    const n = 5
    const { build } = fixture(n, { mixScopes: true })
    const twin = await manualSign(build())
    let batchCalls = 0
    g.__bsvSecpNative = {
      batchEcdsaSign: async (msgs: ArrayBuffer, keys: ArrayBuffer): Promise<ArrayBuffer> => {
        batchCalls++
        const m = new Uint8Array(msgs)
        const k = new Uint8Array(keys)
        const count = m.length / 32
        const parts: number[] = []
        for (let i = 0; i < count; i++) {
          const key = new PrivateKey(Array.from(k.subarray(i * 32, (i + 1) * 32)))
          const msg = new BigNumber(Array.from(m.subarray(i * 32, (i + 1) * 32)))
          const der = ECDSA.sign(msg, key, true).toDER() as number[]
          const pub = key.toPublicKey().encode(true) as number[]
          parts.push(der.length, ...der, ...pub)
        }
        return Uint8Array.from(parts).buffer as ArrayBuffer
      }
    }
    const tx = build()
    await tx.sign()
    expect(batchCalls).toBe(1)
    expect(tx.toHex()).toBe(twin.toHex())
  })
})
