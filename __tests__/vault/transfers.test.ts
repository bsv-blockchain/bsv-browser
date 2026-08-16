/**
 * Vault transfers tests.
 *
 * The cryptographic arbiter for the R1-K1 script itself lives in
 * r1k1.test.ts (real Spend-interpreter validation, both branches, high-S
 * acceptance). This file is orchestration: deposit args, output selection,
 * partial re-vault, abort-on-failure, signer release, and double-spend-heal
 * — validated against a fake VaultWallet plus a fake VaultR1Signer that
 * signs for real with a P-256 key (so the R1 template's own commitment
 * check inside the signing loop is exercised, not just mocked away).
 */
import { HD, P2PKH, Transaction, UnlockingScript, Utils } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'
import {
  R1K1_R1_UNLOCK_LEN,
  buildVaultLockingScript,
  decodeVaultInstructions,
  encodeVaultInstructions
} from '@/services/vault/r1k1'

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)
const secureItems: Record<string, string> = {}
jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afudo',
  getItemAsync: jest.fn(async (k: string) => secureItems[k] ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => {
    secureItems[k] = v
  }),
  deleteItemAsync: jest.fn(async (k: string) => {
    delete secureItems[k]
  })
}))

// Mocked lazily (see beforeEach) so the factory itself never touches
// module-scope consts declared later in the file — avoids TDZ issues with
// jest's hoisting of jest.mock() above imports.
jest.mock('@/services/vault/ceremonyHost', () => ({
  requestVaultSigner: jest.fn()
}))

import AsyncStorage from '@react-native-async-storage/async-storage'
import { vaultStore } from '@/services/vault/vaultStore'
import { bip32KeyID, depositPkhFromXpub } from '@/services/vault/vaultDerivation'
import { requestVaultSigner } from '@/services/vault/ceremonyHost'
import {
  VAULT_BASKET,
  VAULT_DEPOSIT_MIN,
  depositToVault,
  withdrawFromVault,
  sweepVaultWithHD,
  getVaultBalance,
  VaultWallet
} from '@/services/vault/transfers'

const ADMIN = 'admin.com'

// One vault enrollment's worth of fixture material, generated once for the
// whole file: a real P-256 keypair for the R1 leg, and a real HD node for
// the K1 leg (so tests exercise the actual template commitment checks
// rather than mocking them away).
const R1_PRIV = p256.utils.randomSecretKey()
const R1_PUBLIC_KEY = Utils.toHex(Array.from(p256.getPublicKey(R1_PRIV, true)))
const VAULT_HD = HD.fromSeed(Array.from(crypto.getRandomValues(new Uint8Array(64))))
const XPUB = VAULT_HD.toPublic().toString()

async function seedMeta(): Promise<void> {
  await vaultStore.setMeta({
    v: 3,
    enrolledAt: 1,
    yubiSerial: 's',
    nickname: 'n',
    slot: 0x82,
    nextKeyIndex: 0,
    xpub: XPUB,
    r1PublicKey: R1_PUBLIC_KEY
  })
}

interface Fixture {
  outpoint: string
  satoshis: number
  customInstructions: string
  src: Transaction
}

/** Seed `n` real R1-K1 vault outputs (fresh salt each) and wire the fake
 * wallet's listOutputs/createAction to serve them, fabricating a signable
 * transaction from whatever inputs/outputs the code under test asks for. */
