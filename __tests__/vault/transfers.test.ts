/**
 * Vault transfers tests.
 *
 * The cryptographic arbiter for the K1 script itself lives in k1.test.ts
 * (codec fail-closed behaviour, P2PKH lock shape). This file is
 * orchestration: the tap gate on both directions, deposit args, output
 * selection, partial re-vault, abort-on-failure, key release, and
 * double-spend-heal — validated against a fake VaultWallet plus a real HD
 * node, so the signatures the withdraw path produces are checked against the
 * real script interpreter rather than mocked away.
 */
import { Beef, BigNumber, ECDSA, HD, P2PKH, PrivateKey, PublicKey, Spend, Transaction, UnlockingScript, Utils } from '@bsv/sdk'
import {
  K1_LOCK_LEN,
  K1_UNLOCK_LEN,
  buildVaultLockingScript,
  decodeVaultInstructions,
  encodeVaultInstructions
} from '@/services/vault/k1'

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
  requestVaultKey: jest.fn(),
  noteVaultProgress: jest.fn()
}))

import AsyncStorage from '@react-native-async-storage/async-storage'
import { vaultStore } from '@/services/vault/vaultStore'
import { backupAttestation } from '@/services/vault/backupAttestation'
import { bip32KeyID, depositPubKeyHash } from '@/services/vault/vaultDerivation'
import { requestVaultKey, noteVaultProgress } from '@/services/vault/ceremonyHost'
import type { VaultKeyHandle } from '@/services/vault/ceremony'
import { VaultError } from '@/services/vault/types'
import {
  VAULT_BASKET,
  VAULT_STAGING_BASKET,
  VAULT_DEPOSIT_MIN,
  depositToVault,
  reclaimStagingOutputs,
  withdrawFromVault,
  sweepVaultWithHD,
  getVaultBalance,
  VaultWallet,
  VAULT_MAX_INPUTS,
  VAULT_HARD_MAX_INPUTS
} from '@/services/vault/transfers'

const ADMIN = 'admin.com'
const IDENTITY_KEY = '02' + 'f'.repeat(62)
const REASON = 'Move to vault'

// One vault enrollment's worth of fixture material, generated once for the
// whole file: the real HD node a tap would unwrap, plus a second, unrelated
// node standing in for "wrong YubiKey" / "wrong vault passphrase".
const randomSeed = () => Array.from(crypto.getRandomValues(new Uint8Array(64)))
const VAULT_HD = HD.fromSeed(randomSeed())
const OTHER_HD = HD.fromSeed(randomSeed())

async function seedMeta(): Promise<void> {
  await vaultStore.setMeta({
    v: 4,
    enrolledAt: 1,
    yubiSerial: 's',
    nickname: 'n',
    slot: 0x82,
    nextKeyIndex: 0
  })
}

interface Fixture {
  outpoint: string
  satoshis: number
  customInstructions: string
  lockingScript: ReturnType<typeof buildVaultLockingScript>
  src: Transaction
}

/** A BEEF carrying every fixture's raw source transaction, as listOutputs
 * with `include: 'entire transactions'` returns. It is load-bearing twice
 * over: createAction's signer layer (buildSignableTransaction) resolves each
 * input's sourceTransaction ONLY from this BEEF, and spendVaultOutputs reads
 * each vault output's REAL locking script out of it for the wrong-key check. */
const stitchBeef = (fx: { src: Transaction }[]): number[] => {
  const beef = new Beef()
  for (const { src } of fx) beef.mergeRawTx(src.toBinary())
  return beef.toBinary()
}

/** The signable transaction the fake wallet last fabricated — the object the
 * real interpreter checks each unlocking script against. */
let lastSignable: Transaction | undefined

/** Seed `n` real K1 vault outputs (one BIP32 child each) and wire the fake
 * wallet's listOutputs/createAction to serve them, fabricating a signable
 * transaction from whatever inputs/outputs the code under test asks for. */
async function seedVaultOutputs(n: number, sats = 300_000): Promise<Fixture[]> {
  await seedMeta()
  const fx: Fixture[] = []
  for (let index = 0; index < n; index++) {
    const lockingScript = buildVaultLockingScript({ k1PublicKeyHash: depositPubKeyHash(VAULT_HD, index) })
    const src = new Transaction()
    src.addOutput({ satoshis: sats, lockingScript })
    fx.push({
      outpoint: `${src.id('hex')}.0`,
      satoshis: sats,
      customInstructions: encodeVaultInstructions({ v: 3, type: 'K1', keyID: bip32KeyID(index) }),
      lockingScript,
      src
    })
  }
  // Reserve the indices just used so a re-vault change output (which calls
  // takeNextIndex()) does not collide with a seeded output.
  const meta = await vaultStore.getMeta()
  await vaultStore.setMeta({ ...meta!, nextKeyIndex: n })

  wallet.listOutputs.mockResolvedValue({
    outputs: fx.map(({ src: _s, lockingScript: _l, ...o }) => o),
    BEEF: stitchBeef(fx)
  })
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
    lastSignable = tx
    return { signableTransaction: { tx: tx.toAtomicBEEF(), reference: 'ref-1' } }
  })
  return fx
}

// ── fake wallet ───────────────────────────────────────────────────────────

let wallet: VaultWallet & {
  createAction: jest.Mock
  signAction: jest.Mock
  listOutputs: jest.Mock
  getPublicKey: jest.Mock
  createSignature: jest.Mock
  abortAction: jest.Mock
  listActions: jest.Mock
}

/** Staging outputs the fake wallet "holds" — legacy strands from the retired
 * two-transaction deposit, served to reclaimStagingOutputs' listOutputs call.
 * Nothing mints these any more; reclaim tests seed them directly. */
let fakeStagingUtxos: { outpoint: string; satoshis: number; customInstructions?: string }[]

let keyRelease: jest.Mock
/** The handle the mocked ceremony last vended, so a test can relock it
 * mid-operation the way cancel()/detach/the retention ceiling would. */
let lastHandle: VaultKeyHandle | undefined

/**
 * Arm the mocked ceremony with a given HD node — the successor of the old mock
 * signer.
 *
 * Deliberately reproduces the REAL VaultKeyHandle contract rather than a plain
 * `{hd, release}` object: `hd` is a getter that throws key-removed-mid-op once
 * released, and release() is idempotent (services/vault/ceremony.ts's
 * makeHandle). That getter is the whole point of the spend path taking a thunk
 * — a mock that handed back a raw node would let a "reads hd once up front"
 * regression pass unnoticed.
 */
const armWith = (hd: HD) => {
  ;(requestVaultKey as jest.Mock).mockImplementation(async () => {
    let released = false
    const handle: VaultKeyHandle = {
      get hd(): HD {
        if (released) throw new VaultError('key-removed-mid-op', 'Vault key handle already released')
        return hd
      },
      release: () => {
        if (released) return
        released = true
        keyRelease()
      }
    }
    lastHandle = handle
    return handle
  })
}

