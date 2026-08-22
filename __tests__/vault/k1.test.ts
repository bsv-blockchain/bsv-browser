import { P2PKH, PrivateKey, Hash, Transaction, Spend } from '@bsv/sdk'
import {
  K1_LOCK_LEN, K1_UNLOCK_LEN, buildVaultLockingScript,
  encodeVaultInstructions, decodeVaultInstructions, VaultInstructions
} from '../../services/vault/k1'

describe('K1 vault module', () => {
  const priv = PrivateKey.fromRandom()
  const pkh = Hash.hash160(priv.toPublicKey().encode(true) as number[])

  it('builds a 25-byte P2PKH locking script', () => {
    const lock = buildVaultLockingScript({ k1PublicKeyHash: pkh })
    expect(lock.toBinary().length).toBe(K1_LOCK_LEN)
    expect(lock.toHex()).toBe(new P2PKH().lock(pkh).toHex())
  })

  it('a real unlock fits K1_UNLOCK_LEN and verifies under the Spend interpreter', async () => {
    const lock = buildVaultLockingScript({ k1PublicKeyHash: pkh })
    const sourceTx = new Transaction(1, [], [{ lockingScript: lock, satoshis: 1000 }], 0)
    const tx = new Transaction(1, [{
      sourceTransaction: sourceTx, sourceOutputIndex: 0, sequence: 0xffffffff,
      unlockingScriptTemplate: new P2PKH().unlock(priv, 'all', false, 1000, lock)
    }], [{ lockingScript: lock, satoshis: 900 }], 0)
    await tx.sign()
    const unlock = tx.inputs[0].unlockingScript!
    expect(unlock.toBinary().length).toBeLessThanOrEqual(K1_UNLOCK_LEN)
    const spend = new Spend({
      sourceTXID: sourceTx.id('hex'), sourceOutputIndex: 0, sourceSatoshis: 1000,
      lockingScript: lock, transactionVersion: 1, otherInputs: [], inputIndex: 0,
      unlockingScript: unlock, outputs: tx.outputs, inputSequence: 0xffffffff, lockTime: 0
    })
    expect(spend.validate()).toBe(true)
  })

  it('round-trips v3 instructions', () => {
    const i: VaultInstructions = { v: 3, type: 'K1', keyID: 'bip32/7' }
    expect(decodeVaultInstructions(encodeVaultInstructions(i))).toEqual(i)
  })

  it.each([
    undefined, '', 'not json', '{}',
    JSON.stringify({ v: 2, type: 'R1K1', keyID: 'bip32/7', salt: 'aa', r1PublicKey: 'bb', slot: 130 }),
    JSON.stringify({ v: 3, type: 'K1', keyID: 'vault/7' }),
    JSON.stringify({ v: 3, type: 'R1K1', keyID: 'bip32/7' }),
    JSON.stringify({ v: 4, type: 'K1', keyID: 'bip32/7' }),
  ])('fails closed on %s', bad => {
    expect(decodeVaultInstructions(bad as string | undefined)).toBeNull()
  })
})
