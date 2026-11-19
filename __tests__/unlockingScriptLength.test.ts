/**
 * The wallet must price a page-supplied unlocking script by its bytes.
 *
 * A page that spends a covenant output passes `inputs[].unlockingScript` as a
 * hex string (the BRC-100 shape, no `unlockingScriptLength`). The toolbox's
 * signer strips the script before handing the plan to storage and records its
 * length as `unlockingScriptLength`; storage then funds and prices the input
 * on that number. `@bsv/wallet-toolbox-mobile` 2.14.4 through 2.14.9 keep the
 * HEX string's length (`removeUnlockScripts`: `i.unlockingScript.length`),
 * twice the bytes, so every such spend overpays by the script's size at the
 * fee rate.
 *
 * The case is a real one: a 78,369-byte registration whose input 0 carries a
 * 36,401-byte unlocking script, signed on this app, paid 11,478 sats at
 * 100 sat/kB where its true size prices at 7,837
 * (`2a114fa80fdcd3fc31831f41ef1c3de9528c230160f174282aaf4ea01d5071fd`).
 */
import { KeyDeriver, PrivateKey } from '@bsv/sdk'
import { Wallet } from '@bsv/wallet-toolbox-mobile'

const UNLOCK_BYTES = 36_401
const RATE_SAT_PER_KB = 100

/** The registration's other parts, in bytes, from its serialized form. */
const FUNDING_UNLOCKS = [107, 107]
const OUTPUT_SCRIPTS = [27_395, 25, 14_134, 25]

const varUintSize = (n: number) => (n <= 0xfc ? 1 : n <= 0xffff ? 3 : n <= 0xffffffff ? 5 : 9)

/** The serialized size storage computes from script lengths (toolbox `transactionSize`). */
const transactionSize = (inputs: number[], outputs: number[]) =>
  4 +
  varUintSize(inputs.length) +
  inputs.reduce((a, s) => a + 36 + varUintSize(s) + s + 4, 0) +
  varUintSize(outputs.length) +
  outputs.reduce((a, s) => a + varUintSize(s) + s + 8, 0) +
  4

const feeFor = (bytes: number) => Math.ceil((bytes * RATE_SAT_PER_KB) / 1000)

/** Runs `Wallet.createAction` up to the storage plan and returns the args storage receives. */
async function planStorageArgs(unlockingScript: string) {
  const keyDeriver = new KeyDeriver(PrivateKey.fromRandom())
  const planned = new Error('planned')
  let storageArgs: any
  const storage = {
    _authId: { identityKey: keyDeriver.identityKey },
    setServices: () => {},
    createAction: jest.fn(async (args: unknown) => {
      storageArgs = args
      throw planned
    })
  }
  const wallet = new Wallet({ chain: 'main', keyDeriver, storage: storage as any })
  await expect(
    wallet.createAction({
      description: 'spend a covenant output',
      inputs: [
        {
          outpoint: `${'11'.repeat(32)}.0`,
          inputDescription: 'covenant input',
          unlockingScript
        }
      ],
      outputs: [{ lockingScript: '51', satoshis: 1, outputDescription: 'next state' }]
    })
  ).rejects.toBe(planned)
  return storageArgs
}

describe('a page-supplied unlocking script', () => {
  it('reaches storage with its length in bytes, not hex characters', async () => {
    const hex = '51'.repeat(UNLOCK_BYTES)
    const args = await planStorageArgs(hex)

    expect(args.inputs[0].unlockingScript).toBeUndefined()
    expect(args.inputs[0].unlockingScriptLength).toBe(UNLOCK_BYTES)
  })

  it('prices the registration on its true 78,369 bytes: 7,837 sats, not 11,478', async () => {
    const args = await planStorageArgs('51'.repeat(UNLOCK_BYTES))
    const planned = args.inputs[0].unlockingScriptLength as number

    const trueBytes = transactionSize([UNLOCK_BYTES, ...FUNDING_UNLOCKS], OUTPUT_SCRIPTS)
    expect(trueBytes).toBe(78_369)
    expect(feeFor(trueBytes)).toBe(7_837)

    // The hex length also widens the script's varint from 3 bytes to 5:
    // 78,369 + 36,401 + 2 = 114,772 bytes, 11,478 sats, the fee the phone paid.
    expect(feeFor(transactionSize([2 * UNLOCK_BYTES, ...FUNDING_UNLOCKS], OUTPUT_SCRIPTS))).toBe(11_478)

    expect(feeFor(transactionSize([planned, ...FUNDING_UNLOCKS], OUTPUT_SCRIPTS))).toBe(7_837)
  })
})