beforeEach(async () => {
  await AsyncStorage.clear()
  for (const k of Object.keys(secureItems)) delete secureItems[k]

  lastSignable = undefined
  lastHandle = undefined
  fakeStagingUtxos = []
  wallet = {
    // Default: one call builds, signs and broadcasts — the single-transaction
    // deposit shape (no signableTransaction comes back when the caller
    // supplies no inputs of its own).
    createAction: jest.fn(async () => ({ txid: 'deadbeef'.repeat(8) })),
    signAction: jest.fn(async () => ({ txid: 'feedface'.repeat(8) })),
    listOutputs: jest.fn(async (args: any) =>
      args?.basket === VAULT_STAGING_BASKET ? { outputs: [...fakeStagingUtxos] } : { outputs: [] }
    ),
    // Staging derivation parses this as a curve point, so those calls need a
    // real one (compressed secp256k1 G); identity lookups keep the fixture key.
    getPublicKey: jest.fn(async (args: any) => ({
      publicKey: args?.identityKey
        ? IDENTITY_KEY
        : '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
    })),
    createSignature: jest.fn(async () => ({ signature: new Array(70).fill(1) })),
    abortAction: jest.fn(async () => ({})),
    listActions: jest.fn(async () => ({ actions: [] }))
  }

  // Deposits require a backed-up wallet; the gate itself is covered by its own
  // tests below, so every other deposit test starts from an attested wallet.
  await backupAttestation.set(IDENTITY_KEY, 'phrase')

  keyRelease = jest.fn()
  ;(noteVaultProgress as jest.Mock).mockClear()
  ;(requestVaultKey as jest.Mock).mockClear()
  armWith(VAULT_HD)
})

// ── deposit ───────────────────────────────────────────────────────────────

describe('depositToVault', () => {
  /** The createAction calls that carry the vault output. */
  const vaultCalls = () =>
    wallet.createAction.mock.calls.map(([a]: [any]) => a).filter((a: any) => a.labels?.includes('vault-deposit'))

  it('moves the deposit in ONE ordinary transaction: no inputs of ours, no signAction', async () => {
    await seedMeta()
    const { txid } = await depositToVault(wallet, ADMIN, 250_000, REASON)
    expect(txid).toBe('deadbeef'.repeat(8))

    // Exactly one createAction — the two-transaction staging deposit is gone.
    expect(wallet.createAction).toHaveBeenCalledTimes(1)
    const [args] = wallet.createAction.mock.calls[0]

    // Funding is the toolbox's own coin selection: we supply no inputs, so no
    // signableTransaction step exists and no inputBEEF is needed.
    expect(args.inputs).toBeUndefined()
    expect(args.inputBEEF).toBeUndefined()
    expect(args.outputs).toHaveLength(1)
    expect(args.outputs[0].basket).toBe(VAULT_BASKET)
    expect(args.outputs[0].satoshis).toBe(250_000)
    // The label is load-bearing: the patched toolbox suppresses UTXO-pool
    // growth for 'vault-deposit', keeping the deposit shape minimal.
    expect(args.labels).toEqual(expect.arrayContaining(['vault', 'vault-deposit']))
    expect(args.options).toMatchObject({ randomizeOutputs: false, acceptDelayedBroadcast: false })

    // Nothing to sign on our side: the vault output is an output, not a spend.
    expect(wallet.signAction).not.toHaveBeenCalled()
    expect(wallet.createSignature).not.toHaveBeenCalled()
    // And nothing was staged anywhere.
    expect(wallet.listOutputs).not.toHaveBeenCalled()
  })

  it('taps once and releases the key when the deposit is done', async () => {
    await seedMeta()
    await depositToVault(wallet, ADMIN, 250_000, REASON)

    expect(requestVaultKey).toHaveBeenCalledTimes(1)
    expect(requestVaultKey).toHaveBeenCalledWith(REASON)
    expect(keyRelease).toHaveBeenCalled()
  })

  it('derives nothing without the ceremony — a refused tap costs no index and no money', async () => {
    await seedMeta()
    ;(requestVaultKey as jest.Mock).mockRejectedValueOnce(new VaultError('user-cancelled'))

    await expect(depositToVault(wallet, ADMIN, 250_000, REASON)).rejects.toMatchObject({ code: 'user-cancelled' })
    // takeNextIndex never ran: no vault address exists without an unwrap.
    expect((await vaultStore.getMeta())!.nextKeyIndex).toBe(0)
    // And no money moved: the tap gates the derivation, and the createAction
    // only comes after it.
    expect(wallet.createAction).not.toHaveBeenCalled()
  })

  it('releases the key even when the deposit throws', async () => {
    await seedMeta()
    wallet.createAction.mockRejectedValueOnce(new Error('boom'))
    await expect(depositToVault(wallet, ADMIN, 250_000, REASON)).rejects.toThrow('boom')
    expect(keyRelease).toHaveBeenCalled()
  })

  it('locks the deposit to a child of the tapped key, with v3 customInstructions', async () => {
    await seedMeta()
    await depositToVault(wallet, ADMIN, 250_000, REASON)

    const [args] = vaultCalls()
    const out = args.outputs[0]

    expect(out.basket).toBe(VAULT_BASKET)
    expect(out.satoshis).toBe(250_000)
    // A plain 25-byte P2PKH lock — and specifically the one belonging to
    // child 0 of the node the ceremony handed over, which is the whole point
    // of the tap gate.
    expect(Utils.toArray(out.lockingScript, 'hex').length).toBe(K1_LOCK_LEN)
    expect(out.lockingScript).toBe(
      buildVaultLockingScript({ k1PublicKeyHash: depositPubKeyHash(VAULT_HD, 0) }).toHex()
    )

    const ci = decodeVaultInstructions(out.customInstructions)!
    expect(ci.v).toBe(3)
    expect(ci.type).toBe('K1')
    expect(ci.keyID).toBe('bip32/0')
  })

  it('advances the deposit index on every deposit, never reusing one', async () => {
    await seedMeta()
    await depositToVault(wallet, ADMIN, 250_000, REASON)
    await depositToVault(wallet, ADMIN, 250_000, REASON)

    const keyIDs = vaultCalls().map((a: any) => decodeVaultInstructions(a.outputs[0].customInstructions)!.keyID)
    expect(keyIDs).toEqual(['bip32/0', 'bip32/1'])
  })

  it('refuses to deposit when the wallet has no backup attestation', async () => {
    await seedMeta()
    await backupAttestation.clear(IDENTITY_KEY)

    await expect(depositToVault(wallet, ADMIN, 250_000, REASON)).rejects.toMatchObject({
      code: 'backup-required'
    })
    expect(wallet.createAction).not.toHaveBeenCalled()
  })

  it('checks the backup BEFORE the tap, and before spending the deposit index', async () => {
    // A refused deposit must not burn a deposit index (the index is monotonic
    // and never reused), and must not ask the user to present a key for a
    // transfer that was never going to proceed.
    await seedMeta()
    await backupAttestation.clear(IDENTITY_KEY)

    await expect(depositToVault(wallet, ADMIN, 250_000, REASON)).rejects.toMatchObject({
      code: 'backup-required'
    })
    expect(requestVaultKey).not.toHaveBeenCalled()
    expect((await vaultStore.getMeta())!.nextKeyIndex).toBe(0)
  })

  it('an attestation for a different wallet does not unlock this one', async () => {
    await seedMeta()
    await backupAttestation.clear(IDENTITY_KEY)
    await backupAttestation.set('02' + '9'.repeat(62), 'phrase')

    await expect(depositToVault(wallet, ADMIN, 250_000, REASON)).rejects.toMatchObject({
      code: 'backup-required'
    })
  })

  it('reports preparing then broadcasting so the armed sheet shows activity', async () => {
    // Each note also refreshes the retention window, so a slow createAction
    // cannot have the armed key relocked out from under the deposit.
    await seedMeta()
    await depositToVault(wallet, ADMIN, 250_000, REASON)

    const phases = (noteVaultProgress as jest.Mock).mock.calls.map(([p]) => p.phase)
    expect(phases[0]).toBe('preparing')
    expect(phases).toContain('broadcasting')
  })
})

