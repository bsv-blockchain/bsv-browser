/**
 * Vault transfers tests.
 *
 * The signing path is validated cryptographically: buildVaultUnlockingScript
 * must produce a script that the real Spend interpreter accepts. Orchestration
 * (deposit args, selection, partial re-vault, abort, replenish) is validated
 * against a fake VaultWallet.
 */
import {
  P2PKH,
  PrivateKey,
  PublicKey,
  KeyDeriver,
  Transaction,
  Spend,
  ECDSA,
  BigNumber,
  UnlockingScript,
  Beef,
  Utils
} from '@bsv/sdk'

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

import AsyncStorage from '@react-native-async-storage/async-storage'
import { vaultStore, type VaultMetaV1 } from '../../services/vault/vaultStore'
import { backupAttestation } from '../../services/vault/backupAttestation'
import {
  buildVaultUnlockingScript,
  depositToVault,
  withdrawFromVault,
  sweepVaultWithKey,
  replenishDepositKeys,
  getVaultBalance,
  VAULT_BASKET,
  VAULT_PROTOCOL,
  VaultWallet
} from '../../services/vault/transfers'

const ADMIN = 'admin.com'
const IDENTITY_KEY = '02' + 'f'.repeat(62)
const V = Array.from(new PrivateKey(123456789).toArray())
const kd = new KeyDeriver(new PrivateKey(V))

const derivedPriv = (keyID: string): PrivateKey => kd.derivePrivateKey(VAULT_PROTOCOL, keyID, 'self')
const derivedPubHex = (keyID: string): string =>
  kd.derivePublicKey(VAULT_PROTOCOL, keyID, 'self', true).toString()
const derivedPkh = (keyID: string): string => PublicKey.fromString(derivedPubHex(keyID)).toHash('hex') as string

// A BEEF carrying a fixture's raw source txs, as listOutputs('entire
// transactions') would return — so spendVaultOutputs' buildVaultInputBeef runs
// against realistic data instead of being skipped.
const stitchBeef = (fx: { src: Transaction }[]): number[] => {
  const beef = new Beef()
  for (const { src } of fx) beef.mergeRawTx(src.toBinary())
  return beef.toBinary()
}

beforeEach(async () => {
  await AsyncStorage.clear()
  for (const k of Object.keys(secureItems)) delete secureItems[k]
})

