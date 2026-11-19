/**
 * The limits on the wallet handed to in-tab pages.
 *
 * A covenant whose witness carries data (a hashed body, a merkle path, a BEEF)
 * supplies an unlocking script far larger than a P2PKH one. Those bytes are
 * already counted by the per-call aggregate, which is the memory bound, so the
 * per-input caps on unlocking scripts sit at the aggregate rather than at
 * 100,000. The case below is a real one: a post publish whose input script was
 * 339,094 bytes, refused before any sheet with "The inputs[0].unlockingScriptLength
 * parameter must be at most 100000 bytes (got 339094)".
 */
import { capWalletArgs } from '@bsv/expo-wallet-toolbox/core/services/capWalletArgs'
import { limitsForTier } from '@bsv/expo-wallet-toolbox/core/services/walletArgLimits'
import { pageWalletArgLimits } from '../utils/pageWalletArgLimits'

const MB = 1024 * 1024
const hex = (bytes: number) => 'ab'.repeat(bytes)
const WITNESS = 339_094
const COVENANT_INPUT = `${'11'.repeat(32)}.0`

const wallet = () => ({
  createAction: jest.fn(async () => ({ txid: 'x' })),
  signAction: jest.fn(async () => ({ txid: 'x' }))
})

describe('pageWalletArgLimits', () => {
  it('accepts a 339,094-byte supplied unlockingScript on a covenant input', async () => {
    const w = wallet()
    const args = {
      inputs: [
        {
          outpoint: COVENANT_INPUT,
          inputDescription: 'Covenant input',
          unlockingScript: hex(WITNESS),
          unlockingScriptLength: WITNESS
        }
      ],
      outputs: [{ lockingScript: hex(25), satoshis: 1 }]
    }
    await capWalletArgs(w as any, pageWalletArgLimits('mid')).createAction(args as any, 'page.com')
    expect(w.createAction).toHaveBeenCalledWith(args, 'page.com')
  })

  it('accepts the same witness on the low tier, inside its 2 MB aggregate', async () => {
    const w = wallet()
    await capWalletArgs(w as any, pageWalletArgLimits('low')).createAction(
      { inputs: [{ outpoint: COVENANT_INPUT, unlockingScript: hex(WITNESS) }] } as any,
      'page.com'
    )
    expect(w.createAction).toHaveBeenCalled()
  })

  it('accepts the same witness supplied later through a signAction spend', async () => {
    const w = wallet()
    await capWalletArgs(w as any, pageWalletArgLimits('mid')).signAction(
      { reference: 'r', spends: { 0: { unlockingScript: hex(WITNESS) } } } as any,
      'page.com'
    )
    expect(w.signAction).toHaveBeenCalled()
  })

  it('accepts a declared length that a later signAction will honour', async () => {
    // Production has mined covenant spends with 1.9 MB unlocking scripts.
    const w = wallet()
    await capWalletArgs(w as any, pageWalletArgLimits('mid')).createAction(
      { inputs: [{ outpoint: COVENANT_INPUT, unlockingScriptLength: 1_900_000 }] } as any,
      'page.com'
    )
    expect(w.createAction).toHaveBeenCalled()
  })

  it('refuses a supplied unlockingScript over the 4 MB aggregate', async () => {
    const w = wallet()
    await expect(
      capWalletArgs(w as any, pageWalletArgLimits('mid')).createAction(
        { inputs: [{ outpoint: COVENANT_INPUT, unlockingScript: hex(4 * MB + 1) }] } as any,
        'page.com'
      )
    ).rejects.toMatchObject({
      code: 6,
      field: 'inputs[0].unlockingScript',
      message: `The inputs[0].unlockingScript parameter must be at most ${4 * MB} bytes (got ${4 * MB + 1})`
    })
    expect(w.createAction).not.toHaveBeenCalled()
  })

  it('refuses a signAction spend over the 4 MB aggregate', async () => {
    const w = wallet()
    await expect(
      capWalletArgs(w as any, pageWalletArgLimits('mid')).signAction(
        { reference: 'r', spends: { 0: { unlockingScript: hex(4 * MB + 1) } } } as any,
        'page.com'
      )
    ).rejects.toMatchObject({
      code: 6,
      field: 'spends[0].unlockingScript',
      message: `The spends[0].unlockingScript parameter must be at most ${4 * MB} bytes (got ${4 * MB + 1})`
    })
    expect(w.signAction).not.toHaveBeenCalled()
  })

  it('refuses a declared unlockingScriptLength over the aggregate', async () => {
    const w = wallet()
    await expect(
      capWalletArgs(w as any, pageWalletArgLimits('mid')).createAction(
        { inputs: [{ outpoint: COVENANT_INPUT, unlockingScriptLength: 4 * MB + 1 }] } as any,
        'page.com'
      )
    ).rejects.toMatchObject({
      code: 6,
      field: 'inputs[0].unlockingScriptLength',
      message: `The inputs[0].unlockingScriptLength parameter must be at most ${4 * MB} bytes (got ${4 * MB + 1})`
    })
    expect(w.createAction).not.toHaveBeenCalled()
  })

  it('refuses declared lengths that are each fine but sum past the aggregate', async () => {
    const w = wallet()
    const inputs = Array.from({ length: 3 }, (_, i) => ({
      outpoint: `${'11'.repeat(32)}.${i}`,
      unlockingScriptLength: 1.5 * MB
    }))
    await expect(
      capWalletArgs(w as any, pageWalletArgLimits('mid')).createAction({ inputs } as any, 'page.com')
    ).rejects.toMatchObject({ code: 6, field: 'inputs.unlockingScriptLength' })
    expect(w.createAction).not.toHaveBeenCalled()
  })

  it('keeps the aggregate as the one memory bound across supplied scripts', async () => {
    const w = wallet()
    const inputs = Array.from({ length: 3 }, (_, i) => ({
      outpoint: `${'11'.repeat(32)}.${i}`,
      unlockingScript: hex(1.5 * MB)
    }))
    await expect(
      capWalletArgs(w as any, pageWalletArgLimits('mid')).createAction({ inputs } as any, 'page.com')
    ).rejects.toMatchObject({ code: 6, field: 'aggregate' })
    expect(w.createAction).not.toHaveBeenCalled()
  })

  it('holds the low tier to its 2 MB aggregate', async () => {
    const w = wallet()
    const capped = capWalletArgs(w as any, pageWalletArgLimits('low'))
    await expect(
      capped.createAction(
        { inputs: [{ outpoint: COVENANT_INPUT, unlockingScript: hex(2 * MB + 1) }] } as any,
        'page.com'
      )
    ).rejects.toMatchObject({
      code: 6,
      message: `The inputs[0].unlockingScript parameter must be at most ${2 * MB} bytes (got ${2 * MB + 1})`
    })
    await expect(
      capped.createAction(
        { inputs: [{ outpoint: COVENANT_INPUT, unlockingScriptLength: 2 * MB + 1 }] } as any,
        'page.com'
      )
    ).rejects.toMatchObject({
      code: 6,
      message: `The inputs[0].unlockingScriptLength parameter must be at most ${2 * MB} bytes (got ${2 * MB + 1})`
    })
    expect(w.createAction).not.toHaveBeenCalled()

    await capped.createAction(
      { inputs: [{ outpoint: COVENANT_INPUT, unlockingScript: hex(1.5 * MB) }] } as any,
      'page.com'
    )
    expect(w.createAction).toHaveBeenCalled()
  })

  it.each(['low', 'mid', 'high'] as const)('changes no other limit on the %s tier', tier => {
    const base = limitsForTier(tier)
    const page = pageWalletArgLimits(tier)
    expect(page.aggregate).toBe(base.aggregate)
    expect({ ...page, unlockingScript: 0, unlockingScriptLength: 0, unlockingScriptLengthTotal: 0 }).toEqual({
      ...base,
      unlockingScript: 0,
      unlockingScriptLength: 0,
      unlockingScriptLengthTotal: 0
    })
    expect(page.unlockingScript).toBe(base.aggregate)
    expect(page.unlockingScriptLength).toBe(base.aggregate)
    expect(page.unlockingScriptLengthTotal).toBe(base.aggregate)
  })
})
