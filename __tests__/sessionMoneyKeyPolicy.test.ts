import { KeyDeriver, PrivateKey, ProtoWallet } from '@bsv/sdk'
import { SigningPolicyPermissionsManager } from '@bsv/expo-wallet-toolbox/core/services/signingPermissionPolicy'

it('refuses a session grant for BRC-29 money keys and keeps every signature separately gated', async () => {
  const wallet = new ProtoWallet(new KeyDeriver(new PrivateKey(17)))
  Object.assign(wallet, { listOutputs: async () => ({ totalOutputs: 0, outputs: [] }) })
  const manager = new SigningPolicyPermissionsManager(wallet as never, 'wallet.local', { preferAppPermissionGroups: true })
  ;(manager as any).fetchManifestPermissions = async () => ({ groupPermissions: null, counterpartyPermissions: null })
  const requests: Array<{ requestID: string }> = []
  manager.bindCallback('onProtocolPermissionRequested', (request: { requestID: string }) => { requests.push(request) })
  for (let i = 0; i < 2; i++) {
    const pending = manager.createSignature({ protocolID: [2, '3241645161d8'], keyID: 'money/' + i, counterparty: 'self', data: [1, 2, 3] }, 'poker.example')
    const refused = expect(pending).rejects.toThrow(/denied/i)
    for (let spin = 0; spin < 200 && requests.length <= i; spin++) await Promise.resolve()
    expect(requests).toHaveLength(i + 1)
    await expect(manager.grantPermission({ requestID: requests[i].requestID, sessionDurationMs: 1_800_000 })).rejects.toThrow(/each call/)
    expect(manager.listSessionPermissions()).toHaveLength(0)
    await manager.denyPermission(requests[i].requestID)
    await refused
  }
})