async function seedVaultOutputs(n: number, sats = 300_000): Promise<Fixture[]> {
  await seedMeta()
  const fx: Fixture[] = []
  for (let index = 0; index < n; index++) {
    const salt = Utils.toHex(Array.from(crypto.getRandomValues(new Uint8Array(32))))
    const k1PublicKeyHash = Utils.toArray(depositPkhFromXpub(XPUB, index), 'hex')
    const lockingScript = await buildVaultLockingScript({ r1PublicKey: R1_PUBLIC_KEY, salt, k1PublicKeyHash })
    const src = new Transaction()
    src.addOutput({ satoshis: sats, lockingScript })
    fx.push({
      outpoint: `${src.id('hex')}.0`,
      satoshis: sats,
      customInstructions: encodeVaultInstructions({
        v: 2,
        type: 'R1K1',
        keyID: bip32KeyID(index),
        salt,
        r1PublicKey: R1_PUBLIC_KEY,
        slot: 0x82
      }),
      src
    })
  }
  // Reserve the indices just used so a re-vault change output (which calls
  // takeNextIndex()) does not collide with a seeded output.
  const meta = await vaultStore.getMeta()
  await vaultStore.setMeta({ ...meta!, nextKeyIndex: n })

  wallet.listOutputs.mockResolvedValue({ outputs: fx.map(({ src: _s, ...o }) => o) })
  wallet.createAction.mockImplementation(async (args: any) => {
    const tx = new Transaction()
    for (const inp of args.inputs) {
      const f = fx.find(x => x.outpoint === inp.outpoint)!
      tx.addInput({
        sourceTransaction: f.src,
        sourceOutputIndex: 0,
        sequence: 0xffffffff,
        unlockingScript: new UnlockingScript([])
      })
    }
    for (const out of args.outputs) {
      tx.addOutput({ satoshis: out.satoshis, lockingScript: new P2PKH().lock(Utils.toArray('11'.repeat(20), 'hex')) })
    }
    return { signableTransaction: { tx: tx.toAtomicBEEF(), reference: 'ref-1' } }
  })
  return fx
}

// ── fake wallet ───────────────────────────────────────────────────────────

let wallet: VaultWallet & {
  createAction: jest.Mock
  signAction: jest.Mock
  listOutputs: jest.Mock
  abortAction: jest.Mock
  listActions: jest.Mock
}

let signerRelease: jest.Mock
let mockSigner: { publicKey: number[]; sign: jest.Mock; release: () => void }

beforeEach(async () => {
  await AsyncStorage.clear()
  for (const k of Object.keys(secureItems)) delete secureItems[k]

  wallet = {
    createAction: jest.fn(async () => ({ txid: 'deadbeef'.repeat(8) })),
    signAction: jest.fn(async () => ({ txid: 'feedface'.repeat(8) })),
    listOutputs: jest.fn(async () => ({ outputs: [] })),
    abortAction: jest.fn(async () => ({})),
    listActions: jest.fn(async () => ({ actions: [] }))
  }

  signerRelease = jest.fn()
  mockSigner = {
    publicKey: Utils.toArray(R1_PUBLIC_KEY, 'hex'),
    sign: jest.fn(async (digest: Uint8Array) => {
      const sig = p256.Signature.fromBytes(p256.sign(digest, R1_PRIV, { prehash: false }))
      return Array.from(sig.toBytes('der'))
    }),
    release: signerRelease
  }
  ;(requestVaultSigner as jest.Mock).mockClear()
  ;(requestVaultSigner as jest.Mock).mockImplementation(async () => mockSigner)
})

// ── deposit ───────────────────────────────────────────────────────────────