describe('buildVaultUnlockingScript (cryptographic arbiter)', () => {
  test('produces a script the Spend interpreter accepts', async () => {
    const keyID = 'vault/0'
    const priv = derivedPriv(keyID)
    const pkh = derivedPkh(keyID)
    const lock = new P2PKH().lock(Utils.toArray(pkh, 'hex'))

    // A source tx whose output 0 is our vault UTXO.
    const source = new Transaction()
    source.addOutput({ satoshis: 10_000, lockingScript: lock })

    // The spending tx: one input (the vault UTXO), one change output.
    const spend = new Transaction()
    spend.addInput({ sourceTransaction: source, sourceOutputIndex: 0, sequence: 0xffffffff })
    spend.addOutput({ satoshis: 9_800, lockingScript: new P2PKH().lock(Utils.toArray(derivedPkh('vault/1'), 'hex')) })

    const unlock = await buildVaultUnlockingScript({
      tx: spend,
      inputIndex: 0,
      sourceTXID: source.id('hex'),
      sourceOutputIndex: 0,
      sourceSatoshis: 10_000,
      sourceLockingScript: lock,
      publicKeyHex: derivedPubHex(keyID),
      // emulate the wallet's privileged createSignature: ECDSA over the digest
      sign: async digest => ECDSA.sign(new BigNumber(digest), priv, true).toDER() as number[]
    })
    spend.inputs[0].unlockingScript = unlock

    const valid = new Spend({
      sourceTXID: source.id('hex'),
      sourceOutputIndex: 0,
      sourceSatoshis: 10_000,
      lockingScript: lock,
      transactionVersion: spend.version,
      otherInputs: [],
      outputs: spend.outputs,
      inputIndex: 0,
      unlockingScript: unlock,
      inputSequence: 0xffffffff,
      lockTime: spend.lockTime
    }).validate()
    expect(valid).toBe(true)
  })

  test('validates BOTH inputs of a two-input withdrawal (multi-input BIP143)', async () => {
    // Two vault UTXOs from different keys spent into one change output — the
    // real common case. Each input must produce a Spend-valid unlocking script.
    const srcs = ['vault/0', 'vault/1'].map(keyID => {
      const lock = new P2PKH().lock(Utils.toArray(derivedPkh(keyID), 'hex'))
      const src = new Transaction()
      src.addOutput({ satoshis: 6000, lockingScript: lock })
      return { keyID, lock, src }
    })

    const spend = new Transaction()
    srcs.forEach(s => spend.addInput({ sourceTransaction: s.src, sourceOutputIndex: 0, sequence: 0xffffffff }))
    spend.addOutput({ satoshis: 11_800, lockingScript: new P2PKH().lock(Utils.toArray(derivedPkh('vault/9'), 'hex')) })

    for (let i = 0; i < srcs.length; i++) {
      const s = srcs[i]
      const priv = derivedPriv(s.keyID)
      const unlock = await buildVaultUnlockingScript({
        tx: spend,
        inputIndex: i,
        sourceTXID: s.src.id('hex'),
        sourceOutputIndex: 0,
        sourceSatoshis: 6000,
        sourceLockingScript: s.lock,
        publicKeyHex: derivedPubHex(s.keyID),
        sign: async digest => ECDSA.sign(new BigNumber(digest), priv, true).toDER() as number[]
      })
      spend.inputs[i].unlockingScript = unlock
    }

    for (let i = 0; i < srcs.length; i++) {
      const valid = new Spend({
        sourceTXID: srcs[i].src.id('hex'),
        sourceOutputIndex: 0,
        sourceSatoshis: 6000,
        lockingScript: srcs[i].lock,
        transactionVersion: spend.version,
        otherInputs: spend.inputs.filter((_, j) => j !== i),
        outputs: spend.outputs,
        inputIndex: i,
        unlockingScript: spend.inputs[i].unlockingScript!,
        inputSequence: 0xffffffff,
        lockTime: spend.lockTime
      }).validate()
      expect(valid).toBe(true)
    }
  })
})

// ── fake wallet ───────────────────────────────────────────────────────────

function makeFakeWallet(overrides: Partial<VaultWallet> = {}): VaultWallet & { calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = {}
  const base: VaultWallet = {
    async createAction() {
      return { txid: 'deadbeef'.repeat(8) }
    },
    async signAction() {
      return { txid: 'feedface'.repeat(8) }
    },
    async listOutputs() {
      return { outputs: [] }
    },
    async getPublicKey(args: any) {
      if (args.identityKey) return { publicKey: IDENTITY_KEY }
      return { publicKey: derivedPubHex(args.keyID) }
    },
    async createSignature(args: any) {
      const priv = derivedPriv(args.keyID)
      return { signature: ECDSA.sign(new BigNumber(args.hashToDirectlySign), priv, true).toDER() as number[] }
    },
    async abortAction() {
      return {}
    }
  }
  const merged = { ...base, ...overrides } as VaultWallet
  // Wrap every method so calls are recorded regardless of overrides.
  const wrapped = {} as VaultWallet
  for (const name of Object.keys(merged) as (keyof VaultWallet)[]) {
    const fn = merged[name] as (...a: unknown[]) => unknown
    wrapped[name] = (async (...a: unknown[]) => {
      ;(calls[name as string] ??= []).push(a[0])
      return fn(...a)
    }) as never
  }
  return Object.assign(wrapped, { calls })
}

async function enrollFakeMeta(keys = 64) {
  await vaultStore.setSeal({
    v: 1,
    slot: 0x82,
    ePub: 'aa'.repeat(65),
    salt: 'bb'.repeat(32),
    c: 'cc'.repeat(64),
    yubiSerial: 's',
    yubiPubSha256: 'dd'.repeat(32)
  })
  await vaultStore.setMeta({
    v: 1,
    enrolledAt: 1,
    yubiSerial: 's',
    nickname: 'n',
    slot: 0x82,
    nextKeyIndex: keys,
    depositKeys: Array.from({ length: keys }, (_, i) => ({ keyID: `vault/${i}`, pkh: derivedPkh(`vault/${i}`) }))
  })
}

