/**
 * The stranded-staging release, against the exact shape production left behind
 * on 2026-08-21: deposit tx2 rejected by every broadcaster ("false stack entry
 * at end of script execution"), transactions.status = 'failed',
 * proven_tx_reqs.status = 'invalid', and the tx2 inputs — the staging coin AND
 * the change output the toolbox pulled in as extra funding — re-stranded at
 * spendable = 0 by markStaleInputsAsSpent (indexer lag said tx1's outputs were
 * not UTXOs seconds after tx1 broadcast).
 *
 * Every negative case here is a clause of the predicate: the release must not
 * touch a failed tx whose req is not definitively invalid, must not touch
 * non-vault transactions, and must not touch coins held by live reservations.
 */
import { DatabaseSync } from 'node:sqlite'
import { RELEASE_STRANDED_VAULT_STAGING_SQL } from '@/storage/methods/findSql'

const TX1 = 'e1'.repeat(32)
const TX2 = '27'.repeat(32)

function seeded(): DatabaseSync {
  const d = new DatabaseSync(':memory:')
  d.exec(`
    CREATE TABLE transactions (transactionId INTEGER PRIMARY KEY, txid TEXT, status TEXT);
    CREATE TABLE proven_tx_reqs (provenTxReqId INTEGER PRIMARY KEY, txid TEXT, status TEXT);
    CREATE TABLE tx_labels (txLabelId INTEGER PRIMARY KEY, label TEXT, isDeleted INTEGER DEFAULT 0);
    CREATE TABLE tx_labels_map (txLabelId INTEGER, transactionId INTEGER, isDeleted INTEGER DEFAULT 0);
    CREATE TABLE outputs (outputId INTEGER PRIMARY KEY, spendable INTEGER, spentBy INTEGER, satoshis INTEGER);
  `)
  return d
}

/** One failed spender + the outputs it holds, in the production arrangement. */
function seedFailedDeposit(
  d: DatabaseSync,
  opts: { reqStatus?: string; label?: string; txStatus?: string } = {}
): void {
  const { reqStatus = 'invalid', label = 'vault-deposit', txStatus = 'failed' } = opts
  d.prepare('INSERT INTO transactions VALUES (2, ?, ?)').run(TX1, 'unproven')
  d.prepare('INSERT INTO transactions VALUES (3, ?, ?)').run(TX2, txStatus)
  d.prepare('INSERT INTO proven_tx_reqs VALUES (1, ?, ?)').run(TX1, 'unmined')
  d.prepare('INSERT INTO proven_tx_reqs VALUES (2, ?, ?)').run(TX2, reqStatus)
  d.prepare('INSERT INTO tx_labels VALUES (1, ?, 0)').run(label)
  d.exec('INSERT INTO tx_labels_map VALUES (1, 3, 0)')
  // outputId 1: the staging coin; outputId 2: the pulled-in change funding.
  d.exec('INSERT INTO outputs VALUES (1, 0, 3, 1095981)')
  d.exec('INSERT INTO outputs VALUES (2, 0, 3, 12730)')
}

const spendables = (d: DatabaseSync) =>
  d.prepare('SELECT outputId, spendable, spentBy FROM outputs ORDER BY outputId').all() as {
    outputId: number
    spendable: number
    spentBy: number | null
  }[]

describe('RELEASE_STRANDED_VAULT_STAGING_SQL', () => {
  it('releases every input held by a failed vault-deposit whose req is invalid', () => {
    const d = seeded()
    seedFailedDeposit(d)
    const r = d.prepare(RELEASE_STRANDED_VAULT_STAGING_SQL).run()
    expect(Number(r.changes)).toBe(2)
    expect(spendables(d)).toEqual([
      { outputId: 1, spendable: 1, spentBy: null },
      { outputId: 2, spendable: 1, spentBy: null }
    ])
  })

  it('does NOT release when the req is not invalid (broadcast may have propagated)', () => {
    const d = seeded()
    seedFailedDeposit(d, { reqStatus: 'unsent' })
    const r = d.prepare(RELEASE_STRANDED_VAULT_STAGING_SQL).run()
    expect(Number(r.changes)).toBe(0)
    expect(spendables(d).every(o => o.spendable === 0)).toBe(true)
  })

  it('does NOT release inputs of failed transactions without the vault-deposit label', () => {
    const d = seeded()
    seedFailedDeposit(d, { label: 'some-other-flow' })
    const r = d.prepare(RELEASE_STRANDED_VAULT_STAGING_SQL).run()
    expect(Number(r.changes)).toBe(0)
  })

  it('does NOT release inputs of a vault-deposit that is not failed', () => {
    const d = seeded()
    seedFailedDeposit(d, { txStatus: 'unproven', reqStatus: 'unmined' })
    const r = d.prepare(RELEASE_STRANDED_VAULT_STAGING_SQL).run()
    expect(Number(r.changes)).toBe(0)
  })

  it('ignores a deleted label mapping', () => {
    const d = seeded()
    seedFailedDeposit(d)
    d.exec('UPDATE tx_labels_map SET isDeleted = 1')
    const r = d.prepare(RELEASE_STRANDED_VAULT_STAGING_SQL).run()
    expect(Number(r.changes)).toBe(0)
  })

  it('leaves outputs held by OTHER transactions untouched while releasing the stranded ones', () => {
    const d = seeded()
    seedFailedDeposit(d)
    d.prepare('INSERT INTO transactions VALUES (4, ?, ?)').run('aa'.repeat(32), 'unsigned')
    d.exec('INSERT INTO outputs VALUES (3, 0, 4, 500000)')
    const r = d.prepare(RELEASE_STRANDED_VAULT_STAGING_SQL).run()
    expect(Number(r.changes)).toBe(2)
    expect(spendables(d)[2]).toEqual({ outputId: 3, spendable: 0, spentBy: 4 })
  })
})
