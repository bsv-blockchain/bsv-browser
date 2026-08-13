/**
 * Vault access guard — external origins must not reach privileged (vault) key
 * material. The load-bearing defense against the privilege-escalation finding.
 */
import { guardVaultAccess, VaultAccessDenied } from '../../services/vault/guard'

const ADMIN = 'admin.com'

function fakeWallet() {
  const calls: { method: string; args: any; originator?: string }[] = []
  const rec = (method: string) => (args: any, originator?: string) => {
    calls.push({ method, args, originator })
    return Promise.resolve({ ok: true, method })
  }
  return {
    calls,
    wallet: {
      getPublicKey: rec('getPublicKey'),
      createSignature: rec('createSignature'),
      encrypt: rec('encrypt'),
      decrypt: rec('decrypt'),
      createHmac: rec('createHmac'),
      verifyHmac: rec('verifyHmac'),
      verifySignature: rec('verifySignature'),
      revealCounterpartyKeyLinkage: rec('revealCounterpartyKeyLinkage'),
      revealSpecificKeyLinkage: rec('revealSpecificKeyLinkage'),
      // not privileged-capable → must always pass through
      listOutputs: rec('listOutputs'),
      createAction: rec('createAction'),
      signAction: rec('signAction')
    } as any
  }
}

test('blocks non-admin privileged getPublicKey (deposit-key enumeration)', async () => {
  const { wallet } = fakeWallet()
  const guarded = guardVaultAccess(wallet, ADMIN)
  await expect(
    guarded.getPublicKey({ privileged: true, protocolID: [2, 'vault'], keyID: 'vault/0', counterparty: 'self' } as any, 'evil.com')
  ).rejects.toBeInstanceOf(VaultAccessDenied)
})

test('blocks non-admin privileged createSignature (the spend signature)', async () => {
  const { wallet } = fakeWallet()
  const guarded = guardVaultAccess(wallet, ADMIN)
  await expect(
    guarded.createSignature({ privileged: true, protocolID: [2, 'vault'], keyID: 'vault/0', hashToDirectlySign: [1] } as any, 'evil.com')
  ).rejects.toBeInstanceOf(VaultAccessDenied)
})

test('allows admin-originated privileged ops (the vault UI)', async () => {
  const { wallet, calls } = fakeWallet()
  const guarded = guardVaultAccess(wallet, ADMIN)
  await guarded.createSignature({ privileged: true, protocolID: [2, 'vault'], keyID: 'vault/0' } as any, ADMIN)
  expect(calls.find(c => c.method === 'createSignature')).toBeDefined()
})

test('allows non-privileged ops from any origin', async () => {
  const { wallet, calls } = fakeWallet()
  const guarded = guardVaultAccess(wallet, ADMIN)
  await guarded.getPublicKey({ protocolID: [1, 'x'], keyID: '1', counterparty: 'self' } as any, 'evil.com')
  expect(calls.find(c => c.method === 'getPublicKey')).toBeDefined()
})

test('passes non-privileged-capable methods straight through, even privileged-looking args', async () => {
  const { wallet, calls } = fakeWallet()
  const guarded = guardVaultAccess(wallet, ADMIN)
  // createAction is not in the privileged set — the guard never blocks it; the
  // point is it cannot obtain vault signatures anyway (createSignature blocked).
  await guarded.createAction({ privileged: true } as any, 'evil.com')
  await guarded.listOutputs({ basket: 'x' } as any, 'evil.com')
  expect(calls.map(c => c.method).sort()).toEqual(['createAction', 'listOutputs'])
})

test('treats missing/false privileged flag as allowed', async () => {
  const { wallet, calls } = fakeWallet()
  const guarded = guardVaultAccess(wallet, ADMIN)
  await guarded.encrypt({ privileged: false, protocolID: [2, 'x'], keyID: '1' } as any, 'evil.com')
  await guarded.decrypt({ protocolID: [2, 'x'], keyID: '1' } as any, 'evil.com')
  expect(calls).toHaveLength(2)
})