describe('depositToVault', () => {
  test('builds a P2PKH output in the admin vault basket and drains the queue', async () => {
    await enrollFakeMeta()
    await backupAttestation.set(IDENTITY_KEY, 'phrase')
    const w = makeFakeWallet()
    const { txid } = await depositToVault(w, ADMIN, 5000)
    expect(txid).toBeDefined()
    const args = w.calls.createAction[0] as any
    expect(args.outputs[0].basket).toBe(VAULT_BASKET)
    expect(args.outputs[0].satoshis).toBe(5000)
    expect(JSON.parse(args.outputs[0].customInstructions).keyID).toBe('vault/0')
    expect(args.labels).toEqual(['vault', 'vault-deposit'])
    // queue drained by one
    expect(((await vaultStore.getMeta()) as VaultMetaV1).depositKeys[0].keyID).toBe('vault/1')
  })

  test('rejects a below-dust deposit', async () => {
    await enrollFakeMeta()
    await backupAttestation.set(IDENTITY_KEY, 'phrase')
    await expect(depositToVault(makeFakeWallet(), ADMIN, 100)).rejects.toMatchObject({
      code: 'below-dust'
    })
  })

  test('refuses to deposit when the wallet has no backup attestation', async () => {
    await enrollFakeMeta()
    const w = makeFakeWallet()

    await expect(depositToVault(w, ADMIN, 5000)).rejects.toMatchObject({
      code: 'backup-required'
    })
    expect(w.calls.createAction).toBeUndefined()
  })

  test('checks the backup before spending the deposit index', async () => {
    // A refused deposit must not burn a deposit key: the index is monotonic and
    // never reused, so a gate that ran late would leak addresses on every
    // blocked attempt.
    await enrollFakeMeta()
    await expect(depositToVault(makeFakeWallet(), ADMIN, 5000)).rejects.toMatchObject({
      code: 'backup-required'
    })
    expect(((await vaultStore.getMeta()) as VaultMetaV1).depositKeys[0].keyID).toBe('vault/0')
  })

  test('an attestation for a different wallet does not unlock this one', async () => {
    await enrollFakeMeta()
    await backupAttestation.set('02' + '9'.repeat(62), 'phrase')
    await expect(depositToVault(makeFakeWallet(), ADMIN, 5000)).rejects.toMatchObject({
      code: 'backup-required'
    })
  })
})

