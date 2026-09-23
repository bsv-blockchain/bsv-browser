/**
 * Vault access guard — external origins must not reach privileged (vault) key
 * material. The load-bearing defense against the privilege-escalation finding.
 */
import { Beef, LockingScript, Transaction } from '@bsv/sdk'
import {
  EXTERNAL_ACTION_READ_TIMEOUT_MS,
  guardVaultAccess,
  isR1CLockingScript,
  VaultAccessDenied
} from '@bsv/expo-wallet-toolbox/core/services/vault/guard'
import { buildLock } from '@bsv/expo-wallet-toolbox/core/services/vault/r1comb'
import { capWalletArgs } from '@bsv/expo-wallet-toolbox/core/services/capWalletArgs'
import { limitsForTier } from '@bsv/expo-wallet-toolbox/core/services/walletArgLimits'
import { Wallet } from '@bsv/wallet-toolbox-mobile'

const ADMIN = 'admin.com'

const TXID = 'ab'.repeat(32)
const NORMAL_TXID = 'cd'.repeat(32)
let cachedVaultLock: string | undefined
const vaultLock = () => (cachedVaultLock ??= buildLock({
  commitments: ['11'.repeat(20), '22'.repeat(20)],
  saltHex64: '33'.repeat(32)
}).toHex())

test('wallet history reveals custom instructions only to the configured first-party origin', async () => {
  const makeResult = () => ({
    totalActions: 1,
    actions: [action({ outputs: [{ customInstructions: 'private-vault-recovery-record' }] })]
  })
  const wallet = Object.create(Wallet.prototype) as any
  wallet.identityKey = `02${'11'.repeat(32)}`
  wallet.__bsvVaultAdminOriginator = ADMIN
  wallet.storage = { listActions: jest.fn(async () => makeResult()) }
  // Members Wallet's constructor sets since toolbox 2.13 and listActions reads.
  wallet.telemetry = { enabled: false }
  wallet.actionBatch = { hasWorkspace: false, overlayListActions: (r: unknown) => r }

  const admin = await wallet.listActions({ labels: [], includeOutputs: true, limit: 10, offset: 0 }, ADMIN)
  expect(admin.actions[0].outputs[0].customInstructions).toBe('private-vault-recovery-record')

  const external = await wallet.listActions({ labels: [], includeOutputs: true, limit: 10, offset: 0 }, 'evil.com')
  expect(external.actions[0].outputs[0].customInstructions).toBeUndefined()
})

const action = (over: Record<string, unknown> = {}) => ({
  txid: NORMAL_TXID,
  satoshis: 1,
  status: 'completed',
  isOutgoing: false,
  description: 'Normal action',
  version: 1,
  lockTime: 0,
  reference: 'normal-ref',
  labels: ['normal'],
  inputs: [],
  outputs: [{
    satoshis: 1,
    spendable: true,
    tags: [],
    outputIndex: 0,
    outputDescription: 'Normal output',
    basket: 'normal',
    lockingScript: '51'
  }],
  ...over
})

function fakeWallet(storedActions: any[] = []) {
  const calls: { method: string; args: any; originator?: string }[] = []
  const rec = (method: string) => (args: any, originator?: string) => {
    calls.push({ method, args, originator })
    return Promise.resolve({ ok: true, method })
  }
  const listActions = async (args: any, originator?: string) => {
    calls.push({ method: 'listActions', args, originator })
    const labels: string[] = args?.labels ?? []
    const matching = labels.length === 0
      ? storedActions
      : storedActions.filter(item => labels.every(label => item.labels?.includes(label)))
    const offset = args?.offset ?? 0
    const limit = args?.limit ?? 10
    return { totalActions: matching.length, actions: matching.slice(offset, offset + limit) }
  }
  return {
    calls,
    wallet: {
      getPublicKey: rec('getPublicKey'),
      createSignature: rec('createSignature'),
      encrypt: rec('encrypt'),
      decrypt: rec('decrypt'),
      createHmac: rec('createHmac'),
      verifyHmac: rec('verifyHmac'),
      verifySignature: rec('verifySignature'),
      revealCounterpartyKeyLinkage: rec('revealCounterpartyKeyLinkage'),
      revealSpecificKeyLinkage: rec('revealSpecificKeyLinkage'),
      acquireCertificate: rec('acquireCertificate'),
      proveCertificate: rec('proveCertificate'),
      listCertificates: rec('listCertificates'),
      // not privileged-capable → must always pass through
      listOutputs: rec('listOutputs'),
      listActions,
      createAction: rec('createAction'),
      signAction: rec('signAction'),
      abortAction: rec('abortAction'),
      internalizeAction: rec('internalizeAction'),
      relinquishOutput: rec('relinquishOutput')
    } as any
  }
}