describe('depositToVault', () => {
  it('rejects below the 200,000 sat floor', async () => {
    await expect(depositToVault(wallet, ADMIN, VAULT_DEPOSIT_MIN - 1)).rejects.toMatchObject({ code: 'below-dust' })
    expect(wallet.createAction).not.toHaveBeenCalled()
  })

  it('builds an R1-K1 output with complete customInstructions', async () => {
    await seedMeta()
    await depositToVault(wallet, ADMIN, 250_000)

    const [args] = wallet.createAction.mock.calls[0]
    const out = args.outputs[0]

    expect(out.basket).toBe(VAULT_BASKET)
    expect(out.satoshis).toBe(250_000)
    expect(Utils.toArray(out.lockingScript, 'hex').length).toBe(959_632)

    const ci = decodeVaultInstructions(out.customInstructions)!
    expect(ci.v).toBe(2)
    expect(ci.type).toBe('R1K1')
    expect(ci.keyID).toBe('bip32/0')
    expect(ci.slot).toBe(0x82)
    expect(ci.salt).toHaveLength(64)
  })

  it('uses a fresh salt for every deposit', async () => {
    await seedMeta()
    await depositToVault(wallet, ADMIN, 250_000)
    await depositToVault(wallet, ADMIN, 250_000)

    const salts = wallet.createAction.mock.calls.map(
      ([a]: [any]) => decodeVaultInstructions(a.outputs[0].customInstructions)!.salt
    )
    expect(salts[0]).not.toBe(salts[1])
    // One YubiKey key serves the whole vault, so identical salts would give
    // identical commitments and make every output trivially linkable.
    expect(new Set(salts).size).toBe(2)
  })

  it('advances the deposit index on every deposit, never reusing one', async () => {
    await seedMeta()
    await depositToVault(wallet, ADMIN, 250_000)
    await depositToVault(wallet, ADMIN, 250_000)

    const keyIDs = wallet.createAction.mock.calls.map(
      ([a]: [any]) => decodeVaultInstructions(a.outputs[0].customInstructions)!.keyID
    )
    expect(keyIDs).toEqual(['bip32/0', 'bip32/1'])
  })
})

// ── withdraw ──────────────────────────────────────────────────────────────

describe('withdrawFromVault', () => {
  it('never requests entire transactions and passes no inputBEEF', async () => {
    await seedVaultOutputs(2)
    await withdrawFromVault(wallet, ADMIN, 'all', 'Withdraw')

    const [listArgs] = wallet.listOutputs.mock.calls[0]
    expect(listArgs.includeCustomInstructions).toBe(true)
    // ~1.83 MB of extended format per input — never pull the source
    // transactions into memory just to rebuild a script we can derive.
    expect(listArgs.include).toBeUndefined()

    const [caArgs] = wallet.createAction.mock.calls[0]
    expect(caArgs.inputBEEF).toBeUndefined()
    expect(caArgs.options.trustSelf).toBe('known')
  })

  it('spends every vault output with the exact R1 unlocking length', async () => {
    await seedVaultOutputs(3)
    await withdrawFromVault(wallet, ADMIN, 'all', 'Withdraw')

    const [caArgs] = wallet.createAction.mock.calls[0]
    expect(caArgs.inputs).toHaveLength(3)
    for (const i of caArgs.inputs) {
      expect(i.unlockingScriptLength).toBe(R1K1_R1_UNLOCK_LEN)
    }
  })

  it('actually signs every input via the R1 branch (real template validation)', async () => {
    await seedVaultOutputs(2)
    await withdrawFromVault(wallet, ADMIN, 'all', 'Withdraw')

    const [saArgs] = wallet.signAction.mock.calls[0]
    expect(Object.keys(saArgs.spends)).toHaveLength(2)
    for (const spend of Object.values(saArgs.spends) as { unlockingScript: string }[]) {
      expect(Utils.toArray(spend.unlockingScript, 'hex').length).toBe(R1K1_R1_UNLOCK_LEN)
    }
    expect(mockSigner.sign).toHaveBeenCalledTimes(2)
  })

  it('re-vaults the remainder as one output when it clears the floor', async () => {
    await seedVaultOutputs(2, 500_000) // 1,000,000 total
    await withdrawFromVault(wallet, ADMIN, 600_000, 'Withdraw')

    const [caArgs] = wallet.createAction.mock.calls[0]
    expect(caArgs.outputs).toHaveLength(1)
    expect(caArgs.outputs[0].satoshis).toBe(400_000)
    expect(caArgs.outputs[0].basket).toBe(VAULT_BASKET)
  })

  it('folds a sub-floor remainder into the withdrawal', async () => {
    await seedVaultOutputs(1, 250_000)
    await withdrawFromVault(wallet, ADMIN, 100_000, 'Withdraw')

    // 150,000 remainder is below the 200,000 floor — re-vaulting it would
    // create an output not worth moving.
    const [caArgs] = wallet.createAction.mock.calls[0]
    expect(caArgs.outputs).toHaveLength(0)
  })

  it('rejects a withdrawal that exceeds the vault balance', async () => {
    await seedVaultOutputs(1, 250_000)
    await expect(withdrawFromVault(wallet, ADMIN, 300_000, 'Withdraw')).rejects.toMatchObject({
      code: 'amount-exceeds-balance'
    })
  })

  it('releases the signer even when signing throws', async () => {
    await seedVaultOutputs(1)
    wallet.signAction.mockRejectedValueOnce(new Error('boom'))
    await expect(withdrawFromVault(wallet, ADMIN, 'all', 'Withdraw')).rejects.toThrow('boom')

    expect(signerRelease).toHaveBeenCalled()
    expect(wallet.abortAction).toHaveBeenCalled()
  })

  it('releases the signer even when the vault is empty (no ceremony needed to fail)', async () => {
    wallet.listOutputs.mockResolvedValueOnce({ outputs: [] })
    await expect(withdrawFromVault(wallet, ADMIN, 'all', 'Withdraw')).rejects.toMatchObject({ code: 'vault-empty' })
    expect(signerRelease).toHaveBeenCalled()
  })

  it('skips outputs whose customInstructions are not R1-K1 v2', async () => {
    await seedVaultOutputs(1)
    wallet.listOutputs.mockResolvedValueOnce({
      outputs: [
        { outpoint: 'aa.0', satoshis: 250_000, customInstructions: JSON.stringify({ v: 1, keyID: 'bip32/0' }) }
      ]
    })
    await expect(withdrawFromVault(wallet, ADMIN, 'all', 'Withdraw')).rejects.toMatchObject({ code: 'vault-empty' })
  })
})

