import assert from 'node:assert/strict'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import ts from 'typescript'
import { KeyDeriver, PrivateKey, PublicKey, ProtoWallet, WalletWireProcessor, WalletWireTransceiver } from '@bsv/sdk'
import { WalletPermissionsManager, PrivilegedKeyManager } from '@bsv/wallet-toolbox-mobile'

// Exercise the shipped host adapter with published cryptography and the real
// permission manager and binary BRC-100 transport. No network or wallet funds.
const source = new URL('../ecpm/ecpmSession.ts', import.meta.url)
const compiled = new URL('./.ecpm-session-test.mjs', import.meta.url)
await writeFile(compiled, ts.transpileModule(await readFile(source, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText)
try {
  const { EcpmSession, ecpmConsentText } = await import(compiled.href)
  const keyDeriver = new KeyDeriver(new PrivateKey(17))
  const point = new PrivateKey(31).toPublicKey().toString()
  const session = new EcpmSession()
  const unsubscribe = session.subscribe(() => {})
  const host = { keyDeriver }
  const module = session.replace(host)
  let ordinaryCalls = 0
  const underlying = new ProtoWallet(keyDeriver)
  const originalGetPublicKey = underlying.getPublicKey.bind(underlying)
  underlying.getPublicKey = (...args) => { ordinaryCalls++; return originalGetPublicKey(...args) }
  const manager = new WalletPermissionsManager(underlying, 'wallet.local', { permissionModules: { ecpm: module } })
  const args = (operation = 'apply', p = point, extra = {}) => ({
    protocolID: [2, `p ecpm ${operation} ${p} mental poker deal`],
    keyID: 'deck mask', counterparty: 'self', ...extra
  })
  const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
  let calls = 0
  async function approved(call) {
    const result = call()
    await settle()
    const prompt = session.getSnapshot()
    assert.ok(prompt, 'a trusted prompt must precede the cryptographic operation')
    assert.match(ecpmConsentText(prompt.request), /mental poker deal/)
    assert.match(ecpmConsentText(prompt.request), /all key IDs/)
    prompt.answer(true)
    calls++
    return result
  }
  const applied = await approved(() => manager.getPublicKey(args(), 'game.example'))
  const scalar = keyDeriver.derivePrivateKey([2, 'p ecpm mental poker deal'], 'deck mask', 'self')
  assert.equal(applied.publicKey, PublicKey.fromString(point).mul(scalar).encode(true, 'hex'))
  assert.notEqual(applied.publicKey, point)
  assert.deepEqual(Object.keys(applied), ['publicKey'])
  assert.equal(ordinaryCalls, 0, 'semantic ECPM must never fall through to ordinary getPublicKey')
  assert.equal((await manager.getPublicKey(args('remove', applied.publicKey), 'game.example')).publicKey, point)
  assert.equal(session.getSnapshot(), null, 'same grant covers inverse and other points')
  assert.equal((await manager.getPublicKey(args('remove', applied.publicKey, { seekPermission: false }), 'game.example')).publicKey, point)
  await assert.rejects(manager.getPublicKey(args('apply', point, { seekPermission: false }), 'other.example'))
  assert.ok((await manager.getPublicKey(args('apply', point, { keyID: 'other deck', seekPermission: false }), 'game.example')).publicKey)
  const denied = manager.getPublicKey(args('apply', point, { counterparty: 'anyone' }), 'game.example')
  const denial = assert.rejects(denied)
  await settle(); assert.ok(session.getSnapshot()); session.getSnapshot().answer(false); await denial
  for (const changed of [
    { identityKey: true }, { forSelf: true },
    { protocolID: [2, 'p ecpm apply ' + '02' + 'f'.repeat(64) + ' mental poker deal'] },
    { protocolID: [2, 'p ecpm apply bad mental poker deal'] }
  ]) await assert.rejects(manager.getPublicKey(args('apply', point, changed), 'game.example'))
  await assert.rejects(manager.createSignature({ ...args(), data: [1, 2] }, 'game.example'))
  await assert.rejects(manager.encrypt({ ...args(), plaintext: [1] }, 'game.example'))
  const processor = new WalletWireProcessor(manager)
  const wire = new WalletWireTransceiver(processor)
  assert.equal((await wire.getPublicKey(args('remove', applied.publicKey), 'game.example')).publicKey, point)
  const ordinary = await manager.getPublicKey({ protocolID: [0, 'ordinary public'], keyID: 'one', counterparty: 'self' }, 'game.example')
  assert.equal(ordinary.publicKey, (await originalGetPublicKey({ protocolID: [0, 'ordinary public'], keyID: 'one', counterparty: 'self' })).publicKey)
  const longProtocol = 'mental poker deal'.padEnd(273, 'x')
  const longArgs = args('apply', point, { protocolID: [2, `p ecpm apply ${point} ${longProtocol}`] })
  const longResult = await approved(() => wire.getPublicKey(longArgs, 'game.example'))
  assert.equal((await wire.getPublicKey({ ...longArgs, protocolID: [2, `p ecpm remove ${longResult.publicKey} ${longProtocol}`] }, 'game.example')).publicKey, point)
  const realNow = Date.now
  const afterExpiry = Date.now() + 300_001
  try {
    Date.now = () => afterExpiry
    await assert.rejects(manager.getPublicKey(args('apply', point, { seekPermission: false }), 'game.example'))
  } finally { Date.now = realNow }
  const pending = manager.getPublicKey(args(), 'switch.example')
  const staleRejected = assert.rejects(pending)
  await settle(); const stalePrompt = session.getSnapshot(); assert.ok(stalePrompt)
  session.dispose(); stalePrompt.answer(true); await staleRejected
  await assert.rejects(manager.getPublicKey(args(), 'game.example'), /session changed/)

  // Privileged consent runs before the host's existing password/key policy.
  let keyRequests = 0
  const privileged = new PrivilegedKeyManager(async reason => {
    keyRequests++; assert.equal(reason, 'Shuffle protected deck'); return new PrivateKey(23)
  }, 1)
  const privilegedModule = session.replace({ keyDeriver, privilegedKeyManager: privileged })
  const privilegedManager = new WalletPermissionsManager(underlying, 'wallet.local', { permissionModules: { ecpm: privilegedModule } })
  const privilegedArgs = args('apply', point, { privileged: true, privilegedReason: 'Shuffle protected deck' })
  const privilegedResult = await approved(() => privilegedManager.getPublicKey(privilegedArgs, 'game.example'))
  assert.equal(keyRequests, 1)
  const privilegedScalar = new KeyDeriver(new PrivateKey(23)).derivePrivateKey([2, 'p ecpm mental poker deal'], 'deck mask', 'self')
  assert.equal(privilegedResult.publicKey, PublicKey.fromString(point).mul(privilegedScalar).encode(true, 'hex'))
  assert.notEqual(privilegedResult.publicKey, applied.publicKey)
  await assert.rejects(privilegedManager.getPublicKey({ ...privilegedArgs, privilegedReason: 'Different reason', seekPermission: false }, 'game.example'))
  privileged.destroyKey()
  session.dispose()
  let releaseKey
  const racingModule = session.replace({ keyDeriver, privilegedKeyManager: {
    getPrivilegedKey: () => new Promise(resolve => { releaseKey = resolve })
  } })
  const racing = racingModule.handleRequest({ method: 'getPublicKey', args: privilegedArgs, originator: 'game.example' }, async () => {})
  const racingRejected = assert.rejects(racing, /session changed/)
  await settle(); session.getSnapshot().answer(true); await settle()
  assert.equal(typeof releaseKey, 'function')
  session.dispose(); releaseKey(new PrivateKey(23)); await racingRejected
  const oldBuild = session.dispose()
  session.replace(host)
  assert.throws(() => session.replace(host, oldBuild), /session changed during build/)
  session.dispose()
  unsubscribe()
  const unobserved = session.replace(host)
  await assert.rejects(unobserved.handleRequest({ method: 'getPublicKey', args: args(), originator: 'game.example' }, async () => { throw new Error('fallback') }))
  session.dispose()
  assert.equal(calls, 3)
  console.log('ECPM integration passed: independent scalar oracle, inverse, binary BRC-100, denial, invalid input/methods, ordinary keys, scope isolation, privileged policy, stale sessions and missing UI.')
} finally {
  await unlink(compiled)
}