test('blocks non-admin privileged getPublicKey (deposit-key enumeration)', async () => {
  const { wallet } = fakeWallet()
  const guarded = guardVaultAccess(wallet, ADMIN)
  await expect(
    guarded.getPublicKey(
      { privileged: true, protocolID: [2, 'vault'], keyID: 'vault/0', counterparty: 'self' } as any,
      'evil.com'
    )
  ).rejects.toBeInstanceOf(VaultAccessDenied)
})

test('blocks non-admin privileged createSignature (the spend signature)', async () => {
  const { wallet } = fakeWallet()
  const guarded = guardVaultAccess(wallet, ADMIN)
  await expect(
    guarded.createSignature(
      { privileged: true, protocolID: [2, 'vault'], keyID: 'vault/0', hashToDirectlySign: [1] } as any,
      'evil.com'
    )
  ).rejects.toBeInstanceOf(VaultAccessDenied)
})

test.each([
  ['getPublicKey', [2, 'vault salt']],
  ['createHmac', [2, 'vault salt']],
  ['getPublicKey', [2, ' VAULT SALT ']],
  ['getPublicKey', [2, 'vault salt', 'ignored by derivation']]
] as const)(
  'reserves the Vault salt derivation protocol from external %s calls even without privileged (%p)',
  async (method, protocolID) => {
    const { wallet, calls } = fakeWallet()
    const guarded = guardVaultAccess(wallet, ADMIN)
    await expect(
      (guarded[method] as any)(
        { protocolID, keyID: '1', counterparty: 'self' },
        'evil.com'
      )
    ).rejects.toBeInstanceOf(VaultAccessDenied)
    expect(calls.find(call => call.method === method)).toBeUndefined()
  }
)

test('allows the Vault UI to derive its salt public key', async () => {
  const { wallet, calls } = fakeWallet()
  const guarded = guardVaultAccess(wallet, ADMIN)
  await guarded.getPublicKey(
    { protocolID: [2, 'vault salt'], keyID: '1', counterparty: 'self' },
    ADMIN
  )
  expect(calls.find(call => call.method === 'getPublicKey')).toBeDefined()
})

test('allows admin-originated privileged ops (the vault UI)', async () => {
  const { wallet, calls } = fakeWallet()
  const guarded = guardVaultAccess(wallet, ADMIN)
  await guarded.createSignature({ privileged: true, protocolID: [2, 'vault'], keyID: 'vault/0' } as any, ADMIN)
  expect(calls.find(c => c.method === 'createSignature')).toBeDefined()
})

test('allows non-privileged ops from any origin', async () => {
  const { wallet, calls } = fakeWallet()
  const guarded = guardVaultAccess(wallet, ADMIN)
  await guarded.getPublicKey({ protocolID: [1, 'x'], keyID: '1', counterparty: 'self' } as any, 'evil.com')
  expect(calls.find(c => c.method === 'getPublicKey')).toBeDefined()
})

test('passes a createAction that names no protected output', async () => {
  const { wallet, calls } = fakeWallet()
  const guarded = guardVaultAccess(wallet, ADMIN)
  await guarded.createAction({ inputs: [] } as any, 'evil.com')
  await guarded.listOutputs({ basket: 'x' } as any, 'evil.com')
  expect(calls.some(c => c.method === 'createAction')).toBe(true)
  expect(calls.some(c => c.method === 'listOutputs')).toBe(true)
})