// ── sweep (K1 recovery, no YubiKey) ────────────────────────────────────────

describe('sweepVaultWithHD', () => {
  it('spends every output via K1, signed locally with the HD node, never re-vaulting', async () => {
    await seedVaultOutputs(2)
    const res = await sweepVaultWithHD(wallet, ADMIN, VAULT_HD, 'Recover vault')
    expect(res?.txid).toBeDefined()

    const [caArgs] = wallet.createAction.mock.calls[0]
    expect(caArgs.outputs).toHaveLength(0) // never re-vaulted — full recovery sweep
    expect(requestVaultSigner).not.toHaveBeenCalled() // no YubiKey involved

    const [saArgs] = wallet.signAction.mock.calls[0]
    expect(Object.keys(saArgs.spends)).toHaveLength(2)
  })

  it('returns null when the vault is already empty', async () => {
    expect(await sweepVaultWithHD(wallet, ADMIN, VAULT_HD, 'Recover vault')).toBeNull()
  })

  it('fails loudly on a legacy non-BIP32 keyID rather than signing with the wrong key', async () => {
    await seedMeta()
    // A real vault output (so the atomic BEEF the fake createAction fabricates
    // has a genuine source transaction to reference), but with a malformed
    // keyID that decodeVaultInstructions still accepts structurally, and
    // indexFromKeyID cannot parse.
    const salt = Utils.toHex(Array.from(crypto.getRandomValues(new Uint8Array(32))))
    const k1PublicKeyHash = Utils.toArray(depositPkhFromXpub(XPUB, 0), 'hex')
    const lockingScript = await buildVaultLockingScript({ r1PublicKey: R1_PUBLIC_KEY, salt, k1PublicKeyHash })
    const src = new Transaction()
    src.addOutput({ satoshis: 300_000, lockingScript })
    const outpoint = `${src.id('hex')}.0`
    const ci = encodeVaultInstructions({
      v: 2,
      type: 'R1K1',
      keyID: 'bip32/not-a-number',
      salt,
      r1PublicKey: R1_PUBLIC_KEY,
      slot: 0x82
    })

    wallet.listOutputs.mockResolvedValueOnce({ outputs: [{ outpoint, satoshis: 300_000, customInstructions: ci }] })
    wallet.createAction.mockImplementationOnce(async (args: any) => {
      const tx = new Transaction()
      for (let i = 0; i < args.inputs.length; i++) {
        tx.addInput({
          sourceTransaction: src,
          sourceOutputIndex: 0,
          sequence: 0xffffffff,
          unlockingScript: new UnlockingScript([])
        })
      }
      return { signableTransaction: { tx: tx.toAtomicBEEF(), reference: 'ref-legacy' } }
    })

    await expect(sweepVaultWithHD(wallet, ADMIN, VAULT_HD, 'Recover vault')).rejects.toMatchObject({
      code: 'bad-derivation-index'
    })
  })
})

