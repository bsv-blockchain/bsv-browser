/**
 * The permissions manager must not report a sent transaction as failed.
 *
 * `WalletPermissionsManager.signAction` (bundled in `@bsv/wallet-toolbox-mobile`;
 * this app's `SigningPolicyPermissionsManager` extends it and keeps its
 * `signAction`) lets the wallet sign and BROADCAST, then binds the result to
 * the createAction template. Through 2.14.9 that binding compares every
 * input's sequence with the template's, so a page's BRC-100
 * `spends[vin].sequenceNumber` is refused as a substituted input after the
 * send; its catch then calls `abortAction`, which refuses a sent action, and
 * the page receives the abort's words instead of either error.
 *
 * The case is a real one: `7a9b9ef40af6c307b0c662f526860a5a4f71e6050064726a6bf4ae3654488f55`,
 * input 0 on `fffffffe` set through `spends[0].sequenceNumber`, mined at
 * block 971068 while the page was told "The reference parameter must be an
 * inprocess, outgoing action that has not been signed and shared to the
 * network." Fix: bsv-blockchain/ts-stack (see docs/post-broadcast-check.md).
 */
import { LockingScript, Transaction, UnlockingScript } from '@bsv/sdk'
import { WalletPermissionsManager, sdk } from '@bsv/wallet-toolbox-mobile'

const REFERENCE = 'cmVmZXJlbmNl'
const ORIGINATOR = 'example.com'
const ABORT_WORDS =
  'The reference parameter must be an inprocess, outgoing action that has not been signed and shared to the network.'

function template(): Transaction {
  const source = new Transaction(1, [], [{ satoshis: 2, lockingScript: LockingScript.fromASM('OP_TRUE') }], 0)
  // The createAction draft: the page's input unsigned, its sequence the default.
  return new Transaction(
    1,
    [{ sourceTransaction: source, sourceOutputIndex: 0, sequence: 0xffffffff }],
    [{ satoshis: 1, lockingScript: LockingScript.fromASM('OP_TRUE') }],
    0
  )
}

function managerOver(underlying: object): any {
  return new WalletPermissionsManager(underlying as never, 'admin.example', {
    encryptWalletMetadata: false,
    seekSpendingPermissions: false
  })
}

// Toolbox releases before the binding (2.3.2, for one) pass signAction straight through.
const bundledManagerBinds = managerOver({}).pendingActionTemplates instanceof Map

/** A wallet that does what the toolbox signer does: apply the spends, broadcast, refuse to abort a sent action. */
function standIn(tamper: (tx: Transaction) => void = () => {}) {
  const broadcasts: string[] = []
  const signAction = jest.fn(
    async ({ spends }: { spends: Record<number, { unlockingScript: string; sequenceNumber?: number }> }) => {
      const tx = template()
      for (const [key, spend] of Object.entries(spends ?? {})) {
        const input = tx.inputs[Number(key)]
        if (input == null) continue
        input.unlockingScript = UnlockingScript.fromHex(spend.unlockingScript)
        if (spend.sequenceNumber !== undefined) input.sequence = spend.sequenceNumber
      }
      tamper(tx)
      const txid = tx.id('hex')
      broadcasts.push(txid)
      return { txid, tx: tx.toAtomicBEEF() }
    }
  )
  const abortAction = jest.fn(async () => {
    if (broadcasts.length > 0) {
      throw new sdk.WERR_INVALID_PARAMETER(
        'reference',
        'an inprocess, outgoing action that has not been signed and shared to the network.'
      )
    }
    return { aborted: true }
  })
  const manager = managerOver({ signAction, abortAction })
  manager.pendingActionOriginators.set(REFERENCE, ORIGINATOR)
  manager.pendingActionTemplates.set(REFERENCE, template())
  return { manager, broadcasts, signAction }
}

const describeBinding = bundledManagerBinds ? describe : describe.skip

describeBinding('WalletPermissionsManager.signAction binding (bundled toolbox)', () => {
  test("honours the page's BRC-100 spends[vin].sequenceNumber", async () => {
    const { manager, broadcasts } = standIn()

    const outcome = await manager
      .signAction(
        { reference: REFERENCE, spends: { 0: { unlockingScript: '51', sequenceNumber: 0xfffffffe } } },
        ORIGINATOR
      )
      .catch((e: Error) => e)

    expect(broadcasts).toHaveLength(1)
    expect(outcome).not.toBeInstanceOf(Error)
    expect(outcome.txid).toBe(broadcasts[0])
  })

  test("a refusal after the send reaches the page with its own words, never the abort's", async () => {
    const { manager, broadcasts } = standIn(tx => {
      tx.outputs[0].satoshis = 2
    })

    const error = await manager
      .signAction({ reference: REFERENCE, spends: { 0: { unlockingScript: '51' } } }, ORIGINATOR)
      .catch((e: Error) => e)

    expect(broadcasts).toHaveLength(1)
    expect(error.message).not.toBe(ABORT_WORDS)
    expect(error.message).toBe('Wallet finalization substituted an authorized transaction output.')
  })

  test('a spend the binding refuses is refused before the wallet signs or sends', async () => {
    const { manager, broadcasts, signAction } = standIn()

    const error = await manager
      .signAction({ reference: REFERENCE, spends: { 1: { unlockingScript: '51' } } }, ORIGINATOR)
      .catch((e: Error) => e)

    expect(signAction).not.toHaveBeenCalled()
    expect(broadcasts).toHaveLength(0)
    expect(error.message).toBe('Signed input index is invalid.')
  })
})