test('recognizes only an exact current R1C locking script', () => {
  const lock = vaultLock()
  expect(isR1CLockingScript(lock)).toBe(true)
  expect(isR1CLockingScript(` ${lock}`)).toBe(true)
  expect(isR1CLockingScript(`${lock}\n`)).toBe(true)
  expect(isR1CLockingScript(`${lock.slice(0, 20)} ${lock.slice(20)}`)).toBe(false)
  expect(isR1CLockingScript(lock.slice(0, -2) + (lock.endsWith('00') ? '01' : '00'))).toBe(false)
  expect(isR1CLockingScript('51')).toBe(false)
})

test('hides Vault actions and their outpoints from an external action listing', async () => {
  const stored = [
    action(),
    action({
      txid: TXID,
      reference: 'vault-ref',
      labels: ['vault', 'vault-deposit'],
      outputs: [{
        satoshis: 50_000,
        spendable: true,
        tags: ['vault'],
        outputIndex: 0,
        outputDescription: 'Vault deposit',
        basket: 'admin vault',
        lockingScript: vaultLock()
      }]
    })
  ]
  const { wallet } = fakeWallet(stored)
  const guarded = guardVaultAccess(wallet, ADMIN)
  await expect(guarded.listActions({ labels: [], includeOutputs: true, limit: 10 } as any, 'evil.com')).resolves.toMatchObject({
    totalActions: 1,
    actions: [{ txid: NORMAL_TXID }]
  })
})

test('streams enriched history pages while retaining only the requested visible slice', async () => {
  const stored = Array.from({ length: 65 }, (_, i) => action({
    txid: i.toString(16).padStart(64, '0'),
    reference: `normal-${i}`
  }))
  const { wallet, calls } = fakeWallet(stored)
  const guarded = guardVaultAccess(wallet, ADMIN)
  await expect(
    guarded.listActions({ labels: [], includeOutputs: true, offset: 64, limit: 1 } as any, 'evil.com')
  ).resolves.toMatchObject({ totalActions: 65, actions: [{ reference: 'normal-64' }] })
  const pages = calls.filter(call => call.method === 'listActions')
  expect(pages.map(page => page.args.offset)).toEqual([0, 32, 64])
  expect(pages.every(page => page.args.limit === 32)).toBe(true)
})

test('coalesces concurrent identical external action listings into one enriched scan', async () => {
  const { wallet } = fakeWallet([action()])
  const original = wallet.listActions.bind(wallet)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const list = jest.fn(async (args: any, originator?: string) => {
    await gate
    return await original(args, originator)
  })
  wallet.listActions = list
  const guarded = guardVaultAccess(wallet, ADMIN)
  const args = { labels: [], includeOutputs: true, limit: 10 } as any
  const reads = [
    guarded.listActions(args, 'evil.com'),
    guarded.listActions(args, 'evil.com'),
    guarded.listActions(args, 'evil.com')
  ]
  await Promise.resolve()
  expect(list).toHaveBeenCalledTimes(1)
  release()
  await expect(Promise.all(reads)).resolves.toHaveLength(3)
  expect(list).toHaveBeenCalledTimes(1)
})

test('re-wrapping an existing guard is idempotent and cannot nest its queue', async () => {
  const { wallet, calls } = fakeWallet([action()])
  const guarded = guardVaultAccess(wallet, ADMIN)
  const wrappedAgain = guardVaultAccess(guarded, ADMIN)
  expect(wrappedAgain).toBe(guarded)

  await expect(wrappedAgain.createAction({ description: 'ordinary', inputs: [] } as any, 'evil.com'))
    .resolves.toEqual({ ok: true, method: 'createAction' })
  expect(calls.filter(call => call.method === 'listActions')).toHaveLength(1)
  expect(calls.filter(call => call.method === 'createAction')).toHaveLength(1)
})

