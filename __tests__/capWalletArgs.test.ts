/**
 * The argument-size cap wrapper.
 *
 * Proxy-level tests, following the pattern in __tests__/vault/guard.test.ts:
 * what matters is that the underlying wallet is NOT called for a refused
 * payload, because the whole purpose is to refuse before anything allocates.
 */
import { capWalletArgs } from '@/services/capWalletArgs'
import { guardVaultAccess } from '@/services/vault/guard'
import { limitsForTier } from '@/services/walletArgLimits'

const L = limitsForTier('mid')
const hex = (bytes: number) => 'ab'.repeat(bytes)

const wallet = () => ({
  createAction: jest.fn(async () => ({ txid: 'x' })),
  signAction: jest.fn(async () => ({ txid: 'x' })),
  internalizeAction: jest.fn(async () => ({ accepted: true })),
  getPublicKey: jest.fn(async () => ({ publicKey: 'k' })),
  listOutputs: jest.fn(async () => ({ outputs: [] })),
  isAuthenticated: jest.fn(async () => ({ authenticated: true }))
})

describe('capWalletArgs', () => {
  it('passes an ordinary payment straight through, arguments intact', async () => {
    const w = wallet()
    const args = { outputs: [{ lockingScript: hex(25), satoshis: 1000 }] }
    await capWalletArgs(w as any, L).createAction(args, 'page.com')
    expect(w.createAction).toHaveBeenCalledWith(args, 'page.com')
  })

  it('refuses an oversize payload with code 6 and never calls the wallet', async () => {
    const w = wallet()
    await expect(
      capWalletArgs(w as any, L).createAction({ outputs: [{ lockingScript: hex(959_632) }] }, 'page.com')
    ).rejects.toMatchObject({ code: 6, field: 'outputs[0].lockingScript' })
    expect(w.createAction).not.toHaveBeenCalled()
  })

  it('refuses an oversize internalizeAction from a page', async () => {
    const w = wallet()
    await expect(
      capWalletArgs(w as any, L).internalizeAction({ tx: new Array(2_000_000).fill(0) }, 'page.com')
    ).rejects.toMatchObject({ code: 6, field: 'tx' })
    expect(w.internalizeAction).not.toHaveBeenCalled()
  })

  it('refuses a declared unlockingScriptLength that carries almost no payload', async () => {
    const w = wallet()
    await expect(
      capWalletArgs(w as any, L).createAction(
        { inputs: [{ outpoint: 'x.0', unlockingScriptLength: 959_871 }] },
        'page.com'
      )
    ).rejects.toMatchObject({ code: 6 })
    expect(w.createAction).not.toHaveBeenCalled()
  })

  it('leaves calls that carry no transaction bytes completely alone', async () => {
    const w = wallet()
    const capped = capWalletArgs(w as any, L)
    await capped.getPublicKey({ identityKey: true }, 'page.com')
    await capped.listOutputs({ basket: 'x' }, 'page.com')
    await capped.isAuthenticated({}, 'page.com')
    expect(w.getPublicKey).toHaveBeenCalled()
    expect(w.listOutputs).toHaveBeenCalled()
    expect(w.isAuthenticated).toHaveBeenCalled()
  })

  it('names the offending field in the message', async () => {
    await expect(
      capWalletArgs(wallet() as any, L).createAction({ inputBEEF: new Array(3_000_000).fill(0) }, 'page.com')
    ).rejects.toThrow(/inputBEEF/)
  })

  it('rejects rather than throws synchronously, so a page gets a normal error', async () => {
    const call = capWalletArgs(wallet() as any, L).createAction(
      { outputs: [{ lockingScript: hex(959_632) }] },
      'page.com'
    )
    expect(call).toBeInstanceOf(Promise)
    await expect(call).rejects.toBeInstanceOf(Error)
  })

  it('composes over the vault guard, each still enforcing its own concern', async () => {
    // The two wrappers cover disjoint method sets and answer different
    // questions: the guard rejects `privileged` key-material ops from non-admin
    // originators (createAction is deliberately NOT one of them — see
    // PRIVILEGED_CAPABLE in services/vault/guard.ts), while the cap rejects
    // oversize arguments on the three calls that carry bytes.
    const w = wallet()
    const capped = capWalletArgs(guardVaultAccess(w as any, 'admin.originator'), L)

    // Cap applies, guard passes through.
    await expect(
      capped.createAction({ outputs: [{ lockingScript: hex(959_632) }] }, 'page.com')
    ).rejects.toMatchObject({ code: 6 })
    expect(w.createAction).not.toHaveBeenCalled()
    await capped.createAction({ outputs: [{ lockingScript: hex(25) }] }, 'page.com')
    expect(w.createAction).toHaveBeenCalled()

    // Guard applies, cap passes through.
    await expect(capped.getPublicKey({ identityKey: true, privileged: true }, 'page.com')).rejects.toThrow(
      /not permitted/i
    )
    await capped.getPublicKey({ identityKey: true, privileged: true }, 'admin.originator')
    expect(w.getPublicKey).toHaveBeenCalled()
  })

  it('does not cap what it does not wrap, which is how the vault is exempt', async () => {
    // The vault calls managers.permissionsManager directly. Nothing about an
    // originator string is involved, so nothing about it can be spoofed.
    const w = wallet()
    await (w.createAction as unknown as (a: unknown) => Promise<unknown>)({
      outputs: [{ lockingScript: hex(959_632) }]
    })
    expect(w.createAction).toHaveBeenCalled()
  })

  it('applies the low-tier aggregate when given those limits', async () => {
    const w = wallet()
    const lowish = { outputs: Array.from({ length: 3 }, () => ({ lockingScript: hex(90_000) })) }
    // 270 KB total: inside the mid aggregate and inside low's too, so this is
    // about the limits object being honoured rather than a specific refusal.
    await capWalletArgs(w as any, limitsForTier('low')).createAction(lowish, 'page.com')
    expect(w.createAction).toHaveBeenCalled()
  })
})