// ── legacy staging reclaim ────────────────────────────────────────────────

describe('reclaimStagingOutputs', () => {
  it('returns zero and touches nothing when the staging basket is empty', async () => {
    const r = await reclaimStagingOutputs(wallet, ADMIN)
    expect(r).toEqual({ reclaimed: 0, satoshis: 0 })
    expect(wallet.createAction).not.toHaveBeenCalled()
    expect(wallet.signAction).not.toHaveBeenCalled()
    // No ceremony either — staging keys are ordinary wallet keys.
    expect(requestVaultKey).not.toHaveBeenCalled()
  })

  it('runs the storage heal BEFORE listing, so spendable=0 strands become visible', async () => {
    const stranded = {
      outpoint: `${'cd'.repeat(32)}.0`,
      satoshis: 250_017,
      customInstructions: JSON.stringify({ v: 1, type: 'staging', keyID: 'staging cafebabe' })
    }
    // The heal makes the stranded output visible again (spendable=1), which
    // the fake models by inserting it into the listable set.
    const releaseStrandedStaging = jest.fn(async () => {
      fakeStagingUtxos.push(stranded)
      return 1
    })
    const r = await reclaimStagingOutputs(wallet, ADMIN, { releaseStrandedStaging })
    expect(releaseStrandedStaging).toHaveBeenCalledTimes(1)
    expect(releaseStrandedStaging.mock.invocationCallOrder[0]).toBeLessThan(
      wallet.listOutputs.mock.invocationCallOrder[0]
    )
    expect(r.reclaimed).toBe(1)
    expect(r.satoshis).toBe(250_017)
    // Direct-txid branch (no signableTransaction came back): the txid is
    // plumbed through and nothing needed our signature.
    expect(r.txid).toBe('deadbeef'.repeat(8))
    expect(wallet.signAction).not.toHaveBeenCalled()
    const [args] = wallet.createAction.mock.calls[0]
    expect(args.inputs).toHaveLength(1)
    expect(args.inputs[0].outpoint).toBe(stranded.outpoint)
  })

  it('sweeps every decodable staging output regardless of amount, skipping undecodable ones', async () => {
    fakeStagingUtxos.push(
      { outpoint: `${'ab'.repeat(32)}.0`, satoshis: 250_017, customInstructions: JSON.stringify({ v: 1, type: 'staging', keyID: 'staging aaaa' }) },
      { outpoint: `${'cd'.repeat(32)}.1`, satoshis: 99_999, customInstructions: JSON.stringify({ v: 1, type: 'staging', keyID: 'staging bbbb' }) },
      { outpoint: `${'ef'.repeat(32)}.0`, satoshis: 12_345, customInstructions: 'not json at all' }
    )
    const r = await reclaimStagingOutputs(wallet, ADMIN)
    expect(r.reclaimed).toBe(2)
    expect(r.satoshis).toBe(250_017 + 99_999)
    const [args] = wallet.createAction.mock.calls[0]
    expect(args.inputs.map((i: any) => i.outpoint)).toEqual([`${'ab'.repeat(32)}.0`, `${'cd'.repeat(32)}.1`])
    // The reclaim keeps nothing: no outputs of its own, so the whole value
    // (minus fee) returns as toolbox change to the default basket.
    expect(args.outputs).toEqual([])
    // 'vault-deposit' is load-bearing: RELEASE_STRANDED_VAULT_STAGING_SQL's
    // predicate matches it, so a reclaim that itself fails at broadcast is
    // healed by the same release next time.
    expect(args.labels).toEqual(expect.arrayContaining(['vault', 'vault-deposit', 'vault-reclaim']))
  })

  /**
   * The production 2026-08-21 failure, migrated from the retired two-tx
   * deposit: generateChange's UTXO-pool growth added a funding input and
   * change outputs, and a staging signature built with `otherInputs: []`
   * committed to a one-input transaction. Every broadcaster rejected the
   * result with "false stack entry at end of script execution". Each staging
   * unlock must verify against the REAL interpreter for whatever transaction
   * shape the toolbox hands back.
   */
  const realReclaimWallet = (opts: { stagingFirst: boolean; coins?: number }) => {
    const coins = Array.from({ length: opts.coins ?? 1 }, (_, k) => {
      const priv = PrivateKey.fromRandom()
      const sats = 250_017 + k * 12_345
      const lock = new P2PKH().lock(priv.toPublicKey().toAddress())
      const src = new Transaction()
      src.addOutput({ satoshis: sats, lockingScript: lock })
      return {
        priv,
        pub: priv.toPublicKey().toString(),
        sats,
        lock,
        src,
        keyID: `staging c0ffee0${k}`,
        out: {
          outpoint: `${src.id('hex')}.0`,
          satoshis: sats,
          customInstructions: JSON.stringify({ v: 1, type: 'staging', keyID: `staging c0ffee0${k}` })
        }
      }
    })
    const fundPriv = PrivateKey.fromRandom()
    const fundSrc = new Transaction()
    fundSrc.addOutput({ satoshis: 12_730, lockingScript: new P2PKH().lock(fundPriv.toPublicKey().toAddress()) })

    wallet.listOutputs.mockImplementation(async (args: any) =>
      args?.basket === VAULT_STAGING_BASKET
        ? { outputs: coins.map(c => c.out), BEEF: stitchBeef(coins) }
        : { outputs: [] }
    )
    wallet.getPublicKey.mockImplementation(async (args: any) =>
      args?.identityKey
        ? { publicKey: IDENTITY_KEY }
        : { publicKey: coins.find(c => c.keyID === args.keyID)!.pub }
    )
    // Sign the digest for real: the wallet signs hashToDirectlySign raw, and
    // the interpreter's OP_CHECKSIG later re-derives that digest itself.
    wallet.createSignature.mockImplementation(async (args: any) => {
      const c = coins.find(cc => cc.keyID === args.keyID)!
      const sig = ECDSA.sign(new BigNumber(args.hashToDirectlySign), c.priv, true)
      return { signature: sig.toDER() as number[] }
    })

    let signable: Transaction | undefined
    wallet.createAction.mockImplementation(async () => {
      const tx = new Transaction()
      // Non-default sequence and lockTime, deliberately: the preimage must
      // read BOTH from the transaction (transfers.ts formats with
      // input.sequence ?? 0xffffffff and tx.lockTime). A regression that
      // hardcodes the defaults would sign the wrong digest — the exact
      // "false stack entry" production failure class — and all-default
      // fixtures would never catch it.
      const addStaging = () => {
        for (const c of coins) {
          tx.addInput({ sourceTransaction: c.src, sourceOutputIndex: 0, sequence: 0xfffffffe, unlockingScript: new UnlockingScript([]) })
        }
      }
      const addFunding = () =>
        tx.addInput({ sourceTransaction: fundSrc, sourceOutputIndex: 0, sequence: 0xffffffff, unlockingScript: new UnlockingScript([]) })
      if (opts.stagingFirst) {
        addStaging()
        addFunding()
      } else {
        addFunding()
        addStaging()
      }
      // The change outputs the toolbox generates (a reclaim has none of its own).
      tx.addOutput({ satoshis: 5000, lockingScript: new P2PKH().lock(Utils.toArray('22'.repeat(20), 'hex')) })
      tx.addOutput({ satoshis: 7000, lockingScript: new P2PKH().lock(Utils.toArray('33'.repeat(20), 'hex')) })
      tx.lockTime = 700_000
      signable = tx
      return { signableTransaction: { tx: tx.toAtomicBEEF(), reference: 'ref-rec' } }
    })
    return { coins, tx: () => signable! }
  }

  const validateReclaimSpends = (f: ReturnType<typeof realReclaimWallet>) => {
    const [signArgs] = wallet.signAction.mock.calls[0]
    expect(signArgs.reference).toBe('ref-rec')
    // Undelayed, pinned: a reclaim must not report success while its
    // transaction sits in the monitor queue with the broadcast still pending.
    expect(signArgs.options).toMatchObject({ acceptDelayedBroadcast: false })
    const tx = f.tx()
    for (const c of f.coins) {
      const idx = tx.inputs.findIndex(i => i.sourceTransaction?.id('hex') === c.src.id('hex'))
      expect(idx).toBeGreaterThanOrEqual(0)
      expect(signArgs.spends[idx]).toBeDefined()
      const ok = new Spend({
        sourceTXID: c.src.id('hex'),
        sourceOutputIndex: 0,
        sourceSatoshis: c.sats,
        lockingScript: c.lock,
        transactionVersion: tx.version,
        otherInputs: tx.inputs.filter((_, i) => i !== idx),
        inputIndex: idx,
        unlockingScript: UnlockingScript.fromHex(signArgs.spends[idx].unlockingScript),
        outputs: tx.outputs,
        inputSequence: tx.inputs[idx].sequence ?? 0xffffffff,
        lockTime: tx.lockTime
      }).validate()
      expect(ok).toBe(true)
    }
    expect(Object.keys(signArgs.spends)).toHaveLength(f.coins.length)
  }

  it('signs a VALID reclaim when the toolbox adds a funding input and change outputs', async () => {
    const f = realReclaimWallet({ stagingFirst: true })
    const r = await reclaimStagingOutputs(wallet, ADMIN)
    expect(r.txid).toBe('feedface'.repeat(8))
    expect(r.reclaimed).toBe(1)
    validateReclaimSpends(f)
  })

  it('finds each staging input by outpoint even when none of them is input 0', async () => {
    const f = realReclaimWallet({ stagingFirst: false, coins: 2 })
    const r = await reclaimStagingOutputs(wallet, ADMIN)
    expect(r.reclaimed).toBe(2)
    validateReclaimSpends(f)
  })

  it('signs every staging coin with its OWN key, all valid under the real interpreter', async () => {
    const f = realReclaimWallet({ stagingFirst: true, coins: 3 })
    const r = await reclaimStagingOutputs(wallet, ADMIN)
    expect(r.reclaimed).toBe(3)
    expect(r.satoshis).toBe(f.coins.reduce((s, c) => s + c.sats, 0))
    validateReclaimSpends(f)
  })

  it('aborts the reservation when signing fails, so the coins stay reclaimable', async () => {
    realReclaimWallet({ stagingFirst: true })
    wallet.createSignature.mockRejectedValueOnce(new Error('deriver down'))
    await expect(reclaimStagingOutputs(wallet, ADMIN)).rejects.toThrow('deriver down')
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-rec' }, ADMIN)
    expect(wallet.signAction).not.toHaveBeenCalled()
  })

  it('forwards the listed BEEF as inputBEEF — the signer resolves sources only from it', async () => {
    realReclaimWallet({ stagingFirst: true })
    await reclaimStagingOutputs(wallet, ADMIN)
    // The listOutputs args are load-bearing: without includeCustomInstructions
    // every coin decodes as null and the reclaim silently recovers NOTHING;
    // without 'entire transactions' there is no BEEF and the signer throws.
    const [listArgs] = wallet.listOutputs.mock.calls[0]
    expect(listArgs.basket).toBe(VAULT_STAGING_BASKET)
    expect(listArgs.include).toBe('entire transactions')
    expect(listArgs.includeCustomInstructions).toBe(true)
    const [args] = wallet.createAction.mock.calls[0]
    expect(Array.isArray(args.inputBEEF)).toBe(true)
    expect(args.inputBEEF.length).toBeGreaterThan(0)
    expect(args.options).toMatchObject({ acceptDelayedBroadcast: false, trustSelf: 'known' })
  })

  it('heals a stuck reservation (review-actions refusal) by aborting the orphan and retrying once', async () => {
    // A prior crashed reclaim/deposit left the coin's spentBy pointing at an
    // orphaned transaction; createAction refuses with WERR_REVIEW_ACTIONS.
    // The reclaim must free the orphan (same machinery as the withdraw path)
    // and retry once, not surface the refusal to a fire-and-forget caller.
    const f = realReclaimWallet({ stagingFirst: true })
    const orphanTxid = '9a'.repeat(32)
    const reviewErr = Object.assign(new Error('actions require review'), {
      reviewActionResults: [{ competingTxs: [orphanTxid] }]
    })
    const inner = wallet.createAction.getMockImplementation()!
    wallet.createAction.mockImplementationOnce(async () => {
      throw reviewErr
    })
    wallet.createAction.mockImplementation(inner)
    wallet.listActions.mockResolvedValue({
      actions: [{ txid: orphanTxid, status: 'unsigned', reference: 'ref-orphan' }]
    })

    const r = await reclaimStagingOutputs(wallet, ADMIN)
    expect(r.reclaimed).toBe(1)
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-orphan' }, ADMIN)
    expect(wallet.createAction).toHaveBeenCalledTimes(2)
    validateReclaimSpends(f)
  })
})