test('fails closed instead of growing an unbounded queue of distinct enriched scans', async () => {
  const { wallet } = fakeWallet([action()])
  const original = wallet.listActions.bind(wallet)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  wallet.listActions = jest.fn(async (args: any, originator?: string) => {
    await gate
    return await original(args, originator)
  })
  const guarded = guardVaultAccess(wallet, ADMIN)
  const accepted = Array.from({ length: 16 }, (_, offset) =>
    guarded.listActions({ labels: [], offset, limit: 1 } as any, 'evil.com')
  )
  await expect(
    guarded.listActions({ labels: [], offset: 16, limit: 1 } as any, 'evil.com')
  ).rejects.toBeInstanceOf(VaultAccessDenied)
  release()
  await expect(Promise.all(accepted)).resolves.toHaveLength(16)
})

test('serializes external output-naming calls and rescans after each allowed mutation', async () => {
  const stored: any[] = []
  const { wallet, calls } = fakeWallet(stored)
  wallet.createAction = jest.fn(async (args: any, originator?: string) => {
    calls.push({ method: 'createAction', args, originator })
    if (args.description === 'first') {
      stored.push(action({
        txid: TXID,
        reference: 'vault-ref',
        labels: ['vault'],
        outputs: [{
          satoshis: 50_000,
          spendable: true,
          tags: ['vault'],
          outputIndex: 0,
          outputDescription: 'Vault deposit',
          basket: 'admin vault',
          lockingScript: vaultLock()
        }]
      }))
    }
    return { ok: true }
  })
  const guarded = guardVaultAccess(wallet, ADMIN)
  const first = guarded.createAction({ description: 'first', inputs: [] } as any, 'evil.com')
  const second = guarded.createAction({
    description: 'second',
    inputs: [{ outpoint: `${TXID}.0`, inputDescription: 'input', unlockingScriptLength: 1 }]
  } as any, 'evil.com')
  await expect(first).resolves.toEqual({ ok: true })
  await expect(second).rejects.toBeInstanceOf(VaultAccessDenied)
  expect(wallet.createAction).toHaveBeenCalledTimes(1)
  expect(calls.filter(call => call.method === 'listActions')).toHaveLength(2)
})

test('an admin mutation cannot race an external inventory scan on the same wallet', async () => {
  const stored: any[] = []
  const { wallet } = fakeWallet(stored)
  let releaseAdmin!: () => void
  const adminGate = new Promise<void>(resolve => { releaseAdmin = resolve })
  wallet.createAction = jest.fn(async (args: any) => {
    if (args.description === 'admin vault change') {
      await adminGate
      stored.push(action({
        txid: TXID,
        reference: 'vault-ref',
        labels: ['vault'],
        outputs: [{
          satoshis: 50_000,
          spendable: true,
          tags: ['vault'],
          outputIndex: 0,
          outputDescription: 'Vault deposit',
          basket: 'admin vault',
          lockingScript: vaultLock()
        }]
      }))
    }
    return { ok: true }
  })
  const guarded = guardVaultAccess(wallet, ADMIN)
  const admin = guarded.createAction({ description: 'admin vault change' } as any, ADMIN)
  const external = guarded.createAction({
    description: 'race the admin',
    inputs: [{ outpoint: `${TXID}.0`, inputDescription: 'input', unlockingScriptLength: 1 }]
  } as any, 'evil.com')
  await Promise.resolve()
  expect(wallet.createAction).toHaveBeenCalledTimes(1)
  releaseAdmin()
  await expect(admin).resolves.toEqual({ ok: true })
  await expect(external).rejects.toBeInstanceOf(VaultAccessDenied)
  expect(wallet.createAction).toHaveBeenCalledTimes(1)
})

test.each([
  { limit: '10000' },
  { limit: 10001 },
  { offset: -1 },
  { includeInputs: 'true' }
])('validates external listActions arguments before enriching its internal scan: %p', async invalid => {
  const { wallet, calls } = fakeWallet([action()])
  const guarded = guardVaultAccess(wallet, ADMIN)
  await expect(guarded.listActions({ labels: [], ...invalid } as any, 'evil.com')).rejects.toBeInstanceOf(
    VaultAccessDenied
  )
  expect(calls).toHaveLength(0)
})

