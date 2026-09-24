/* eslint-env node */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const ts = require('typescript')
const root = path.resolve(__dirname, '..')
const adapterFile = path.join(root, 'node_modules/@bsv/expo-wallet-toolbox/core/storage/StorageExpoSQLite.ts')
const tree = ts.createSourceFile(adapterFile, fs.readFileSync(adapterFile, 'utf8'), ts.ScriptTarget.Latest, true)
const adapter = tree.statements.find(node => ts.isClassDeclaration(node) && node.name.text === 'StorageExpoSQLite')
const methods = new Set(['buildWhere', 'sqlFind', 'sqlCount', 'provenTxClauses', 'findProvenTxs', 'countProvenTxs'])
const selected = adapter.members
  .filter(node => methods.has(node.name?.getText(tree)))
  .map(node => node.getText(tree))
  .join('\n')
const helper = { exports: {} }
const compile = source =>
  ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
    .outputText
new Function(
  'exports',
  compile(fs.readFileSync(path.join(root, 'node_modules/@bsv/expo-wallet-toolbox/core/storage/methods/findSql.ts'), 'utf8'))
)(helper.exports)
// Execute the authored adapter methods against SQLite, replacing only the native bridge.
const Fixture = new Function('buildFindSql', compile(`class Fixture { ${selected} };`) + '; return Fixture')(
  helper.exports.buildFindSql
)
const db = new DatabaseSync(':memory:')
db.exec(
  'CREATE TABLE proven_txs (provenTxId INTEGER PRIMARY KEY, txid TEXT UNIQUE, height INTEGER, updated_at TEXT, rawTx BLOB)'
)
const insert = db.prepare('INSERT INTO proven_txs VALUES (?, ?, ?, ?, ?)')
for (let i = 0; i < 2000; i++)
  insert.run(i, String(i).padStart(64, '0'), i % 2, '2026-01-02T00:00:00.000Z', new Uint8Array(1024))
const fixture = new Fixture()
let materialized = 0
let transactionToken
fixture.getDB = trx => {
  transactionToken = trx
  return {
    getAllAsync: async (query, params) => {
      const rows = db.prepare(query).all(...params)
      materialized += rows.length
      return rows
    },
    getFirstAsync: async (query, params) => db.prepare(query).get(...params)
  }
}
fixture.validateDateForWhere = date => date.toISOString()
fixture.validateEntities = rows => rows
;(async () => {
  try {
    const ids = ['0001', '0003'].map(id => id.padStart(64, '0'))
    const trx = { sentinel: true }
    const args = { partial: {}, txids: Object.freeze([ids[0], undefined, ids[1], ids[0]]), trx }
    const rows = await fixture.findProvenTxs(args)
    assert.deepEqual(
      rows.map(row => row.txid),
      ids
    )
    assert.equal(materialized, 2, 'A sync proof lookup must not marshal the entire proof table')
    assert.equal(transactionToken, trx)
    assert.equal(await fixture.countProvenTxs(args), 2)
    assert.deepEqual(
      (await fixture.findProvenTxs({ ...args, partial: { height: 0 } })).map(row => row.txid),
      []
    )
    assert.equal(await fixture.countProvenTxs({ ...args, since: new Date('2026-01-03') }), 0)
    assert.deepEqual(
      (
        await fixture.findProvenTxs({
          ...args,
          since: new Date('2026-01-01'),
          orderDescending: true,
          paged: { limit: 1, offset: 1 }
        })
      ).map(row => row.txid),
      [ids[0]]
    )
    assert.deepEqual(await fixture.findProvenTxs({ partial: {}, txids: ["' OR 1=1 --"] }), [])
    for (const txids of [undefined, [], [undefined]]) {
      assert.equal(await fixture.countProvenTxs({ partial: {}, txids }), 2000)
      assert.equal((await fixture.findProvenTxs({ partial: {}, txids, paged: { limit: 1 } })).length, 1)
    }
    await assert.rejects(fixture.findProvenTxs({ partial: { rawTx: [1] } }), /rawTx/)
    await assert.rejects(fixture.findProvenTxs({ partial: { merklePath: [1] } }), /merklePath/)
    assert.deepEqual(args.txids, [ids[0], undefined, ids[1], ids[0]])
    console.log(
      'PASS: authored native proof find/count methods preserve filters, bounds, transactions and parameterization; only requested rows materialize'
    )
  } finally {
    db.close()
  }
})().catch(error => {
  console.error(error)
  process.exitCode = 1
})
