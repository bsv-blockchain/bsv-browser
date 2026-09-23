/* eslint-env node */
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const ts = require('typescript')
const toolbox = require('@bsv/wallet-toolbox-mobile')
const loaded = new Map()
function load(filename) {
  filename = path.resolve(__dirname, filename)
  if (loaded.has(filename)) return loaded.get(filename).exports
  const module = { exports: {} }
  loaded.set(filename, module)
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  new Function('module', 'exports', 'require', source)(module, module.exports, name => name === '@craftzdog/react-native-buffer' ? { Buffer } : name === '@bsv/expo-wallet-toolbox/core/storage/schema/createTables' ? load('../node_modules/@bsv/expo-wallet-toolbox/core/storage/schema/createTables.ts') : name.startsWith('.') ? load(path.resolve(path.dirname(filename), name + '.ts')) : require(name))
  return module.exports
}
const { copyToNewWalletDocument } = load('../utils/walletPortability/saveDocument.ts')
const { databaseDirectoryUri } = load('../utils/walletPortability/fileUris.ts')
assert.equal(databaseDirectoryUri('/data/user/0/app/files/SQLite'), 'file:///data/user/0/app/files/SQLite')
assert.equal(databaseDirectoryUri('/data/user/0/a #%.app/files'), 'file:///data/user/0/a%20%23%25.app/files')
assert.equal(databaseDirectoryUri('file:///private/a%20b/SQLite'), 'file:///private/a%20b/SQLite')
assert.throws(() => databaseDirectoryUri('relative/SQLite'), /invalid database directory/)
assert.throws(() => databaseDirectoryUri('https://example.test/SQLite'), /invalid database directory/)
const { portabilityFixture } = load('fixtures/wallet-portability.ts')
const { ArchiveStreamParser } = load('../utils/walletPortability/streamParser.ts')
const { canonicalArchiveJson, ARCHIVE_TABLES } = load('../utils/walletPortability/schema.ts')
const { initializeArchiveStage, storeArchiveEvents, validateArchiveStage, canonicalStageBytes } = load('../utils/walletPortability/staging.ts')
const { restoreStageDatabase, captureSqliteArchive, verifyArchiveStorageBinding } = load('../utils/walletPortability/sqliteArchive.ts')
const { WalletDataMonitorFence } = load('../utils/walletPortability/monitorFence.ts')
const { WalletDataStorageManager } = load('../utils/walletPortability/WalletDataStorageManager.ts')
const { encodeArchiveStream, decodeArchiveStream } = load('../utils/walletPortability/streamCrypto.ts')

