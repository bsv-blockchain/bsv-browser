/**
 * The reorg repair. A token's merkle path is minted at send time; if that block
 * is reorged out the transaction is still real and still has the same txid, but
 * the proof no longer verifies and internalizeAction rejects it as
 * "The tx parameter must be valid AtomicBEEF". Re-fetching by txid gets the
 * current proof for the same transaction.
 */
import { Beef, MerklePath, P2PKH, PrivateKey, Transaction, Utils } from '@bsv/sdk'
import { makeBeefRepair, refetchAtomicBeef, type FetchLike } from '@/utils/pay/beefRepair'
import { wocConfigFor } from '@/utils/pay/rails/address'

const woc = wocConfigFor('main')

/** A payment whose parent carries a proof at `height`. */
function paymentAt(height: number): { txid: string; beefHex: string; parentTxid: string } {
  const key = new PrivateKey(7)
  const addr = key.toPublicKey().toAddress()
  const parent = new Transaction()
  parent.addOutput({ lockingScript: new P2PKH().lock(addr), satoshis: 5000 })
  const parentTxid = parent.id('hex')
  parent.merklePath = new MerklePath(height, [
    [
      { offset: 0, hash: parentTxid, txid: true },
      { offset: 1, duplicate: true }
    ]
  ])
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: parent, sourceOutputIndex: 0, unlockingScript: new P2PKH().lock(addr) })
  tx.addOutput({ lockingScript: new P2PKH().lock(addr), satoshis: 4000 })
  return { txid: tx.id('hex'), beefHex: Utils.toHex(tx.toBEEF()), parentTxid }
}

const responds = (body: string, ok = true, status = 200): FetchLike => async () => ({
  ok,
  status,
  text: async () => body
})

describe('refetchAtomicBeef', () => {
  const { txid, beefHex, parentTxid } = paymentAt(963600)

  it('returns an AtomicBEEF for the requested txid carrying the current proof', async () => {
    const repaired = await refetchAtomicBeef({ woc, txid, fetchImpl: responds(beefHex) })
    expect(repaired).toBeDefined()
    expect(repaired!.slice(0, 4)).toEqual([1, 1, 1, 1])
    const beef = Beef.fromBinary(repaired!)
    expect(beef.atomicTxid).toBe(txid)
    // The whole point: the proof is the one the network holds NOW, not the one
    // the sender minted.
    expect(Object.keys(beef.verifyValid(false).roots)).toEqual(['963600'])
  })

  it('returns a beef that passes the check internalizeAction runs', async () => {
    const repaired = await refetchAtomicBeef({ woc, txid, fetchImpl: responds(beefHex) })
    expect(Beef.fromBinary(repaired!).verifyValid(false).valid).toBe(true)
  })

  // Every one of these must leave the caller's original failure intact rather
  // than throwing something new out of a path the user never asked for.
  it.each([
    ['a non-OK response', responds('Transaction not found', false, 404)],
    ['a prose body', responds('Transaction not found')],
    ['an empty body', responds('')],
    ['odd-length hex', responds('abc')],
    ['a fetch that throws', (async () => {
      throw new Error('ENETDOWN')
    }) as unknown as FetchLike]
  ])('returns undefined for %s', async (_label, fetchImpl) => {
    await expect(refetchAtomicBeef({ woc, txid, fetchImpl })).resolves.toBeUndefined()
  })

  it('refuses a valid beef that is about a different transaction', async () => {
    await expect(
      refetchAtomicBeef({ woc, txid: 'ff'.repeat(32), fetchImpl: responds(beefHex) })
    ).resolves.toBeUndefined()
  })

  it('refuses a beef whose ancestry is incomplete rather than passing it on', async () => {
    const beef = Beef.fromBinary(Utils.toArray(beefHex, 'hex'))
    beef.version = 4022206466 // BEEF V2, the only version that can hold txidOnly
    beef.makeTxidOnly(parentTxid)
    await expect(
      refetchAtomicBeef({ woc, txid, fetchImpl: responds(Utils.toHex(beef.toBinary())) })
    ).resolves.toBeUndefined()
  })
})

describe('makeBeefRepair', () => {
  const { txid, beefHex } = paymentAt(963600)

  it('declines while offline without attempting a fetch', async () => {
    const fetchImpl = jest.fn(responds(beefHex))
    const repair = makeBeefRepair({ woc, online: async () => false, fetchImpl })
    await expect(repair(txid)).resolves.toBeUndefined()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('repairs while online', async () => {
    const repair = makeBeefRepair({ woc, online: async () => true, fetchImpl: responds(beefHex) })
    await expect(repair(txid)).resolves.toBeDefined()
  })
})
