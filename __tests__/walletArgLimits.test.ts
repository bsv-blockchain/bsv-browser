/**
 * Size limits for wallet-interface arguments.
 *
 * The numbers come from spec §5: peak RSS is ~20-30x the payload on this stack,
 * so a 4 MB call is ~120 MB and a 100 MB transaction would be 2-3 GB — an
 * uncatchable Hermes abort, not an exception. Every check must therefore refuse
 * BEFORE anything allocates, which is why nothing here serialises: sizes are
 * summed from lengths that are already materialised.
 */
import { checkWalletArgs, limitsForTier } from '@/services/walletArgLimits'

const L = limitsForTier('mid')
const hex = (bytes: number) => 'ab'.repeat(bytes)

describe('checkWalletArgs', () => {
  it('passes the payloads pages actually send', () => {
    // The largest legitimate page payloads in this app today: a localpay
    // AtomicBEEF at 65,536 bytes and a ~25-byte P2PKH locking script.
    expect(checkWalletArgs('createAction', { outputs: [{ lockingScript: hex(25) }] }, L)).toBeNull()
    expect(checkWalletArgs('internalizeAction', { tx: new Array(65_536).fill(0) }, L)).toBeNull()
  })

  it('refuses a single oversize locking script', () => {
    const r = checkWalletArgs('createAction', { outputs: [{ lockingScript: hex(959_632) }] }, L)
    expect(r?.field).toBe('outputs[0].lockingScript')
    expect(r?.actual).toBe(959_632)
    expect(r?.limit).toBe(L.outputScript)
  })

  it('refuses a declared unlockingScriptLength that no byte cap would catch', () => {
    // The SDK only cross-checks this against a supplied script and never bounds
    // it, so a page can declare 959,871 per input with an almost empty payload
    // and still make the wallet fund and build a ~1 MB-per-input transaction.
    const r = checkWalletArgs(
      'createAction',
      { inputs: [{ outpoint: 'x', unlockingScriptLength: 959_871 }] },
      L
    )
    expect(r?.field).toBe('inputs[0].unlockingScriptLength')
  })

  it('refuses on the summed declared unlockingScriptLength', () => {
    const inputs = Array.from({ length: 20 }, () => ({ outpoint: 'x', unlockingScriptLength: 90_000 }))
    expect(checkWalletArgs('createAction', { inputs }, L)?.field).toBe('inputs.unlockingScriptLength')
  })

  it('refuses a 0xff-leading locking script outright', () => {
    // Provably unspendable, so nothing legitimate wants one, and refusing it
    // closes the decoder-poisoning path in spec §5.1.
    const r = checkWalletArgs('createAction', { outputs: [{ lockingScript: 'ff00' }] }, L)
    expect(r?.field).toBe('outputs[0].lockingScript')
    expect(r?.message).toMatch(/unspendable/i)
  })

  it('accepts a script that merely contains 0xff later on', () => {
    expect(checkWalletArgs('createAction', { outputs: [{ lockingScript: '76ff' }] }, L)).toBeNull()
  })

  it('refuses on the aggregate even when every field is individually fine', () => {
    const outputs = Array.from({ length: 60 }, () => ({ lockingScript: hex(90_000) }))
    const r = checkWalletArgs('createAction', { outputs }, L)
    expect(r).not.toBeNull()
    expect(['outputs.lockingScript', 'aggregate']).toContain(r!.field)
  })

  it('caps inputBEEF and internalizeAction tx separately', () => {
    expect(checkWalletArgs('createAction', { inputBEEF: new Array(3_000_000).fill(0) }, L)?.field).toBe('inputBEEF')
    expect(checkWalletArgs('internalizeAction', { tx: new Array(2_000_000).fill(0) }, L)?.field).toBe('tx')
  })

  it('caps array lengths', () => {
    expect(
      checkWalletArgs(
        'createAction',
        { outputs: Array.from({ length: 1001 }, () => ({ lockingScript: '00' })) },
        L
      )?.field
    ).toBe('outputs.length')
    expect(
      checkWalletArgs('createAction', { inputs: Array.from({ length: 1001 }, () => ({ outpoint: 'x' })) }, L)?.field
    ).toBe('inputs.length')
  })

  it('caps customInstructions per output', () => {
    expect(
      checkWalletArgs(
        'createAction',
        { outputs: [{ lockingScript: '00', customInstructions: 'x'.repeat(5000) }] },
        L
      )?.field
    ).toBe('outputs[0].customInstructions')
  })

  it('caps a supplied unlockingScript on createAction inputs', () => {
    expect(
      checkWalletArgs('createAction', { inputs: [{ outpoint: 'x', unlockingScript: hex(200_000) }] }, L)?.field
    ).toBe('inputs[0].unlockingScript')
  })

  it('caps signAction spends', () => {
    expect(checkWalletArgs('signAction', { spends: { 0: { unlockingScript: hex(200_000) } } }, L)?.field).toBe(
      'spends[0].unlockingScript'
    )
  })

  it('halves the aggregate on a low-tier device', () => {
    expect(limitsForTier('low').aggregate).toBe(limitsForTier('mid').aggregate / 2)
    expect(limitsForTier('high').aggregate).toBe(limitsForTier('mid').aggregate)
  })

  it('ignores calls that carry no transaction bytes', () => {
    expect(checkWalletArgs('getPublicKey', { identityKey: true }, L)).toBeNull()
    expect(checkWalletArgs('listOutputs', { basket: 'x' }, L)).toBeNull()
    expect(checkWalletArgs('encrypt', { plaintext: new Array(5_000_000).fill(0) }, L)).toBeNull()
  })

  it('survives malformed args without throwing', () => {
    const cases: unknown[] = [
      null,
      undefined,
      'string',
      42,
      { outputs: 'nope' },
      { outputs: [null] },
      { outputs: [{ lockingScript: 42 }] },
      { inputs: [{ unlockingScriptLength: 'big' }] },
      { inputBEEF: 'not-an-array' },
      { spends: null }
    ]
    for (const args of cases) {
      expect(() => checkWalletArgs('createAction', args, L)).not.toThrow()
      expect(() => checkWalletArgs('signAction', args, L)).not.toThrow()
      expect(() => checkWalletArgs('internalizeAction', args, L)).not.toThrow()
    }
  })

  it('reports a message naming the field and the limit', () => {
    const r = checkWalletArgs('createAction', { inputBEEF: new Array(3_000_000).fill(0) }, L)
    expect(r?.message).toContain('inputBEEF')
    expect(r?.message).toContain(String(L.inputBEEF))
  })
})