// ── withdraw ──────────────────────────────────────────────────────────────

describe('withdrawFromVault', () => {
  it('requests entire transactions and forwards the resulting BEEF as inputBEEF', async () => {
    const fx = await seedVaultOutputs(2)
    await withdrawFromVault(wallet, ADMIN, 'all', 'Withdraw')

    const [listArgs] = wallet.listOutputs.mock.calls[0]
    expect(listArgs.includeCustomInstructions).toBe(true)
    // Required, not optional: every vault input carries unlockingScriptLength
    // with no unlockingScript, so @bsv/sdk's createAction treats this as a
    // signable action and resolves each input's sourceTransaction ONLY from
    // inputBEEF (buildSignableTransaction.js) — trustSelf/storage's own
    // known-input shortcut does not substitute for supplying it. Omitting
    // this throws WERR_INTERNAL on the real toolbox before signing starts,
    // which a mocked createAction can't catch — hence asserting on it here.
    expect(listArgs.include).toBe('entire transactions')

    const [caArgs] = wallet.createAction.mock.calls[0]
    expect(caArgs.inputBEEF).toBeDefined()
    expect(caArgs.inputBEEF.length).toBeGreaterThan(0)
    // Sourced from the listOutputs result, not fabricated — and it actually
    // decodes to a BEEF containing every spent output's source transaction.
    const beef = Beef.fromBinary(caArgs.inputBEEF)
    for (const f of fx) expect(beef.findTxid(f.src.id('hex'))).toBeDefined()
    expect(caArgs.options.trustSelf).toBe('known')
  })

  it('spends every vault output, declaring the K1 unlocking length', async () => {
    await seedVaultOutputs(3)
    await withdrawFromVault(wallet, ADMIN, 'all', 'Withdraw')

    const [caArgs] = wallet.createAction.mock.calls[0]
    expect(caArgs.inputs).toHaveLength(3)
    for (const i of caArgs.inputs) {
      expect(i.unlockingScriptLength).toBe(K1_UNLOCK_LEN)
    }
  })

  it('signs every input with the tapped node — validated by the real interpreter', async () => {
    const fx = await seedVaultOutputs(2)
    await withdrawFromVault(wallet, ADMIN, 'all', 'Withdraw')

    const [caArgs] = wallet.createAction.mock.calls[0]
    const [saArgs] = wallet.signAction.mock.calls[0]
    expect(Object.keys(saArgs.spends)).toHaveLength(2)

    const tx = lastSignable!
    caArgs.inputs.forEach((inp: any, i: number) => {
      const f = fx.find(x => x.outpoint === inp.outpoint)!
      const unlockingScript = UnlockingScript.fromHex(saArgs.spends[i].unlockingScript)
      // A real P2PKH unlock: <sig+hashtype> <compressed pubkey>. The DER
      // signature varies 70-72 bytes, so K1_UNLOCK_LEN is the declared
      // ceiling, not the exact size.
      expect(unlockingScript.toBinary().length).toBeLessThanOrEqual(K1_UNLOCK_LEN)
      const ok = new Spend({
        sourceTXID: f.src.id('hex'),
        sourceOutputIndex: 0,
        sourceSatoshis: f.satoshis,
        lockingScript: f.lockingScript,
        transactionVersion: tx.version,
        otherInputs: tx.inputs.filter((_, j) => j !== i),
        inputIndex: i,
        unlockingScript,
        outputs: tx.outputs,
        inputSequence: 0xffffffff,
        lockTime: tx.lockTime
      }).validate()
      expect(ok).toBe(true)
    })
  })

  it('taps once for the whole withdrawal, remainder included', async () => {
    await seedVaultOutputs(2, 500_000)
    await withdrawFromVault(wallet, ADMIN, 600_000, 'Withdraw')

    expect(requestVaultKey).toHaveBeenCalledTimes(1)
    expect(requestVaultKey).toHaveBeenCalledWith('Withdraw')
    expect(keyRelease).toHaveBeenCalledTimes(1)
  })

  it('re-vaults the remainder as one output when it clears the floor', async () => {
    await seedVaultOutputs(2, 500_000) // 1,000,000 total
    await withdrawFromVault(wallet, ADMIN, 600_000, 'Withdraw')

    const [caArgs] = wallet.createAction.mock.calls[0]
    expect(caArgs.outputs).toHaveLength(1)
    expect(caArgs.outputs[0].satoshis).toBe(400_000)
    expect(caArgs.outputs[0].basket).toBe(VAULT_BASKET)
    // Locked to the next index of the SAME node the tap produced — no second
    // ceremony for the change output.
    expect(caArgs.outputs[0].lockingScript).toBe(
      buildVaultLockingScript({ k1PublicKeyHash: depositPubKeyHash(VAULT_HD, 2) }).toHex()
    )
  })

  it('folds a sub-floor remainder into the withdrawal', async () => {
    await seedVaultOutputs(1, 15_000)
    await withdrawFromVault(wallet, ADMIN, 10_000, 'Withdraw')

    // 5,000 remainder is below the 10,000 floor — re-vaulting it would create
    // an output not worth moving.
    const [caArgs] = wallet.createAction.mock.calls[0]
    expect(caArgs.outputs).toHaveLength(0)
  })

  it('rejects a withdrawal that exceeds the vault balance', async () => {
    await seedVaultOutputs(1, 250_000)
    await expect(withdrawFromVault(wallet, ADMIN, 300_000, 'Withdraw')).rejects.toMatchObject({
      code: 'amount-exceeds-balance'
    })
  })

  it('releases the key even when signAction throws', async () => {
    await seedVaultOutputs(1)
    wallet.signAction.mockRejectedValueOnce(new Error('boom'))
    await expect(withdrawFromVault(wallet, ADMIN, 'all', 'Withdraw')).rejects.toThrow('boom')

    expect(keyRelease).toHaveBeenCalled()
    // NOT aborted: by signAction the transaction is already signed, and the
    // network may have it. See "does NOT abort the action when the broadcast
    // itself fails" below — abort now covers only pre-signature failures.
    expect(wallet.abortAction).not.toHaveBeenCalled()
  })

  it('releases the key even when the vault is empty', async () => {
    wallet.listOutputs.mockResolvedValueOnce({ outputs: [] })
    await expect(withdrawFromVault(wallet, ADMIN, 'all', 'Withdraw')).rejects.toMatchObject({ code: 'vault-empty' })
    expect(keyRelease).toHaveBeenCalled()
  })

  it('skips outputs whose customInstructions are not K1 v3', async () => {
    await seedVaultOutputs(1)
    // A v2 R1-K1 row: structurally well-formed, but a different script family
    // this build cannot spend. decodeVaultInstructions fails closed, so it is
    // filtered out rather than fed to a K1 signer.
    wallet.listOutputs.mockResolvedValueOnce({
      outputs: [
        {
          outpoint: `${'aa'.repeat(32)}.0`,
          satoshis: 250_000,
          customInstructions: JSON.stringify({
            v: 2,
            type: 'R1K1',
            keyID: 'bip32/0',
            salt: 'ab'.repeat(32),
            r1PublicKey: '02' + 'cd'.repeat(32),
            slot: 0x82
          })
        }
      ]
    })
    await expect(withdrawFromVault(wallet, ADMIN, 'all', 'Withdraw')).rejects.toMatchObject({ code: 'vault-empty' })
  })

  it('rejects with wrong-key when the tapped key does not open this output', async () => {
    // A different, real HD node standing in for "the wrong physical YubiKey"
    // — e.g. a card re-enrolled against a different seed.
    await seedVaultOutputs(1)
    armWith(OTHER_HD)

    await expect(withdrawFromVault(wallet, ADMIN, 'all', 'Withdraw')).rejects.toMatchObject({ code: 'wrong-key' })
    // Caught before anything is reserved, let alone signed.
    expect(wallet.createAction).not.toHaveBeenCalled()
    expect(wallet.signAction).not.toHaveBeenCalled()
    // Still released, exactly like any other mid-withdrawal failure.
    expect(keyRelease).toHaveBeenCalled()
  })

  it('a partial withdrawal still re-vaults its remainder with no attestation', async () => {
    // Regression guard: nextDepositTarget is the funnel for the re-vaulted
    // remainder as well as for deposits. Gating there would block most
    // WITHDRAWALS — locking users out of their own money is the exact failure
    // this feature exists to prevent.
    await seedVaultOutputs(2, 500_000) // 1,000,000 total
    await backupAttestation.clear(IDENTITY_KEY)

    await withdrawFromVault(wallet, ADMIN, 600_000, 'Withdraw')

    const [caArgs] = wallet.createAction.mock.calls[0]
    expect(caArgs.outputs).toHaveLength(1)
    expect(caArgs.outputs[0].basket).toBe(VAULT_BASKET)
    expect(caArgs.outputs[0].satoshis).toBe(400_000)
  })

  // ── broadcast durability ───────────────────────────────────────────────
  //
  // A slow broadcaster must never cost the user a signed transaction. The
  // signed tx is handed to storage and the monitor's SendWaiting task retries
  // it, rather than being broadcast inline and aborted when the network is
  // slow to answer.
  it('hands the signed transaction to the monitor instead of broadcasting inline', async () => {
    await seedVaultOutputs(1, 250_000)
    await withdrawFromVault(wallet, ADMIN, 'all', 'Withdraw')

    const [saArgs] = wallet.signAction.mock.calls[0]
    expect(saArgs.options.acceptDelayedBroadcast).toBe(true)
  })

  it('does NOT abort the action when the broadcast itself fails', async () => {
    // The transaction is signed by this point. Aborting it would discard a tx
    // the network may already have accepted, so a broadcast-stage failure has
    // to leave the action alone for the monitor to retry.
    await seedVaultOutputs(1, 250_000)
    wallet.signAction.mockRejectedValueOnce(new Error('ETIMEDOUT posting to ARC'))

    await expect(withdrawFromVault(wallet, ADMIN, 'all', 'Withdraw')).rejects.toThrow()
    expect(wallet.abortAction).not.toHaveBeenCalled()
  })

  it('aborts cleanly when the key relocks between createAction and signing', async () => {
    // cancel(), a key detaching, or the retention ceiling can fire at any point
    // in a withdrawal. The spend path reads the node through a thunk for
    // exactly this reason: a relock after the coin is reserved but before the
    // signing loop must REFUSE — not sail on with a node the ceremony has
    // already declared dead — and unwind through the same abort path as any
    // other pre-signature failure.
    await seedVaultOutputs(2, 500_000)
    const realCreateAction = wallet.createAction.getMockImplementation()!
    wallet.createAction.mockImplementation(async (...args: any[]) => {
      const created = await realCreateAction(...args)
      lastHandle!.release() // the relock lands here, mid-withdrawal
      return created
    })

    await expect(withdrawFromVault(wallet, ADMIN, 'all', 'Withdraw')).rejects.toMatchObject({
      code: 'key-removed-mid-op'
    })
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-1' }, ADMIN)
    expect(wallet.signAction).not.toHaveBeenCalled()
  })

  it('still aborts when the failure happens BEFORE the transaction is signed', async () => {
    // The reservation must not be left dangling when nothing was ever signed —
    // that is what wedges the vault UTXO as unspendable. Modelled with a
    // signable transaction whose bytes do not parse, which is exactly the
    // window the abort covers: after createAction reserved the coin, before
    // any unlocking script exists.
    await seedVaultOutputs(1, 250_000)
    wallet.createAction.mockResolvedValueOnce({
      signableTransaction: { tx: [0, 0, 0, 0], reference: 'ref-corrupt' }
    })

    await expect(withdrawFromVault(wallet, ADMIN, 'all', 'Withdraw')).rejects.toThrow()
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-corrupt' }, ADMIN)
    expect(wallet.signAction).not.toHaveBeenCalled()
  })

  // ── progress reporting ─────────────────────────────────────────────────
  //
  // The armed ceremony sheet is on screen for the whole withdrawal, and both
  // ends of it block: assembling the transaction, then the network. Each note
  // also refreshes the retention window, so an operation that outruns it is
  // not relocked mid-flight.
  it('reports preparing → broadcasting as it goes', async () => {
    await seedVaultOutputs(2, 500_000)
    await withdrawFromVault(wallet, ADMIN, 'all', 'Withdraw')

    const phases = (noteVaultProgress as jest.Mock).mock.calls.map(([p]) => p.phase)
    expect(phases.indexOf('preparing')).toBeGreaterThanOrEqual(0)
    expect(phases.indexOf('preparing')).toBeLessThan(phases.indexOf('broadcasting'))
    // No per-signature variant any more: K1 signing is software and fast.
    expect(phases).not.toContain('signing')
  })
})