describe('withdrawFromVault', () => {
  // Build a real vault UTXO set with recoverable BEEF via source transactions.
  function vaultOutputsFixture() {
    const mk = (keyID: string, sats: number, tag: string) => {
      const src = new Transaction()
      src.addOutput({ satoshis: sats, lockingScript: new P2PKH().lock(Utils.toArray(derivedPkh(keyID), 'hex')) })
      return {
        outpoint: `${src.id('hex')}.0`,
        satoshis: sats,
        customInstructions: JSON.stringify({ v: 1, keyID }),
        src
      }
    }
    return [mk('vault/0', 6000, 'a'), mk('vault/1', 6000, 'b')]
  }

  test("'all' spends every output, no re-vault output, signs each input", async () => {
    await enrollFakeMeta()
    const fx = vaultOutputsFixture()
    const w = makeFakeWallet({
      async listOutputs() {
        return { outputs: fx.map(({ src: _s, ...o }) => o), BEEF: stitchBeef(fx) }
      },
      async createAction(args: any) {
        // fabricate a signable spending tx from the declared inputs/outputs
        const tx = new Transaction()
        for (const inp of args.inputs) {
          const f = fx.find(x => x.outpoint === inp.outpoint)!
          tx.addInput({ sourceTransaction: f.src, sourceOutputIndex: 0, sequence: 0xffffffff, unlockingScript: new UnlockingScript([]) })
        }
        tx.addOutput({ satoshis: 11_800, lockingScript: new P2PKH().lock(Utils.toArray(derivedPkh('vault/9'), 'hex')) })
        return { signableTransaction: { tx: tx.toAtomicBEEF(), reference: 'ref-1' } }
      }
    })
    const { txid } = await withdrawFromVault(w, ADMIN, 'all', 'Withdraw all')
    expect(txid).toBeDefined()
    const ca = w.calls.createAction[0] as any
    expect(ca.inputs).toHaveLength(2)
    expect(ca.outputs).toHaveLength(0) // 'all' → no re-vault output
    const sa = w.calls.signAction[0] as any
    expect(Object.keys(sa.spends)).toHaveLength(2)
    expect(w.calls.createSignature).toHaveLength(2)
  })

  test('partial withdrawal re-vaults the remainder to a fresh key', async () => {
    await enrollFakeMeta()
    const fx = vaultOutputsFixture() // two 6000-sat outputs = 12000
    const w = makeFakeWallet({
      async listOutputs() {
        return { outputs: fx.map(({ src: _s, ...o }) => o), BEEF: stitchBeef(fx) }
      },
      async createAction(args: any) {
        const tx = new Transaction()
        for (const inp of args.inputs) {
          const f = fx.find(x => x.outpoint === inp.outpoint)!
          tx.addInput({ sourceTransaction: f.src, sourceOutputIndex: 0, sequence: 0xffffffff, unlockingScript: new UnlockingScript([]) })
        }
        for (const out of args.outputs) tx.addOutput({ satoshis: out.satoshis, lockingScript: P2PKH.prototype.lock.call(new P2PKH(), Utils.toArray(derivedPkh('vault/50'), 'hex')) })
        return { signableTransaction: { tx: tx.toAtomicBEEF(), reference: 'ref-2' } }
      }
    })
    // want 5000; one 6000 output covers it → remainder 1000 re-vaulted
    await withdrawFromVault(w, ADMIN, 5000, 'Withdraw 5000')
    const ca = w.calls.createAction[0] as any
    expect(ca.inputs).toHaveLength(1)
    expect(ca.outputs).toHaveLength(1)
    expect(ca.outputs[0].basket).toBe(VAULT_BASKET)
    expect(ca.outputs[0].satoshis).toBe(1000)
  })

  test('aborts the action if signing throws', async () => {
    await enrollFakeMeta()
    const fx = vaultOutputsFixture()
    const w = makeFakeWallet({
      async listOutputs() {
        return { outputs: fx.map(({ src: _s, ...o }) => o), BEEF: stitchBeef(fx) }
      },
      async createAction(args: any) {
        const tx = new Transaction()
        for (const inp of args.inputs) {
          const f = fx.find(x => x.outpoint === inp.outpoint)!
          tx.addInput({ sourceTransaction: f.src, sourceOutputIndex: 0, sequence: 0xffffffff, unlockingScript: new UnlockingScript([]) })
        }
        tx.addOutput({ satoshis: 5800, lockingScript: new P2PKH().lock(Utils.toArray(derivedPkh('vault/9'), 'hex')) })
        return { signableTransaction: { tx: tx.toAtomicBEEF(), reference: 'ref-3' } }
      },
      async createSignature() {
        throw new Error('boom')
      }
    })
    await expect(withdrawFromVault(w, ADMIN, 'all', 'x')).rejects.toBeDefined()
    expect((w.calls.abortAction?.[0] as any).reference).toBe('ref-3')
  })

  test('rejects when the vault is empty', async () => {
    await enrollFakeMeta()
    const w = makeFakeWallet({ async listOutputs() { return { outputs: [] } } })
    await expect(withdrawFromVault(w, ADMIN, 'all', 'x')).rejects.toMatchObject({ code: 'vault-empty' })
  })

  test('a partial withdrawal still re-vaults its remainder with no attestation', async () => {
    // Regression guard: nextDepositKey is the funnel for the re-vaulted
    // remainder as well as for deposits. Gating there would block most
    // WITHDRAWALS — locking users out of their own money is the exact failure
    // this feature exists to prevent. Note the absent backupAttestation.set.
    await enrollFakeMeta()
    const fx = vaultOutputsFixture() // two 6000-sat outputs = 12000
    const w = makeFakeWallet({
      async listOutputs() {
        return { outputs: fx.map(({ src: _s, ...o }) => o), BEEF: stitchBeef(fx) }
      },
      async createAction(args: any) {
        const tx = new Transaction()
        for (const inp of args.inputs) {
          const f = fx.find(x => x.outpoint === inp.outpoint)!
          tx.addInput({ sourceTransaction: f.src, sourceOutputIndex: 0, sequence: 0xffffffff, unlockingScript: new UnlockingScript([]) })
        }
        for (const out of args.outputs) tx.addOutput({ satoshis: out.satoshis, lockingScript: P2PKH.prototype.lock.call(new P2PKH(), Utils.toArray(derivedPkh('vault/50'), 'hex')) })
        return { signableTransaction: { tx: tx.toAtomicBEEF(), reference: 'ref-gate' } }
      }
    })

    await withdrawFromVault(w, ADMIN, 5000, 'Withdraw 5000')

    const ca = w.calls.createAction[0] as any
    expect(ca.outputs).toHaveLength(1)
    expect(ca.outputs[0].basket).toBe(VAULT_BASKET)
    expect(ca.outputs[0].satoshis).toBe(1000)
  })
})

