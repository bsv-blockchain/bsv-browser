import { describe, expect, it, jest } from '@jest/globals'
import {
  LockingScript,
  Transaction,
  UnlockingScript,
  WalletInterface,
  WalletWireProcessor,
  WalletWireTransceiver
} from '@bsv/sdk'
import { WalletPermissionsManager } from '@bsv/wallet-toolbox-mobile'

function fixture() {
  const source = new Transaction()
  source.addOutput({ lockingScript: LockingScript.fromHex('51'), satoshis: 2000 })
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: source, sourceOutputIndex: 0, unlockingScript: new UnlockingScript([]) })
  tx.addOutput({ lockingScript: LockingScript.fromHex('51'), satoshis: 1000 })
  tx.addOutput({ lockingScript: LockingScript.fromHex('52'), satoshis: 100 })
  tx.addOutput({ lockingScript: LockingScript.fromHex('53'), satoshis: 800 })
  // Reproduce the older local wallet result seen by upgraded permission managers.
  // All transactions are synthetic; nothing is sent to a wallet or network.
  const created = {
    signableTransaction: { reference: 'd2lyZS1hY3Rpb24=', tx: tx.toAtomicBEEF() },
    [Symbol.for('@bsv/wallet-toolbox/exact-action-spend')]: 1200
  }
  const underlying = {
    createAction: jest.fn(async () => created),
    signAction: jest.fn(async () => ({ txid: tx.id('hex'), tx: tx.toAtomicBEEF() })),
    abortAction: jest.fn(async () => ({ aborted: true }))
  }
  const manager = new WalletPermissionsManager(underlying as unknown as WalletInterface, 'admin.example', {
    encryptWalletMetadata: false
  })
  const authorize = jest.spyOn(manager, 'ensureSpendingAuthorization').mockResolvedValue(true)
  return { tx, underlying, authorize, bridge: new WalletWireTransceiver(new WalletWireProcessor(manager)) }
}

const args = {
  description: 'Create an application task',
  outputs: [{ lockingScript: '51', satoshis: 1000, outputDescription: 'Application output' }]
}

describe('published wallet createAction binary compatibility', () => {
  it.each([false, true])('returns an authorized action with partial=%s', async partial => {
    const { tx, underlying, authorize, bridge } = fixture()
    const result = await bridge.createAction(
      { ...args, options: partial ? { signAndProcess: false } : {} },
      'app.example'
    )
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        satoshis: 1200,
        lineItems: expect.arrayContaining([{ type: 'output', satoshis: 100, description: 'Storage service charge' }])
      })
    )
    expect(underlying.createAction).toHaveBeenCalledTimes(1)
    expect(underlying.signAction).toHaveBeenCalledTimes(partial ? 0 : 1)
    expect(underlying.abortAction).not.toHaveBeenCalled()
    expect(Object.getOwnPropertySymbols(result)).toEqual([])
    if (partial) {
      expect(result.signableTransaction?.reference).toBe('d2lyZS1hY3Rpb24=')
      expect(Array.from(result.signableTransaction!.tx)).toEqual(tx.toAtomicBEEF())
    } else {
      expect(result.txid).toBe(tx.id('hex'))
      expect(Array.from(result.tx!)).toEqual(tx.toAtomicBEEF())
    }
  })

  it('still aborts a denied action before signing', async () => {
    const { underlying, authorize, bridge } = fixture()
    authorize.mockRejectedValue(new Error('Spending denied'))
    await expect(bridge.createAction(args, 'app.example')).rejects.toThrow('Wallet operation failed')
    expect(underlying.signAction).not.toHaveBeenCalled()
    expect(underlying.abortAction).toHaveBeenCalledWith({ reference: 'd2lyZS1hY3Rpb24=' })
  })
})