test.each([
  { limit: 501 },
  { offset: 10_001 },
  { unknown: 'ignored by the SDK' },
  { labels: Array.from({ length: 65 }, (_, i) => `label-${i}`) },
  { labels: Array.from({ length: 20 }, (_, i) => `${i}-${'x'.repeat(248)}`) }
])('bounds external listActions request and response work before scanning: %p', async invalid => {
  const { wallet, calls } = fakeWallet([action()])
  const guarded = guardVaultAccess(wallet, ADMIN)
  await expect(guarded.listActions({ labels: [], ...invalid } as any, 'evil.com'))
    .rejects.toBeInstanceOf(VaultAccessDenied)
  expect(calls).toHaveLength(0)
})

test('a stalled external action read times out and releases the shared critical queue', async () => {
  jest.useFakeTimers()
  try {
    const { wallet, calls } = fakeWallet([action()])
    const original = wallet.listActions.bind(wallet)
    wallet.listActions = jest.fn(async (args: any, originator?: string) => {
      if (originator === 'evil.com') return await new Promise(() => {})
      return await original(args, originator)
    })
    const guarded = guardVaultAccess(wallet, ADMIN)
    const stalled = guarded.listActions({ labels: ['ordinary'] } as any, 'evil.com')
    const rejected = expect(stalled).rejects.toBeInstanceOf(VaultAccessDenied)
    await Promise.resolve()
    await jest.advanceTimersByTimeAsync(EXTERNAL_ACTION_READ_TIMEOUT_MS + 1)
    await rejected

    await expect(guarded.createAction({ description: 'ordinary', inputs: [] } as any, 'other.com'))
      .resolves.toEqual({ ok: true, method: 'createAction' })
    expect(calls.some(call => call.method === 'createAction')).toBe(true)
  } finally {
    jest.useRealTimers()
  }
})

test('blocks external createAction from reserving a Vault output by outpoint', async () => {
  const stored = [action({
    txid: TXID,
    reference: 'vault-ref',
    labels: ['vault', 'vault-deposit'],
    outputs: [{
      satoshis: 50_000,
      spendable: true,
      tags: ['vault'],
      outputIndex: 0,
      outputDescription: 'Vault deposit',
      basket: 'admin vault',
      lockingScript: vaultLock()
    }]
  })]
  const { wallet, calls } = fakeWallet(stored)
  const guarded = guardVaultAccess(wallet, ADMIN)
  await expect(guarded.createAction({
    description: 'Reserve someone else output',
    inputs: [{ outpoint: `${TXID}.0`, inputDescription: 'Vault input', unlockingScriptLength: 100 }]
  } as any, 'evil.com')).rejects.toBeInstanceOf(VaultAccessDenied)
  expect(calls.some(c => c.method === 'createAction')).toBe(false)
})

test.each(['00', '0e0', '-0', ''])(
  'canonicalizes SDK-accepted vout spelling %p before protecting a Vault outpoint',
  async spelling => {
    const stored = [action({
      txid: TXID,
      reference: 'vault-ref',
      labels: ['vault'],
      outputs: [{
        satoshis: 50_000,
        spendable: true,
        tags: ['vault'],
        outputIndex: 0,
        outputDescription: 'Vault deposit',
        basket: 'admin vault',
        lockingScript: vaultLock()
      }]
    })]
    const { wallet, calls } = fakeWallet(stored)
    const guarded = guardVaultAccess(wallet, ADMIN)
    await expect(guarded.createAction({
      description: 'Alternate outpoint spelling',
      inputs: [{ outpoint: `${TXID}.${spelling}`, inputDescription: 'Vault input', unlockingScriptLength: 100 }]
    } as any, 'evil.com')).rejects.toBeInstanceOf(VaultAccessDenied)
    expect(calls.some(c => c.method === 'createAction')).toBe(false)
  }
)