describe('sweepVaultWithKey (recovery, no YubiKey)', () => {
  function vaultOutputsFixture() {
    const mk = (keyID: string, sats: number) => {
      const src = new Transaction()
      src.addOutput({ satoshis: sats, lockingScript: new P2PKH().lock(Utils.toArray(derivedPkh(keyID), 'hex')) })
      return { outpoint: `${src.id('hex')}.0`, satoshis: sats, customInstructions: JSON.stringify({ v: 1, keyID }), src }
    }
    return [mk('vault/0', 6000), mk('vault/1', 6000)]
  }

  test('sweeps every vault output to default, signing with the phrase key V', async () => {
    await enrollFakeMeta()
    const fx = vaultOutputsFixture()
    const w = makeFakeWallet({
      async listOutputs() {
        return { outputs: fx.map(({ src: _s, ...o }) => o), BEEF: stitchBeef(fx) }
      },
      async createAction(args: any) {
        const tx = new Transaction()
        for (const inp of args.inputs) {
          const f = fx.find(x => x.outpoint === inp.outpoint)!
          tx.addInput({ sourceTransaction: f.src, sourceOutputIndex: 0, sequence: 0xffffffff, unlockingScript: new UnlockingScript([]) })
        }
        return { signableTransaction: { tx: tx.toAtomicBEEF(), reference: 'sweep-ref' } }
      }
    })
    const res = await sweepVaultWithKey(w, ADMIN, new PrivateKey(V), 'Recover vault')
    expect(res?.txid).toBeDefined()
    const ca = w.calls.createAction[0] as any
    expect(ca.inputs).toHaveLength(2)
    expect(ca.outputs).toHaveLength(0) // all to default change, never re-vaulted
    expect(w.calls.getPublicKey).toBeUndefined() // no privileged calls — local V only
    expect(w.calls.createSignature).toBeUndefined()
  })

  test('returns null when the vault is already empty', async () => {
    const w = makeFakeWallet({ async listOutputs() { return { outputs: [] } } })
    expect(await sweepVaultWithKey(w, ADMIN, new PrivateKey(V), 'x')).toBeNull()
  })
})

describe('replenishDepositKeys', () => {
  test('tops the queue back up to 64 with increasing keyIDs', async () => {
    await enrollFakeMeta(60) // 60 keys, nextKeyIndex 60
    const w = makeFakeWallet()
    await replenishDepositKeys(w, ADMIN)
    const meta = (await vaultStore.getMeta()) as VaultMetaV1
    expect(meta.depositKeys).toHaveLength(64)
    expect(meta.nextKeyIndex).toBe(64)
    expect(meta.depositKeys[63].keyID).toBe('vault/63')
    expect(w.calls.getPublicKey).toHaveLength(4)
  })
})

describe('getVaultBalance', () => {
  test('sums the vault outputs', async () => {
    const w = makeFakeWallet({
      async listOutputs() {
        return { outputs: [{ outpoint: 'a.0', satoshis: 3000 }, { outpoint: 'b.0', satoshis: 4500 }] as any }
      }
    })
    expect(await getVaultBalance(w, ADMIN)).toBe(7500)
  })
})