// ── balance ─────────────────────────────────────────────────────────────

describe('getVaultBalance', () => {
  it('sums the vault outputs', async () => {
    wallet.listOutputs.mockResolvedValueOnce({
      outputs: [
        { outpoint: 'a.0', satoshis: 3000 },
        { outpoint: 'b.0', satoshis: 4500 }
      ]
    })
    expect(await getVaultBalance(wallet, ADMIN)).toBe(7500)
  })
})

// ── double-spend self-heal (unchanged behaviour, new fixture shape) ───────

describe('withdraw self-heals a double-spend from stuck reservations', () => {
  const reviewError = (competingTxs: string[]) =>
    Object.assign(new Error('Undelayed createAction or signAction results require review.'), {
      code: 5,
      reviewActionResults: [{ txid: '', status: 'doubleSpend', competingTxs }]
    })

  test('aborts exactly the reserving txid (by txid match) then retries createAction', async () => {
    const fx = await seedVaultOutputs(1)
    const RESERVING = 'ab'.repeat(32)
    let createCalls = 0
    const aborted: string[] = []

    wallet.listActions.mockResolvedValue({
      actions: [
        { txid: RESERVING, status: 'nosend', reference: 'ref-reserving' }, // the culprit
        { txid: 'cd'.repeat(32), status: 'nosend', reference: 'ref-other' }, // unrelated txid
        { txid: RESERVING, status: 'completed', reference: 'ref-terminal' } // same txid, terminal
      ]
    })
    wallet.abortAction.mockImplementation(async (args: any) => {
      aborted.push(args.reference)
      return {}
    })
    const realCreateAction = wallet.createAction.getMockImplementation()!
    wallet.createAction.mockImplementation(async (...args: any[]) => {
      if (++createCalls === 1) throw reviewError([RESERVING])
      return realCreateAction(...args)
    })

    const { txid } = await withdrawFromVault(wallet, ADMIN, 'all', 'Withdraw all')
    expect(txid).toBeDefined()
    expect(createCalls).toBe(2) // threw once, retried once
    expect(aborted).toEqual(['ref-reserving']) // only the matching txid + abortable status
    void fx
  })

  test('rethrows the review error when the reserving tx is not abortable/found', async () => {
    await seedVaultOutputs(1)
    const RESERVING = 'ab'.repeat(32)
    wallet.listActions.mockResolvedValue({
      // Same txid exists but only in a terminal state → cannot abort.
      actions: [{ txid: RESERVING, status: 'completed', reference: 'ref-terminal' }]
    })
    wallet.createAction.mockImplementation(async () => {
      throw reviewError([RESERVING])
    })
    await expect(withdrawFromVault(wallet, ADMIN, 'all', 'Withdraw all')).rejects.toMatchObject({ code: 5 })
  })
})