test('blocks external internalizeAction from reclassifying an existing Vault output', async () => {
  const tx = new Transaction()
  tx.addOutput({ satoshis: 50_000, lockingScript: LockingScript.fromHex(vaultLock()) })
  const beef = new Beef()
  beef.mergeTransaction(tx)
  const stored = [action({
    txid: tx.id('hex'),
    reference: 'vault-ref',
    labels: ['vault', 'vault-deposit'],
    outputs: [{
      satoshis: 50_000,
      spendable: true,
      tags: ['vault'],
      outputIndex: 0,
      outputDescription: 'Vault deposit',
      basket: 'admin vault',
      lockingScript: vaultLock()
    }]
  })]
  const { wallet, calls } = fakeWallet(stored)
  const guarded = guardVaultAccess(wallet, ADMIN)
  await expect(guarded.internalizeAction({
    tx: beef.toBinaryAtomic(tx.id('hex')),
    description: 'Move Vault output',
    labels: [],
    outputs: [{ outputIndex: 0, protocol: 'basket insertion', insertionRemittance: { basket: 'normal' } }]
  } as any, 'evil.com')).rejects.toBeInstanceOf(VaultAccessDenied)
  expect(calls.some(c => c.method === 'internalizeAction')).toBe(false)
})

// Toolbox 2.14's own reclassification check skips an output that has no basket
// (relinquished; listActions reports it as '') or sits in `default`, so the
// refusal must not depend on the stored basket.
test.each(['', 'default'])(
  'blocks external internalizeAction from reclassifying a Vault output whose stored basket is %j',
  async basket => {
    const tx = new Transaction()
    tx.addOutput({ satoshis: 50_000, lockingScript: LockingScript.fromHex(vaultLock()) })
    const beef = new Beef()
    beef.mergeTransaction(tx)
    const stored = [action({
      txid: tx.id('hex'),
      reference: 'relinquished-ref',
      labels: [],
      outputs: [{
        satoshis: 50_000,
        spendable: true,
        tags: [],
        outputIndex: 0,
        outputDescription: 'Relinquished output',
        basket,
        lockingScript: vaultLock()
      }]
    })]
    const { wallet, calls } = fakeWallet(stored)
    const guarded = guardVaultAccess(wallet, ADMIN)
    await expect(guarded.internalizeAction({
      tx: beef.toBinaryAtomic(tx.id('hex')),
      description: 'Move Vault output',
      labels: [],
      outputs: [{ outputIndex: 0, protocol: 'basket insertion', insertionRemittance: { basket: 'normal' } }]
    } as any, 'evil.com')).rejects.toBeInstanceOf(VaultAccessDenied)
    expect(calls.some(c => c.method === 'internalizeAction')).toBe(false)
  }
)

test('blocks external construction or internalization of a new R1C output', async () => {
  const { wallet, calls } = fakeWallet()
  const guarded = guardVaultAccess(wallet, ADMIN)
  await expect(guarded.createAction({
    description: 'Hidden Vault output',
    outputs: [{ satoshis: 1, lockingScript: vaultLock(), outputDescription: 'Hidden lock', basket: 'normal' }]
  } as any, 'evil.com')).rejects.toBeInstanceOf(VaultAccessDenied)

  const tx = new Transaction()
  tx.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex(vaultLock()) })
  const beef = new Beef()
  beef.mergeTransaction(tx)
  await expect(guarded.internalizeAction({
    tx: beef.toBinaryAtomic(tx.id('hex')),
    description: 'Hidden Vault internalization',
    labels: [],
    // The SDK accepts numeric spellings; the guard must normalize them too.
    outputs: [{ outputIndex: '00', protocol: 'basket insertion', insertionRemittance: { basket: 'normal' } }]
  } as any, 'evil.com')).rejects.toBeInstanceOf(VaultAccessDenied)
  expect(calls.some(c => c.method === 'createAction')).toBe(false)
  expect(calls.some(c => c.method === 'internalizeAction')).toBe(false)
})