/**
 * The signer (buildSignableTransaction) reads each vault input's
 * sourceTransaction ONLY from inputBEEF and throws if it is missing; storage
 * also re-verifies the whole BEEF with allowTxidOnly=true. buildVaultInputBeef
 * must satisfy BOTH: carry the raw source tx AND verify without a merkle proof.
 * This exercises the REAL @bsv/sdk Beef (the fake wallet cannot catch it).
 */
/**
 * A prior failed attempt can leave the vault UTXO reserved by an orphaned
 * 'nosend'/'unsigned' withdrawal → the toolbox raises WERR_REVIEW_ACTIONS
 * (double-spend) on the next createAction. The withdraw must abort only the
 * abortable orphans and retry once.
 */
describe('withdraw self-heals a double-spend from stuck reservations', () => {
  // The review error names the reserving txid(s) via reviewActionResults.competingTxs.
  const reviewError = (competingTxs: string[]) =>
    Object.assign(new Error('Undelayed createAction or signAction results require review.'), {
      code: 5,
      reviewActionResults: [{ txid: '', status: 'doubleSpend', competingTxs }]
    })

  const oneOutputFx = () => {
    const src = new Transaction()
    src.addOutput({ satoshis: 6000, lockingScript: new P2PKH().lock(Utils.toArray(derivedPkh('vault/0'), 'hex')) })
    return [{ outpoint: `${src.id('hex')}.0`, satoshis: 6000, customInstructions: JSON.stringify({ v: 1, keyID: 'vault/0' }), src }]
  }

  test('aborts exactly the reserving txid (by txid match) then retries createAction', async () => {
    await enrollFakeMeta()
    const fx = oneOutputFx()
    const RESERVING = 'ab'.repeat(32)
    let createCalls = 0
    const aborted: string[] = []
    const w = makeFakeWallet({
      async listOutputs() {
        return { outputs: fx.map(({ src: _s, ...o }) => o), BEEF: stitchBeef(fx) }
      },
      // Reserving tx carries no vault label — matched by txid, not label.
      async listActions() {
        return {
          actions: [
            { txid: RESERVING, status: 'nosend', reference: 'ref-reserving' }, // the culprit
            { txid: 'cd'.repeat(32), status: 'nosend', reference: 'ref-other' }, // unrelated txid
            { txid: RESERVING, status: 'completed', reference: 'ref-terminal' } // same txid, terminal
          ]
        }
      },
      async abortAction(args: any) {
        aborted.push(args.reference)
        return {}
      },
      async createAction(args: any) {
        if (++createCalls === 1) throw reviewError([RESERVING])
        const tx = new Transaction()
        for (const inp of args.inputs) {
          const f = fx.find(x => x.outpoint === inp.outpoint)!
          tx.addInput({ sourceTransaction: f.src, sourceOutputIndex: 0, sequence: 0xffffffff, unlockingScript: new UnlockingScript([]) })
        }
        tx.addOutput({ satoshis: 5800, lockingScript: new P2PKH().lock(Utils.toArray(derivedPkh('vault/9'), 'hex')) })
        return { signableTransaction: { tx: tx.toAtomicBEEF(), reference: 'ref-heal' } }
      }
    })

    const { txid } = await withdrawFromVault(w, ADMIN, 'all', 'Withdraw all')
    expect(txid).toBeDefined()
    expect(createCalls).toBe(2) // threw once, retried once
    expect(aborted).toEqual(['ref-reserving']) // only the matching txid + abortable status
  })

  test('rethrows the review error when the reserving tx is not abortable/found', async () => {
    await enrollFakeMeta()
    const fx = oneOutputFx()
    const RESERVING = 'ab'.repeat(32)
    const w = makeFakeWallet({
      async listOutputs() {
        return { outputs: fx.map(({ src: _s, ...o }) => o), BEEF: stitchBeef(fx) }
      },
      async listActions() {
        // Same txid exists but only in a terminal state → cannot abort.
        return { actions: [{ txid: RESERVING, status: 'completed', reference: 'ref-terminal' }] }
      },
      async createAction() {
        throw reviewError([RESERVING])
      }
    })
    await expect(withdrawFromVault(w, ADMIN, 'all', 'x')).rejects.toMatchObject({ code: 5 })
  })
})