// ── sweep (K1 recovery, no YubiKey) ────────────────────────────────────────

describe('sweepVaultWithHD', () => {
  // The recovery path has to work when everything except the mnemonic and the
  // vault passphrase is gone. Proven by clearing vaultStore entirely
  // (simulating a device restore with no local vault state at all) AFTER the
  // outputs exist on "chain" and confirming the sweep still succeeds using
  // only the HD node handed in.
  it('sweeps from the HD node alone — survives vaultStore being empty', async () => {
    await seedVaultOutputs(2)
    await vaultStore.clear()
    expect(await vaultStore.getMeta()).toBeNull()

    const res = await sweepVaultWithHD(wallet, ADMIN, VAULT_HD, 'Recover vault')
    expect(res?.txid).toBeDefined()
    const [saArgs] = wallet.signAction.mock.calls[0]
    expect(Object.keys(saArgs.spends)).toHaveLength(2)
  })

  it('spends every output, signed locally with the HD node, never re-vaulting', async () => {
    await seedVaultOutputs(2)
    const res = await sweepVaultWithHD(wallet, ADMIN, VAULT_HD, 'Recover vault')
    expect(res?.txid).toBeDefined()

    const [caArgs] = wallet.createAction.mock.calls[0]
    expect(caArgs.outputs).toHaveLength(0) // never re-vaulted — full recovery sweep
    expect(requestVaultKey).not.toHaveBeenCalled() // no YubiKey involved

    const [saArgs] = wallet.signAction.mock.calls[0]
    expect(Object.keys(saArgs.spends)).toHaveLength(2)
  })

  it('returns null when the vault is already empty', async () => {
    expect(await sweepVaultWithHD(wallet, ADMIN, VAULT_HD, 'Recover vault')).toBeNull()
  })

  it('refuses to sign when the derived child does not match the output script (wrong passphrase)', async () => {
    // The passphrase typo guard. A wrong passphrase yields a different HD
    // node, so EVERY output's pkh mismatches — which must be a loud error,
    // never a silent "your vault is empty" sweep that signs nothing.
    await seedVaultOutputs(2)

    await expect(sweepVaultWithHD(wallet, ADMIN, OTHER_HD, 'Recover vault')).rejects.toMatchObject({
      code: 'wrong-key'
    })
    expect(wallet.createAction).not.toHaveBeenCalled()
    expect(wallet.signAction).not.toHaveBeenCalled()
  })

  it('fails loudly on a legacy non-BIP32 keyID rather than signing with the wrong key', async () => {
    await seedMeta()
    // A real vault output (so the atomic BEEF the fake createAction fabricates
    // has a genuine source transaction to reference), but with a malformed
    // keyID that decodeVaultInstructions still accepts structurally, and
    // indexFromKeyID cannot parse.
    const lockingScript = buildVaultLockingScript({ k1PublicKeyHash: depositPubKeyHash(VAULT_HD, 0) })
    const src = new Transaction()
    src.addOutput({ satoshis: 300_000, lockingScript })
    const outpoint = `${src.id('hex')}.0`
    const ci = encodeVaultInstructions({ v: 3, type: 'K1', keyID: 'bip32/not-a-number' })

    wallet.listOutputs.mockResolvedValueOnce({
      outputs: [{ outpoint, satoshis: 300_000, customInstructions: ci }],
      BEEF: stitchBeef([{ src }])
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

  // The shape a failed withdrawal ACTUALLY leaves behind: the orphan died
  // before signing, so it has no txid for the review path to blame and the
  // toolbox refuses the input with a plain WERR_INVALID_PARAMETER naming the
  // outpoint instead. Before this was healed, the vault stayed wedged until
  // some later attempt happened to produce a review error.
  const unspendableError = (outpoint: string) => {
    const [txid, vout] = outpoint.split('.')
    return Object.assign(
      new Error(
        `The inputs[0] parameter must be spendable output. output ${txid}:${vout} ` +
          'appears to have been spent (spendable=false).'
      ),
      { code: 'WERR_INVALID_PARAMETER' }
    )
  }

  test('aborts the orphan reserving the outpoint (matched on its inputs) then retries', async () => {
    const fx = await seedVaultOutputs(1)
    let createCalls = 0
    const aborted: string[] = []

    wallet.listActions.mockImplementation(async (args: any) => {
      // The heal cannot match on txid here, so it must ask for inputs.
      expect(args.includeInputs).toBe(true)
      // One page, as real paging behaves — an offset past the end is empty.
      if (args.offset > 0) return { actions: [] }
      return {
        actions: [
          // The culprit: no txid at all, reserving our outpoint.
          { status: 'unsigned', reference: 'ref-orphan', inputs: [{ sourceOutpoint: fx[0].outpoint }] },
          // Reserves something else entirely.
          { status: 'unsigned', reference: 'ref-other', inputs: [{ sourceOutpoint: `${'ee'.repeat(32)}.0` }] },
          // Ours, but terminal — not abortable.
          { txid: 'cd'.repeat(32), status: 'completed', reference: 'ref-done', inputs: [{ sourceOutpoint: fx[0].outpoint }] }
        ]
      }
    })
    wallet.abortAction.mockImplementation(async (args: any) => {
      aborted.push(args.reference)
      return {}
    })
    const realCreateAction = wallet.createAction.getMockImplementation()!
    wallet.createAction.mockImplementation(async (...args: any[]) => {
      if (++createCalls === 1) throw unspendableError(fx[0].outpoint)
      return realCreateAction(...args)
    })

    const { txid } = await withdrawFromVault(wallet, ADMIN, 'all', 'Withdraw all')
    expect(txid).toBeDefined()
    expect(createCalls).toBe(2)
    expect(aborted).toEqual(['ref-orphan'])
  })

  test('refuses a deposit while offline, before arming the key', async () => {
    await seedMeta()
    await expect(
      depositToVault(wallet, ADMIN, 300_000, REASON, { isOnline: async () => false })
    ).rejects.toMatchObject({ code: 'requires-online' })
    expect(wallet.createAction).not.toHaveBeenCalled()
    expect(requestVaultKey).not.toHaveBeenCalled()
  })

  test('refuses a withdrawal while offline, before arming the key', async () => {
    await seedVaultOutputs(1)
    await expect(
      withdrawFromVault(wallet, ADMIN, 'all', 'Withdraw all', { isOnline: async () => false })
    ).rejects.toMatchObject({ code: 'requires-online' })
    // No ceremony: an offline user is never asked to present a YubiKey for a
    // transfer that cannot proceed.
    expect(requestVaultKey).not.toHaveBeenCalled()
    expect(wallet.createAction).not.toHaveBeenCalled()
  })

  test('proceeds when the online signal says so', async () => {
    await seedVaultOutputs(1)
    await expect(
      withdrawFromVault(wallet, ADMIN, 'all', 'Withdraw all', { isOnline: async () => true })
    ).resolves.toMatchObject({ txid: expect.any(String) })
  })

  test('spends at most VAULT_MAX_INPUTS and re-vaults the remainder', async () => {
    // 34 outputs of 300,000 in the vault. 'all' means "as much as one
    // transaction can comfortably carry" — see VAULT_MAX_INPUTS — and the
    // untouched outputs stay put for the next pass.
    await seedVaultOutputs(VAULT_MAX_INPUTS + 2)

    const r = await withdrawFromVault(wallet, ADMIN, 'all', 'Withdraw all')
    expect(r.txid).toBeDefined()
    expect(r.remainingInputs).toBe(2)

    const args = wallet.createAction.mock.calls.at(-1)![0] as any
    expect(args.inputs.length).toBe(VAULT_MAX_INPUTS)
    expect(args.inputs.length).toBeLessThanOrEqual(VAULT_HARD_MAX_INPUTS)
  }, 60_000)

  test('reports nothing remaining when the whole vault fits', async () => {
    await seedVaultOutputs(3)
    const r = await withdrawFromVault(wallet, ADMIN, 'all', 'Withdraw all')
    expect(r.remainingInputs).toBe(0)
  })

  test('refuses before signing when the amount cannot be funded within the cap', async () => {
    // 34 x 300,000 is plenty of money, but 32 inputs only reach 9,600,000 — so
    // this is an input-count problem, not an insufficient-funds one, and it must
    // say so rather than blaming the balance.
    await seedVaultOutputs(VAULT_MAX_INPUTS + 2)
    await expect(withdrawFromVault(wallet, ADMIN, 10_000_000, 'Withdraw')).rejects.toMatchObject({
      code: 'too-many-inputs'
    })
    expect(wallet.signAction).not.toHaveBeenCalled()
  }, 60_000)

  test('still reports amount-exceeds-balance when the vault really is too small', async () => {
    await seedVaultOutputs(2)
    await expect(withdrawFromVault(wallet, ADMIN, 5_000_000, 'Withdraw')).rejects.toMatchObject({
      code: 'amount-exceeds-balance'
    })
  })

  test('with a storage lookup, heals from one query and never pages actions', async () => {
    const fx = await seedVaultOutputs(1)
    let createCalls = 0
    const asked: string[][] = []
    const findSpendingReferences = jest.fn(async (outpoints: string[]) => {
      asked.push(outpoints)
      return [
        { reference: 'ref-orphan', status: 'unsigned' },
        // Terminal, so not abortable — the status filter must still apply on
        // this path exactly as it does on the scan.
        { reference: 'ref-done', status: 'completed' }
      ]
    })
    const realCreateAction = wallet.createAction.getMockImplementation()!
    wallet.createAction.mockImplementation(async (...args: any[]) => {
      if (++createCalls === 1) throw unspendableError(fx[0].outpoint)
      return realCreateAction(...args)
    })

    const { txid } = await withdrawFromVault(wallet, ADMIN, 'all', 'Withdraw all', { findSpendingReferences })

    expect(txid).toBeDefined()
    expect(createCalls).toBe(2)
    expect(asked).toEqual([[fx[0].outpoint]])
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-orphan' }, ADMIN)
    expect(wallet.abortAction).not.toHaveBeenCalledWith({ reference: 'ref-done' }, ADMIN)
    // The whole point: no paged scan, so no per-action rawTx load and parse.
    expect(wallet.listActions).not.toHaveBeenCalled()
  })

  test('falls back to the scan when the storage lookup throws', async () => {
    // A storage failure must not cost the retry.
    const fx = await seedVaultOutputs(1)
    let createCalls = 0
    const findSpendingReferences = jest.fn(async () => {
      throw new Error('database is locked')
    })
    wallet.listActions.mockResolvedValue({
      actions: [{ status: 'unsigned', reference: 'ref-orphan', inputs: [{ sourceOutpoint: fx[0].outpoint }] }]
    })
    const realCreateAction = wallet.createAction.getMockImplementation()!
    wallet.createAction.mockImplementation(async (...args: any[]) => {
      if (++createCalls === 1) throw unspendableError(fx[0].outpoint)
      return realCreateAction(...args)
    })

    await expect(
      withdrawFromVault(wallet, ADMIN, 'all', 'Withdraw all', { findSpendingReferences })
    ).resolves.toMatchObject({ txid: expect.any(String) })

    expect(findSpendingReferences).toHaveBeenCalled()
    expect(wallet.listActions).toHaveBeenCalled()
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-orphan' }, ADMIN)
  })

  test('matches the outpoint spelling the toolbox uses in error text (txid:vout)', async () => {
    const fx = await seedVaultOutputs(1)
    const [txid] = fx[0].outpoint.split('.')
    // Assert the fixture really is the dotted spelling, so this test would fail
    // if the two forms ever silently converged.
    expect(fx[0].outpoint).toBe(`${txid}.0`)
    expect(unspendableError(fx[0].outpoint).message).toContain(`${txid}:0`)

    let createCalls = 0
    wallet.listActions.mockResolvedValue({
      actions: [{ status: 'nosend', reference: 'ref-orphan', inputs: [{ sourceOutpoint: fx[0].outpoint }] }]
    })
    const realCreateAction = wallet.createAction.getMockImplementation()!
    wallet.createAction.mockImplementation(async (...args: any[]) => {
      if (++createCalls === 1) throw unspendableError(fx[0].outpoint)
      return realCreateAction(...args)
    })

    await expect(withdrawFromVault(wallet, ADMIN, 'all', 'Withdraw all')).resolves.toMatchObject({
      txid: expect.any(String)
    })
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-orphan' }, ADMIN)
  })

  test('rethrows an unrelated WERR_INVALID_PARAMETER without aborting anything', async () => {
    await seedVaultOutputs(1)
    wallet.createAction.mockImplementation(async () => {
      throw Object.assign(new Error('The outputs[0].satoshis parameter must be a positive integer.'), {
        code: 'WERR_INVALID_PARAMETER'
      })
    })

    await expect(withdrawFromVault(wallet, ADMIN, 'all', 'Withdraw all')).rejects.toMatchObject({
      code: 'WERR_INVALID_PARAMETER'
    })
    expect(wallet.listActions).not.toHaveBeenCalled()
    expect(wallet.abortAction).not.toHaveBeenCalled()
    expect(wallet.createAction).toHaveBeenCalledTimes(1) // no retry
  })

  test('rethrows when the wedged outpoint is not one this withdrawal is spending', async () => {
    await seedVaultOutputs(1)
    const someoneElse = `${'ee'.repeat(32)}.0`
    wallet.createAction.mockImplementation(async () => {
      throw unspendableError(someoneElse)
    })

    await expect(withdrawFromVault(wallet, ADMIN, 'all', 'Withdraw all')).rejects.toMatchObject({
      code: 'WERR_INVALID_PARAMETER'
    })
    expect(wallet.abortAction).not.toHaveBeenCalled()
  })

  test('rethrows when nothing reserving the outpoint can be aborted', async () => {
    const fx = await seedVaultOutputs(1)
    wallet.listActions.mockResolvedValue({
      // Reserves our outpoint but is terminal, so the coin stays stuck.
      actions: [{ txid: 'cd'.repeat(32), status: 'completed', reference: 'ref-done', inputs: [{ sourceOutpoint: fx[0].outpoint }] }]
    })
    wallet.createAction.mockImplementation(async () => {
      throw unspendableError(fx[0].outpoint)
    })

    await expect(withdrawFromVault(wallet, ADMIN, 'all', 'Withdraw all')).rejects.toMatchObject({
      code: 'WERR_INVALID_PARAMETER'
    })
    expect(wallet.abortAction).not.toHaveBeenCalled()
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