class Sqlite {
  constructor(filename = ':memory:') { this.db = new DatabaseSync(filename) }
  async execAsync(sql) { this.db.exec(sql) }
  async runAsync(sql, ...params) { return this.db.prepare(sql).run(...params) }
  async getAllAsync(sql, ...params) { return this.db.prepare(sql).all(...params) }
  async getFirstAsync(sql, ...params) { return this.db.prepare(sql).get(...params) ?? null }
  async *getEachAsync(sql, ...params) { yield* this.db.prepare(sql).iterate(...params) }
  close() { this.db.close() }
}
const nativeCrypto = {
  randomBytes: crypto.randomBytes,
  deriveKey: options => new Promise((resolve, reject) => crypto.argon2('argon2id', {
    message: options.password, nonce: options.salt, passes: options.iterations,
    memory: options.memorySize, parallelism: options.parallelism, tagLength: options.hashLength
  }, (error, key) => error ? reject(error) : resolve(key))),
  cipher: (key, nonce, decrypt) => (decrypt ? crypto.createDecipheriv : crypto.createCipheriv)('aes-256-gcm', key, nonce, { authTagLength: 16 })
}
const reader = bytes => ({ size: bytes.length, read: (offset, count) => Uint8Array.from(bytes.subarray(offset, offset + count)) })
async function stage(bytes, password = '') {
  const db = new Sqlite()
  await initializeArchiveStage(db)
  const parser = new ArchiveStreamParser()
  try {
    await decodeArchiveStream(reader(bytes), password, nativeCrypto, async chunk => storeArchiveEvents(db, parser.write(chunk)))
    await storeArchiveEvents(db, parser.end())
    const summary = await validateArchiveStage(db)
    return { db, summary }
  } catch (error) { db.close(); throw error }
}
async function collect(source) { const chunks = []; for await (const chunk of source) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks) }
async function testDocumentSave() {
  const input = crypto.randomBytes(1024 * 1024 + 37)
  const fixture = () => {
    let offset = 0, closed = false, deleted = false, maxRead = 0
    const chunks = []
    const source = { size: input.length, open: () => ({
      readBytes: length => { maxRead = Math.max(maxRead, length); const bytes = Uint8Array.from(input.subarray(offset, offset + length)); offset += bytes.length; return bytes },
      close: () => { closed = true }
    }) }
    const destination = { get size() { return Buffer.concat(chunks).length },
      write: (bytes, { append }) => { if (!append) chunks.length = 0; chunks.push(Buffer.from(bytes)) },
      delete: () => { deleted = true; chunks.length = 0 }
    }
    return { source, destination, bytes: () => Buffer.concat(chunks), state: () => ({ closed, deleted, maxRead }) }
  }
  const full = fixture()
  await copyToNewWalletDocument(full.source, full.destination, () => {})
  assert.deepEqual(full.bytes(), input)
  assert.deepEqual(full.state(), { closed: true, deleted: false, maxRead: 256 * 1024 })
  const interrupted = fixture(), abort = new AbortController()
  await assert.rejects(copyToNewWalletDocument(interrupted.source, interrupted.destination, () => abort.abort(), abort.signal))
  assert.equal(interrupted.state().closed, true)
  assert.equal(interrupted.state().deleted, true)
  const failed = fixture()
  failed.destination.write = () => { throw new Error('provider full') }
  await assert.rejects(copyToNewWalletDocument(failed.source, failed.destination, () => {}), /complete file could not be saved/)
  assert.equal(failed.state().closed, true)
  assert.equal(failed.state().deleted, true)
  const truncated = fixture()
  truncated.destination.write = () => { /* provider silently drops output */ }
  await assert.rejects(copyToNewWalletDocument(truncated.source, truncated.destination, () => {}), /complete file could not be saved/)
  assert.equal(truncated.state().deleted, true)
  const existing = fixture()
  existing.destination.write(new Uint8Array([1, 2]), { append: false })
  await assert.rejects(copyToNewWalletDocument(existing.source, existing.destination, () => {}), /Nothing was overwritten/)
  assert.deepEqual(existing.bytes(), Buffer.from([1, 2]))
  assert.equal(existing.state().deleted, false)
  console.log('PASS: provider save preserves exact bytes with bounded reads, cancellation/failure cleanup, and no overwrite of existing data')
}
async function main() {
  await testDocumentSave()
  const fixture = portabilityFixture()
  fixture.tables.provenTxReqs[0].wasBroadcast = 0
  const json = Buffer.from(canonicalArchiveJson(fixture))
  const { db, summary } = await stage(json)
  assert.equal(summary.totalRecords, 13)
  assert.deepEqual(summary.counts, Object.fromEntries(ARCHIVE_TABLES.map(table => [table, 1])))
  assert.deepEqual(await collect(canonicalStageBytes(db)), json)
  console.log('PASS: all 13 categories survive streamed SQLite staging and canonical export exactly')

  const password = 'synthetic-portability-e\u0301-secret'
  const encryptedChunks = []
  const size = await encodeArchiveStream(canonicalStageBytes(db), password, nativeCrypto, async bytes => encryptedChunks.push(Buffer.from(bytes)))
  const encrypted = Buffer.concat(encryptedChunks)
  assert.equal(size, encrypted.length)
  assert.equal(size, json.length + 113)
  assert.deepEqual(await toolbox.decryptBRC39(encrypted, password.normalize('NFC')), fixture)
  console.log('PASS: published Toolbox independently decrypts native streaming BRC39 with NFC normalization')

  const upstream = Uint8Array.from(await toolbox.encryptBRC39(fixture, password))
  const imported = await stage(upstream, password.normalize('NFC'))
  assert.deepEqual(await collect(canonicalStageBytes(imported.db)), json)
  imported.db.close()
  await assert.rejects(stage(upstream, 'wrong passphrase'), /could not be unlocked/)
  const damaged = Uint8Array.from(upstream); damaged[damaged.length - 1] ^= 1
  await assert.rejects(stage(damaged, password), /could not be unlocked/)
  await assert.rejects(stage(upstream.subarray(0, 90), password))
  const invalidEncryptedDocument = structuredClone(fixture)
  invalidEncryptedDocument.title = 'not a wallet archive'
  const malformedChunks = []
  await encodeArchiveStream((async function* () { yield Buffer.from(JSON.stringify(invalidEncryptedDocument)) })(), password, nativeCrypto, async bytes => malformedChunks.push(Buffer.from(bytes)))
  const authenticatedMalformed = Buffer.concat(malformedChunks)
  await assert.rejects(stage(authenticatedMalformed, password), error => error.code === 'unsupported')
  console.log('PASS: native streaming decrypts Toolbox output; wrong passwords, damaged tags and truncation fail closed')

  const invalid = [
    ['missing category', doc => { delete doc.tables.syncStates }],
    ['non-array category', doc => { doc.tables.outputs = {} }],
    ['duplicate record', doc => { doc.tables.outputs.push(doc.tables.outputs[0]) }],
    ['foreign user', doc => { doc.tables.outputs[0].userId = 2 }],
    ['missing transaction', doc => { doc.tables.transactions = [] }],
    ['missing proof', doc => { doc.tables.provenTxs = [] }],
    ['missing tag', doc => { doc.tables.outputTags = [] }],
    ['missing certificate', doc => { doc.tables.certificates = [] }],
    ['invalid binary', doc => { doc.tables.outputs[0].lockingScript = 'U===' }],
    ['invalid boolean', doc => { doc.tables.outputs[0].spendable = 1 }],
    ['invalid legacy flag', doc => { doc.tables.provenTxReqs[0].wasBroadcast = 2 }],
    ['absent required value', doc => { delete doc.tables.outputs[0].satoshis }],
    ['extra profile key', doc => { doc.privateKey = 'not-a-real-key' }],
    ['null optional field', doc => { doc.tables.outputs[0].spentBy = null }]
  ]
  for (const [label, change] of invalid) {
    const doc = structuredClone(fixture); change(doc)
    await assert.rejects(stage(Buffer.from(JSON.stringify(doc))), undefined, label)
  }
  await assert.rejects(stage(Buffer.from(json.toString().replace('"brc":38', '"brc":38,"brc":38'))))
  await assert.rejects(stage(Buffer.from(json.toString().replace('"brc":38', '"__proto__":{},"brc":38'))))
  console.log('PASS: invalid category, row, identity, references, duplicate keys and unsafe object keys are rejected')

  const controller = new AbortController()
  const written = []
  await assert.rejects(encodeArchiveStream(canonicalStageBytes(db), password, nativeCrypto, async bytes => { written.push(bytes.length); controller.abort() }, controller.signal), /Stopped safely/)
  assert.deepEqual(written, [97])
  assert.deepEqual(await collect(canonicalStageBytes(db)), json)
  const restored = new Sqlite(), recaptured = new Sqlite()
  await restoreStageDatabase(db, restored, '4'.repeat(64), () => {})
  await verifyArchiveStorageBinding(restored, fixture.sourceStorage.chain, '4'.repeat(64), fixture.user.identityKey)
  for (const [chain, key, identity] of [
    ['wrong', '4'.repeat(64), fixture.user.identityKey],
    [fixture.sourceStorage.chain, '5'.repeat(64), fixture.user.identityKey],
    [fixture.sourceStorage.chain, '4'.repeat(64), '02' + '1'.repeat(64)],
  ]) await assert.rejects(verifyArchiveStorageBinding(restored, chain, key, identity), error => error.code === 'identity')
  await restored.execAsync('BEGIN')
  try {
    // Model an externally damaged binding without changing the preserved fixture.
    await restored.execAsync('PRAGMA defer_foreign_keys = ON')
    await restored.execAsync('DELETE FROM users')
    await assert.rejects(verifyArchiveStorageBinding(restored, fixture.sourceStorage.chain, '4'.repeat(64), fixture.user.identityKey), error => error.code === 'identity')
  } finally { await restored.execAsync('ROLLBACK') }
  console.log('PASS: saved bindings reject missing/wrong wallet identities, networks and storage keys before migration')
  await assert.rejects(restoreStageDatabase(db, restored, '5'.repeat(64), () => {}), /not empty/)
  await captureSqliteArchive(restored, recaptured, fixture.user.identityKey, () => {})
  const captured = JSON.parse((await collect(canonicalStageBytes(recaptured))).toString())
  for (const table of ARCHIVE_TABLES) {
    assert.equal(captured.tables[table].length, fixture.tables[table].length)
    for (let index = 0; index < fixture.tables[table].length; index++) {
      const original = fixture.tables[table][index]
      if (table === 'provenTxReqs' && typeof original.wasBroadcast === 'number') {
        assert.equal(captured.tables[table][index].wasBroadcast, Boolean(original.wasBroadcast))
        captured.tables[table][index].wasBroadcast = Number(captured.tables[table][index].wasBroadcast)
      }
      assert.deepEqual(Object.fromEntries(Object.keys(original).map(key => [key, captured.tables[table][index][key]])), original)
    }
  }
  assert.deepEqual(captured.user, fixture.user)
  const digest = async database => crypto.createHash('sha256').update(await collect(canonicalStageBytes(database))).digest('hex')
  const unchanged = new Sqlite()
  await captureSqliteArchive(restored, unchanged, fixture.user.identityKey, () => {}, undefined, captured.exportedAt)
  assert.equal(await digest(unchanged), await digest(recaptured), 'restart verification must reproduce the saved merge digest')
  await restored.runAsync('UPDATE transactions SET description=?', 'changed after reconciliation')
  const changed = new Sqlite()
  await captureSqliteArchive(restored, changed, fixture.user.identityKey, () => {}, undefined, captured.exportedAt)
  assert.notEqual(await digest(changed), await digest(recaptured), 'changed recovery rows must fail resume verification')
  unchanged.close(); changed.close()
  restored.close(); recaptured.close(); db.close()
  console.log('PASS: real SQLite restore/capture preserves every archived value and refuses populated destinations')
  console.log('PASS: cancellation stops publication and leaves the source database unchanged')

  // Feed single bytes to split multibyte UTF-8, escapes, tags and scalar tokens.
  const parser = new ArchiveStreamParser()
  const unicode = structuredClone(fixture); unicode.tables.outputs[0].outputDescription = 'Restored \u{1F99A} e\u0301 \\"'
  const byteDb = new Sqlite(); await initializeArchiveStage(byteDb)
  for (const byte of Buffer.from(canonicalArchiveJson(unicode))) await storeArchiveEvents(byteDb, parser.write(Uint8Array.of(byte)))
  await storeArchiveEvents(byteDb, parser.end()); await validateArchiveStage(byteDb)
  assert.deepEqual(JSON.parse((await collect(canonicalStageBytes(byteDb))).toString()), unicode)
  byteDb.close()
  console.log('PASS: arbitrary chunk boundaries preserve Unicode and JSON values')

  const identityKey = fixture.user.identityKey
  const provider = {
    isStorageProvider: () => false, isAvailable: () => true, setServices: () => {},
    getSettings: () => ({ storageIdentityKey: 'primary', storageName: 'primary' }),
    makeAvailable: async () => provider.getSettings(),
    findOrInsertUser: async () => ({ user: { identityKey, userId: 1, activeStorage: 'primary', created_at: new Date(0), updated_at: new Date(0) }, isNew: false })
  }
  const manager = new WalletDataStorageManager(identityKey)
  manager.setServices({})
  await manager.addWalletStorageProvider(provider)
  provider.processSyncChunk = async () => ({ error: { message: 'rejected page' }, done: true, inserts: 0, updates: 0 })
  await assert.rejects(manager.runAsSync(active => active.processSyncChunk({}, {})), /did not acknowledge/)
  provider.processSyncChunk = async () => ({ done: true, inserts: 1, updates: 0 })
  assert.equal((await manager.runAsSync(active => active.processSyncChunk({}, {}))).inserts, 1)
  console.log('PASS: failed synchronization pages stop merges; acknowledged pages remain usable')
  const sibling = manager.createSession()
  let release, committed = false, lateEntered = false
  const held = manager.runAsSync(async () => new Promise(resolve => { release = resolve }))
  while (!release) await Promise.resolve()
  const closing = manager.closeForRestore(async () => { committed = true })
  const late = sibling.runAsReader(async () => { lateEntered = true })
  const rejection = assert.rejects(late, /Restart the wallet/)
  assert.equal(committed, false)
  release(); await held; await closing; await rejection
  assert.equal(committed, true); assert.equal(lateEntered, false)
  await assert.rejects(manager.runAsWriter(async () => {}), /Restart the wallet/)
  console.log('PASS: real Toolbox access queue drains in-flight work and fences all old sessions before activation')
  console.log('PASS: restart digests are stable and detect changed merge data')
  let finishLoop, destroyed = false, starts = 0, selected
  const running = new Promise(resolve => { finishLoop = resolve })
  const monitor = { _tasksRunningPromise: running, stopTasks() {}, startTasks: async () => { starts++ }, destroy: async () => { destroyed = true } }
  selected = monitor
  const fence = new WalletDataMonitorFence(() => selected, value => { selected = value }, () => true, error => { throw error })
  let drained = false
  const paused = fence.pause().then(resume => { drained = true; return resume })
  await Promise.resolve()
  assert.equal(selected, null); assert.equal(drained, false)
  finishLoop(); const resume = await paused
  resume(); assert.equal(starts, 1); assert.equal(selected, monitor)
  const again = await fence.pause()
  await fence.stop(); again()
  assert.equal(destroyed, true); assert.equal(starts, 1); assert.equal(selected, null)
  console.log('PASS: file operations drain the native host monitor; closed sessions cannot restart it')
}
module.exports = { load, Sqlite, nativeCrypto }
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1 })
