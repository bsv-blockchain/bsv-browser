/** SDK 2.8 signing keeps its snapshot and atomic commit guards.
 * Native ECDSA primitives remain accelerated; the legacy transaction batch
 * shortcut is intentionally not installed because it predates those guards. */
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


afterEach(() => { delete g.__bsvEngineNative; delete g.__bsvSecpNative; jest.restoreAllMocks() })

describe('SDK 2.8 guarded signing with primitive acceleration', () => {
  it.each([
    ['5 inputs, ALL', 5, {}],
    ['7 inputs, mixed scopes', 7, { mixScopes: true }],
    ['1 input', 1, {}],
    ['SINGLE beyond outputs', 3, { signOutputs: 'single' as const, nOutputs: 1 }]
  ])('%s preserves the reference signatures', async (_label, n, opts) => {
    const { build } = fixture(n, opts)
    const expected = await manualSign(build())
    const engine = jest.fn(() => { throw new Error('obsolete batch route') })
    const batch = jest.fn(() => { throw new Error('obsolete batch route') })
    let primitiveCalls = 0
    g.__bsvEngineNative = { batchSignP2pkhInputs: engine }
    g.__bsvSecpNative = {
      batchEcdsaSign: batch,
      ecdsaSign(message: ArrayBuffer, key: ArrayBuffer) {
        primitiveCalls++
        const backend = g.__bsvSecpNative
        g.__bsvSecpNative = {}
        try { return Uint8Array.from(ECDSA.sign(new BigNumber(Array.from(new Uint8Array(message))), new BigNumber(Array.from(new Uint8Array(key))), true).toDER() as number[]) }
        finally { g.__bsvSecpNative = backend }
      }
    }
    const actual = build(); await actual.sign()
    expect(actual.toHex()).toBe(expected.toHex())
    expect(primitiveCalls).toBe(n)
    expect(engine).not.toHaveBeenCalled(); expect(batch).not.toHaveBeenCalled()
  })

  it.each(['output', 'source', 'template'] as const)('rejects a changed %s while async signing without applying partial scripts', async mutation => {
    const tx = fixture(2).build()
    let release!: () => void, entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    const original = tx.inputs[0].unlockingScriptTemplate!
    tx.inputs[0].unlockingScriptTemplate = {
      estimateLength: original.estimateLength,
      sign: async (snapshot, index) => { entered(); await gate; return await original.sign(snapshot, index) }
    }
    const signing = tx.sign(); await started
    if (mutation === 'output') tx.outputs[0].satoshis!--
    if (mutation === 'source') tx.inputs[0].sourceTransaction!.outputs[0].satoshis!++
    if (mutation === 'template') tx.inputs[1].unlockingScriptTemplate = { estimateLength: async () => 1, sign: async () => UnlockingScript.fromHex('51') }
    release()
    await expect(signing).rejects.toThrow('Transaction changed while signing')
    expect(tx.inputs.every(input => input.unlockingScript === undefined)).toBe(true)
  })

  it('commits no input when a signing template rejects', async () => {
    const tx = fixture(2).build()
    tx.inputs[1].unlockingScriptTemplate = { estimateLength: async () => 1, sign: async () => { throw new Error('signer unavailable') } }
    await expect(tx.sign()).rejects.toThrow('signer unavailable')
    expect(tx.inputs.every(input => input.unlockingScript === undefined)).toBe(true)
  })

  it('preserves an existing signature only when explicitly requested', async () => {
    const tx = fixture(2).build()
    tx.inputs[0].unlockingScript = UnlockingScript.fromHex('5151')
    const signer = jest.spyOn(tx.inputs[0].unlockingScriptTemplate!, 'sign')
    await tx.sign({ skipExistingSignatures: true })
    expect(signer).not.toHaveBeenCalled()
    expect(tx.inputs[0].unlockingScript.toHex()).toBe('5151')
    expect(tx.inputs[1].unlockingScript).toBeDefined()
  })
})