test('blocks SDK-trimmed R1C script strings and protects an R1C action even without a Vault label', async () => {
  const stored = [action({
    txid: TXID,
    reference: 'mislabeled-r1c-ref',
    labels: ['ordinary'],
    outputs: [{
      satoshis: 50_000,
      spendable: true,
      tags: [],
      outputIndex: 0,
      outputDescription: 'Mislabeled lock',
      basket: 'normal',
      lockingScript: vaultLock()
    }]
  })]
  const { wallet, calls } = fakeWallet(stored)
  const guarded = guardVaultAccess(wallet, ADMIN)

  await expect(guarded.createAction({
    description: 'Whitespace-normalized R1C output',
    outputs: [{ satoshis: 1, lockingScript: ` ${vaultLock()}\n`, outputDescription: 'Hidden lock', basket: 'normal' }]
  } as any, 'evil.com')).rejects.toBeInstanceOf(VaultAccessDenied)
  await expect(guarded.createAction({
    description: 'Spend mislabeled R1C output',
    inputs: [{ outpoint: `${TXID}.0`, inputDescription: 'Input', unlockingScriptLength: 100 }]
  } as any, 'evil.com')).rejects.toBeInstanceOf(VaultAccessDenied)
  expect(calls.some(c => c.method === 'createAction')).toBe(false)
})

test('blocks signAction for a pending Vault reference', async () => {
  const stored = [action({
    txid: TXID,
    reference: 'vault-ref',
    labels: ['vault', 'vault-withdraw'],
    inputs: [{
      sourceOutpoint: `${TXID}.0`,
      sourceSatoshis: 50_000,
      sourceLockingScript: vaultLock(),
      inputDescription: 'Vault input',
      sequenceNumber: 0xffffffff
    }],
    outputs: []
  })]
  const { wallet, calls } = fakeWallet(stored)
  const guarded = guardVaultAccess(wallet, ADMIN)
  await expect(guarded.signAction({ reference: 'vault-ref', spends: {} } as any, 'evil.com')).rejects.toBeInstanceOf(
    VaultAccessDenied
  )
  expect(calls.some(c => c.method === 'signAction')).toBe(false)
})

test.each(['createAction', 'signAction'] as const)(
  'blocks external %s from releasing a held Vault transaction through sendWith',
  async method => {
    const stored = [action({
      txid: TXID,
      reference: 'vault-ref',
      status: 'nosend',
      labels: ['vault', 'vault-deposit'],
      outputs: [{
        satoshis: 50_000,
        spendable: false,
        tags: ['vault'],
        outputIndex: 0,
        outputDescription: 'Vault deposit',
        basket: 'admin vault',
        lockingScript: vaultLock()
      }]
    })]
    const { wallet, calls } = fakeWallet(stored)
    const guarded = guardVaultAccess(wallet, ADMIN)
    const args = method === 'createAction'
      ? { description: 'Release held transaction', options: { sendWith: [TXID.toUpperCase()] } }
      : { reference: 'ordinary-ref', spends: {}, options: { sendWith: [TXID.toUpperCase()] } }

    await expect((guarded as any)[method](args, 'evil.com')).rejects.toBeInstanceOf(VaultAccessDenied)
    expect(calls.some(c => c.method === method)).toBe(false)
  }
)

test.each(['createAction', 'signAction'] as const)(
  'fails closed on malformed external %s sendWith capabilities',
  async method => {
    const { wallet, calls } = fakeWallet([action()])
    const guarded = guardVaultAccess(wallet, ADMIN)
    const args = method === 'createAction'
      ? { description: 'Malformed sendWith', options: { sendWith: 'ab'.repeat(32) } }
      : { reference: 'ordinary-ref', spends: {}, options: { sendWith: [123] } }

    await expect((guarded as any)[method](args, 'evil.com')).rejects.toBeInstanceOf(VaultAccessDenied)
    expect(calls.some(c => c.method === method)).toBe(false)
  }
)

