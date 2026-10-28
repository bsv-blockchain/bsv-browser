import assert from 'node:assert/strict'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import ts from 'typescript'
import { KeyDeriver, PrivateKey, ProtoWallet } from '@bsv/sdk'
import { WalletPermissionsManager } from '@bsv/wallet-toolbox-mobile'
const compiled = new URL('./.permission-session-host.mjs', import.meta.url)
await writeFile(compiled, ts.transpileModule(await readFile(new URL('../ecpm/ecpmSession.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText)
try {
  const { EcpmSession } = await import(compiled.href)
  let manager
  const session = new EcpmSession(() => manager)
  const unsubscribe = session.subscribe(() => {})
  const keyDeriver = new KeyDeriver(new PrivateKey(17)), underlying = new ProtoWallet(keyDeriver)
  underlying.listOutputs = async () => ({ totalOutputs: 0, outputs: [] })
  manager = new WalletPermissionsManager(underlying, 'wallet.local', {
    preferAppPermissionGroups: true, differentiateActionLabelOperations: true,
    permissionModules: { ecpm: session.replace({ keyDeriver }) }
  })
  const permissions = { protocolPermissions: [
    { protocolID: [2, 'p ecpm poker demo deck masking'], counterparty: 'self', description: 'Protect cards' },
    { protocolID: [2, 'poker demo transcript'], counterparty: 'anyone', description: 'Sign game messages' }
  ] }
  manager.fetchManifestGroupPermissions = async () => permissions
  let groups = 0, individuals = 0
  manager.bindCallback('onGroupedPermissionRequested', async request => {
    groups++; assert.equal(request.permissions.protocolPermissions.length, 2)
    await manager.grantGroupedPermission({ requestID: request.requestID, granted: request.permissions, sessionDurationMs: 1_800_000 })
  })
  manager.bindCallback('onProtocolPermissionRequested', async request => { individuals++; await manager.denyPermission(request.requestID) })
  const origin = 'poker.example', point = new PrivateKey(31).toPublicKey().toString()
  const args = (operation, value) => ({ protocolID: [2, `p ecpm ${operation} ${value} poker demo deck masking`], keyID: 'table/hand/one', counterparty: 'self' })
  await manager.getPublicKey({ protocolID: [2, 'poker demo transcript'], keyID: 'table', counterparty: 'anyone' }, origin)
  let masked
  for (let i = 0; i < 167; i++) masked = (await manager.getPublicKey(args('apply', point), origin)).publicKey
  assert.equal((await manager.getPublicKey(args('remove', masked), origin)).publicKey, point)
  await manager.createSignature({ protocolID: [2, 'poker demo transcript'], keyID: 'table', counterparty: 'anyone', data: [1, 2, 3] }, origin)
  assert.equal(groups, 1); assert.equal(individuals, 0); assert.equal(manager.listSessionPermissions().length, 2)
  manager.revokeSessionPermissions(origin)
  await assert.rejects(manager.getPublicKey({ ...args('apply', point), seekPermission: false }, origin))
  assert.equal(groups, 1, 'seekPermission=false must not display a new group')
  assert.equal(session.getSnapshot(), null)
  session.dispose(); unsubscribe()
  console.log('Session integration passed: 167 ECPM calls plus signing; one grouped decision, no individual prompts, immediate revocation, no-prompt refusal.')
} finally { await unlink(compiled) }