test('preserves this for class methods so getPublicKey can call ensureCanCall', async () => {
  // SimpleWalletManager.getPublicKey is a prototype method that does
  // this.ensureCanCall(originator). Pairing/connections wrap that manager in
  // guardVaultAccess; if the trap invokes the method unbound, identity-key
  // retrieval fails with "this.ensureCanCall is not a function".
  class WalletLike {
    ensureCanCall(_originator?: string) {
      /* the load-bearing this-call */
    }
    async getPublicKey(args: any, originator?: string) {
      this.ensureCanCall(originator)
      return { publicKey: '02ab', originator, args }
    }
    async getVersion(_args: any, originator?: string) {
      this.ensureCanCall(originator)
      return { version: '1.0.0' }
    }
  }
  const guarded = guardVaultAccess(new WalletLike() as any, ADMIN)
  await expect(guarded.getPublicKey({ identityKey: true }, 'swap.siftbitcoin.com')).resolves.toEqual({
    publicKey: '02ab',
    originator: 'swap.siftbitcoin.com',
    args: { identityKey: true }
  })
  await expect(guarded.getVersion({}, 'swap.siftbitcoin.com')).resolves.toEqual({ version: '1.0.0' })
})

test('composed capWalletArgs(guardVaultAccess) still preserves this on getPublicKey', async () => {
  class WalletLike {
    ensureCanCall(_originator?: string) {}
    async getPublicKey(args: any) {
      this.ensureCanCall()
      return { publicKey: '02cd', args }
    }
    async createAction() {
      this.ensureCanCall()
      return { txid: 'x' }
    }
  }
  const wrapped = capWalletArgs(guardVaultAccess(new WalletLike() as any, ADMIN), limitsForTier('mid'))
  await expect(wrapped.getPublicKey({ identityKey: true }, 'swap.siftbitcoin.com')).resolves.toEqual({
    publicKey: '02cd',
    args: { identityKey: true }
  })
})

test('treats missing/false privileged flag as allowed', async () => {
  const { wallet, calls } = fakeWallet()
  const guarded = guardVaultAccess(wallet, ADMIN)
  await guarded.encrypt({ privileged: false, protocolID: [2, 'x'], keyID: '1' } as any, 'evil.com')
  await guarded.decrypt({ protocolID: [2, 'x'], keyID: '1' } as any, 'evil.com')
  expect(calls).toHaveLength(2)
})

// ── certificate ops (privilege-escalation review round 1) ──
//
// acquireCertificate's 'direct' branch and proveCertificate both thread
// `privileged` straight into the underlying wallet's own getPublicKey /
// MasterCertificate.createKeyringForVerifier call — the same root-key
// exposure createSignature/getPublicKey above already guard against. These
// three were missing from PRIVILEGED_CAPABLE entirely, so the Proxy trap
// never intercepted them and they passed straight through unchecked
// regardless of origin.
const CERT_CASES: { method: 'acquireCertificate' | 'proveCertificate' | 'listCertificates'; args: any }[] = [
  {
    method: 'acquireCertificate',
    args: {
      type: 'dGVzdA==',
      certifier: '02' + '11'.repeat(32),
      acquisitionProtocol: 'direct',
      fields: { name: 'x' }
    }
  },
  {
    method: 'proveCertificate',
    args: {
      certificate: { type: 'dGVzdA==', subject: '02' + '11'.repeat(32) },
      fieldsToReveal: ['name'],
      verifier: '02' + '22'.repeat(32)
    }
  },
  {
    method: 'listCertificates',
    args: { certifiers: ['02' + '11'.repeat(32)], types: ['dGVzdA=='] }
  }
]

for (const { method, args } of CERT_CASES) {
  test(`blocks non-admin privileged ${method}`, async () => {
    const { wallet } = fakeWallet()
    const guarded = guardVaultAccess(wallet, ADMIN)
    await expect((guarded as any)[method]({ ...args, privileged: true }, 'evil.com')).rejects.toBeInstanceOf(
      VaultAccessDenied
    )
  })

  test(`allows non-privileged ${method} from any origin`, async () => {
    const { wallet, calls } = fakeWallet()
    const guarded = guardVaultAccess(wallet, ADMIN)
    await (guarded as any)[method](args, 'evil.com')
    expect(calls.find(c => c.method === method)).toBeDefined()
  })

  test(`allows admin-originated privileged ${method}`, async () => {
    const { wallet, calls } = fakeWallet()
    const guarded = guardVaultAccess(wallet, ADMIN)
    await (guarded as any)[method]({ ...args, privileged: true }, ADMIN)
    expect(calls.find(c => c.method === method)).toBeDefined()
  })
}
