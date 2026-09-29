/**
 * Vault access guard — external origins must not reach privileged (vault) key
 * material. The load-bearing defense against the privilege-escalation finding.
 */
import { Beef, LockingScript, Transaction, Validation } from '@bsv/sdk'
import {
  EXTERNAL_ACTION_READ_TIMEOUT_MS,
  guardVaultAccess,
  isR1CLockingScript,
  VaultAccessDenied,
  type VaultGuardLookup
} from '@bsv/expo-wallet-toolbox/core/services/vault/guard'
import { buildLock } from '@bsv/expo-wallet-toolbox/core/services/vault/r1comb'
import { capWalletArgs } from '@bsv/expo-wallet-toolbox/core/services/capWalletArgs'
import { limitsForTier } from '@bsv/expo-wallet-toolbox/core/services/walletArgLimits'
import { Wallet } from '@bsv/wallet-toolbox-mobile'

const ADMIN = 'admin.com'

const TXID = 'ab'.repeat(32)
const NORMAL_TXID = 'cd'.repeat(32)
let cachedVaultLock: string | undefined
const vaultLock = () =>
  (cachedVaultLock ??= buildLock({
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
  outputs: [
    {
      satoshis: 1,
      spendable: true,
      tags: [],
      outputIndex: 0,
      outputDescription: 'Normal output',
      basket: 'normal',
      lockingScript: '51'
    }
  ],
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
    const matching =
      labels.length === 0
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
      // not privileged-capable / not outpoint-naming → not vault-guarded, but
      // still bound for size (XR-019) when the caller is non-admin
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

/** Storage stand-in for the guard's point lookups: `adminOutpoints` are admin
 * state, `adminTxids` are Vault/admin transactions. */
function fakeLookup(opts: { adminOutpoints?: string[]; adminTxids?: string[] } = {}) {
  const lookup = {
    anyAdminOutpoint: jest.fn(async (outpoints: string[]) =>
      outpoints.some(outpoint => (opts.adminOutpoints ?? []).includes(outpoint))
    ),
    anyAdminTransaction: jest.fn(async (txids: string[]) => txids.some(txid => (opts.adminTxids ?? []).includes(txid)))
  }
  return lookup satisfies VaultGuardLookup
}

// XR-037 (defense-in-depth): the customInstructions redaction the previous
// test exercises lives in the VENDORED Wallet.listActions patch, beneath both
// WalletPermissionsManager and this module. guard.ts's own sanitizeAction
// must not depend solely on that patch surviving a future @bsv/wallet-toolbox
// -mobile bump — it should redact customInstructions for a non-admin
// originator on its own, using a plain fake wallet that applies no such
// patch at all.
test('guard.ts itself strips customInstructions from listActions outputs for a non-admin originator', async () => {
  const stored = [
    action({
      outputs: [
        {
          satoshis: 1,
          spendable: true,
          tags: [],
          outputIndex: 0,
          outputDescription: 'Token output',
          basket: 'p mandala',
          lockingScript: '51',
          customInstructions: JSON.stringify({ protocolID: [2, 'mandala'], keyID: 'k', counterparty: 'self' })
        }
      ]
    })
  ]
  const { wallet } = fakeWallet(stored)
  const guarded = guardVaultAccess(wallet, ADMIN)

  const external = await guarded.listActions(
    { labels: [], includeOutputs: true, limit: 10, offset: 0 } as any,
    'evil.com'
  )
  expect(external.actions[0].outputs[0].customInstructions).toBeUndefined()

  // The app's own view is untouched by this guard.
  const admin = await guarded.listActions(
    { labels: [], includeOutputs: true, limit: 10, offset: 0 } as any,
    ADMIN
  )
  expect(admin.actions[0].outputs[0].customInstructions).toBeDefined()
})

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
      (guarded[method] as any)({ protocolID, keyID: '1', counterparty: 'self' }, 'evil.com')
    ).rejects.toBeInstanceOf(VaultAccessDenied)
    expect(calls.find(call => call.method === method)).toBeUndefined()
  }
)

// INT-04: the v7 marker/descriptor protocol names must be reserved the same
// way 'vault salt' already is — atomically with the release that starts
// creating v7 outputs (guard.ts's VAULT_PROTOCOL_NAMES). Mirrors the
// 'vault salt' coverage above across every PRIVILEGED_CAPABLE method that
// could otherwise derive a marker key or decrypt a descriptor.
test.each([
  ['getPublicKey', [2, 'vault marker']],
  ['getPublicKey', [2, 'vault descriptor']],
  ['encrypt', [2, 'vault descriptor']],
  ['decrypt', [2, 'vault descriptor']],
  ['createHmac', [2, 'vault marker']],
  ['createSignature', [2, 'vault marker']],
  ['revealSpecificKeyLinkage', [2, 'vault descriptor']],
  ['verifyHmac', [2, 'vault marker']],
  ['verifySignature', [2, 'vault descriptor']],
  ['revealCounterpartyKeyLinkage', [2, 'vault marker']],
  // Case/whitespace normalization, matching KeyDeriver.computeInvoiceNumber.
  ['getPublicKey', [2, ' VAULT MARKER ']],
  ['decrypt', [2, ' Vault Descriptor ']],
  ['getPublicKey', [2, 'vault marker', 'ignored by derivation']]
] as const)(
  'reserves the Vault marker/descriptor protocols from external %s calls even without privileged (%p)',
  async (method, protocolID) => {
    const { wallet, calls } = fakeWallet()
    const guarded = guardVaultAccess(wallet, ADMIN)
    await expect(
      (guarded[method] as any)(
        { protocolID, keyID: 'test:1', counterparty: 'self' },
        'evil.com'
      )
    ).rejects.toBeInstanceOf(VaultAccessDenied)
    expect(calls.find(call => call.method === method)).toBeUndefined()
  }
)

test.each(['vault marker', 'vault descriptor'] as const)(
  'allows the admin originator through the reserved %s protocol',
  async protocolName => {
    const { wallet, calls } = fakeWallet()
    const guarded = guardVaultAccess(wallet, ADMIN)
    await guarded.getPublicKey({ protocolID: [2, protocolName], keyID: 'test:1', counterparty: 'self' } as any, ADMIN)
    expect(calls.find(call => call.method === 'getPublicKey')).toBeDefined()
  }
)

// XR-001 / XR-002: metaAuthority.ts computes every vault-meta and
// enrollment-draft integrity tag under this namespace. A connected/paired
// caller must never be able to mint or verify one itself — see
// metaAuthority.ts's header and guard.ts's VAULT_PROTOCOL_NAMES.
test.each([
  ['createHmac', [2, 'vault meta']],
  ['verifyHmac', [2, 'vault meta']],
  ['getPublicKey', [2, ' VAULT META ']],
  ['createHmac', [2, 'vault meta', 'ignored by derivation']]
] as const)(
  'XR-001/XR-002: reserves the Vault meta authority-tag protocol from external %s calls even without privileged (%p)',
  async (method, protocolID) => {
    const { wallet, calls } = fakeWallet()
    const guarded = guardVaultAccess(wallet, ADMIN)
    await expect(
      (guarded[method] as any)({ protocolID, keyID: 'test:meta', counterparty: 'self' }, 'evil.com')
    ).rejects.toBeInstanceOf(VaultAccessDenied)
    expect(calls.find(call => call.method === method)).toBeUndefined()
  }
)

test('XR-001/XR-002: allows the admin originator through the reserved vault meta protocol', async () => {
  const { wallet, calls } = fakeWallet()
  const guarded = guardVaultAccess(wallet, ADMIN)
  await guarded.createHmac(
    { protocolID: [2, 'vault meta'], keyID: 'test:meta', counterparty: 'self', data: [1] } as any,
    ADMIN
  )
  expect(calls.find(c => c.method === 'createHmac')).toBeDefined()
})

test('allows the Vault UI to derive its salt public key', async () => {
  const { wallet, calls } = fakeWallet()
  const guarded = guardVaultAccess(wallet, ADMIN)
  await guarded.getPublicKey({ protocolID: [2, 'vault salt'], keyID: '1', counterparty: 'self' }, ADMIN)
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

test.each([
  ['getPublicKey', [2, '3241645161d8']],
  ['createSignature', [2, '3241645161d8']],
  ['getPublicKey', [2, 'mandala token']],
  ['createSignature', [2, 'mandala token']],
  ['getPublicKey', [2, ' Mandala Token ']]
] as const)(
  // XR-020: the address rail / PeerPay ([2,'3241645161d8']) and the FT rail
  // ([2,'mandala token']) are this wallet's OWN payment-signing namespaces,
  // not Vault state -- but a paired origin must still be unable to mint a
  // raw signature or public key under them, or it can assemble an
  // unauthorized spend without ever going through createAction/signAction.
  'reserves the wallet-internal payment-rail protocols from external %s calls (%p)',
  async (method, protocolID) => {
    const { wallet, calls } = fakeWallet()
    const guarded = guardVaultAccess(wallet, ADMIN)
    await expect(
      (guarded[method] as any)({ protocolID, keyID: 'x', counterparty: 'anyone' }, 'evil.com')
    ).rejects.toBeInstanceOf(VaultAccessDenied)
    expect(calls.find(call => call.method === method)).toBeUndefined()
  }
)

test('still allows the admin originator to use the address-rail/FT protocols directly', async () => {
  const { wallet, calls } = fakeWallet()
  const guarded = guardVaultAccess(wallet, ADMIN)
  await guarded.getPublicKey({ protocolID: [2, '3241645161d8'], keyID: 'x', counterparty: 'anyone' } as any, ADMIN)
  expect(calls.find(c => c.method === 'getPublicKey')).toBeDefined()
})

test.each([
  ['createHmac', [2, 'connection authority']],
  ['verifyHmac', [2, 'connection authority']],
  ['createHmac', [2, ' Connection Authority ']]
] as const)(
  // XR-027: the saved-pairing authority tag (connectionAuthority.ts) is only
  // meaningful if a paired peer can never mint or verify it itself -- a
  // paired origin's site-scoped WalletClient forwards createHmac/verifyHmac
  // for any non-reserved namespace, so without this reservation the peer
  // could compute the exact same tag over the same allowlisted RPC method.
  'reserves the connection-authority protocol from external %s calls (%p)',
  async (method, protocolID) => {
    const { wallet, calls } = fakeWallet()
    const guarded = guardVaultAccess(wallet, ADMIN)
    await expect(
      (guarded[method] as any)({ protocolID, keyID: 'topic-1', counterparty: 'self', data: [1, 2, 3] }, 'evil.com')
    ).rejects.toBeInstanceOf(VaultAccessDenied)
    expect(calls.find(call => call.method === method)).toBeUndefined()
  }
)

test('still allows the admin originator to use the connection-authority protocol directly', async () => {
  const { wallet, calls } = fakeWallet()
  const guarded = guardVaultAccess(wallet, ADMIN)
  await guarded.createHmac(
    { protocolID: [2, 'connection authority'], keyID: 'topic-1', counterparty: 'self', data: [1, 2, 3] } as any,
    ADMIN
  )
  expect(calls.find(c => c.method === 'createHmac')).toBeDefined()
})

test.each([
  ['createHmac', [2, 'pending abort authority']],
  ['verifyHmac', [2, 'pending abort authority']],
  ['createHmac', [2, ' Pending Abort Authority ']]
] as const)(
  // XR-102 (non-Vault residual): core/localpay/pendingAbortAuthority.ts's tag
  // is only meaningful if a paired/connected origin can never mint or verify
  // it itself -- same reasoning as `connection authority` above.
  'reserves the pending-abort-authority protocol from external %s calls (%p)',
  async (method, protocolID) => {
    const { wallet, calls } = fakeWallet()
    const guarded = guardVaultAccess(wallet, ADMIN)
    await expect(
      (guarded[method] as any)({ protocolID, keyID: 'ref-1', counterparty: 'self', data: [1, 2, 3] }, 'evil.com')
    ).rejects.toBeInstanceOf(VaultAccessDenied)
    expect(calls.find(call => call.method === method)).toBeUndefined()
  }
)

test('still allows the admin originator to use the pending-abort-authority protocol directly', async () => {
  const { wallet, calls } = fakeWallet()
  const guarded = guardVaultAccess(wallet, ADMIN)
  await guarded.createHmac(
    { protocolID: [2, 'pending abort authority'], keyID: 'ref-1', counterparty: 'self', data: [1, 2, 3] } as any,
    ADMIN
  )
  expect(calls.find(c => c.method === 'createHmac')).toBeDefined()
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
      outputs: [
        {
          satoshis: 50_000,
          spendable: true,
          tags: ['vault'],
          outputIndex: 0,
          outputDescription: 'Vault deposit',
          basket: 'admin vault',
          lockingScript: vaultLock()
        }
      ]
    })
  ]
  const { wallet } = fakeWallet(stored)
  const guarded = guardVaultAccess(wallet, ADMIN)
  await expect(
    guarded.listActions({ labels: [], includeOutputs: true, limit: 10 } as any, 'evil.com')
  ).resolves.toMatchObject({
    totalActions: 1,
    actions: [{ txid: NORMAL_TXID }]
  })
})

test('streams enriched history pages while retaining only the requested visible slice', async () => {
  const stored = Array.from({ length: 65 }, (_, i) =>
    action({
      txid: i.toString(16).padStart(64, '0'),
      reference: `normal-${i}`
    })
  )
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
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
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

test('re-wrapping an existing guard is idempotent and keeps its lookup', async () => {
  const { wallet, calls } = fakeWallet([action()])
  const lookup = fakeLookup({ adminOutpoints: [`${TXID}.0`] })
  const guarded = guardVaultAccess(wallet, ADMIN, { lookup })
  const wrappedAgain = guardVaultAccess(guarded, ADMIN)
  expect(wrappedAgain).toBe(guarded)

  await expect(wrappedAgain.createAction({ description: 'ordinary', inputs: [] } as any, 'evil.com')).resolves.toEqual({
    ok: true,
    method: 'createAction'
  })
  await expect(
    wrappedAgain.relinquishOutput({ basket: 'x', output: `${TXID}.0` } as any, 'evil.com')
  ).rejects.toBeInstanceOf(VaultAccessDenied)
  expect(lookup.anyAdminOutpoint).toHaveBeenCalledTimes(1)
  expect(calls.filter(call => call.method === 'listActions')).toHaveLength(0)
  expect(calls.filter(call => call.method === 'createAction')).toHaveLength(1)
})

test('fails closed instead of growing an unbounded queue of distinct enriched scans', async () => {
  const { wallet } = fakeWallet([action()])
  const original = wallet.listActions.bind(wallet)
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  wallet.listActions = jest.fn(async (args: any, originator?: string) => {
    await gate
    return await original(args, originator)
  })
  const guarded = guardVaultAccess(wallet, ADMIN)
  const accepted = Array.from({ length: 16 }, (_, offset) =>
    guarded.listActions({ labels: [], offset, limit: 1 } as any, 'evil.com')
  )
  await expect(guarded.listActions({ labels: [], offset: 16, limit: 1 } as any, 'evil.com')).rejects.toBeInstanceOf(
    VaultAccessDenied
  )
  release()
  await expect(Promise.all(accepted)).resolves.toHaveLength(16)
})

test.each([{ limit: '10000' }, { limit: 10001 }, { offset: -1 }, { includeInputs: 'true' }])(
  'validates external listActions arguments before enriching its internal scan: %p',
  async invalid => {
    const { wallet, calls } = fakeWallet([action()])
    const guarded = guardVaultAccess(wallet, ADMIN)
    await expect(guarded.listActions({ labels: [], ...invalid } as any, 'evil.com')).rejects.toBeInstanceOf(
      VaultAccessDenied
    )
    expect(calls).toHaveLength(0)
  }
)

test.each([
  { limit: 501 },
  { offset: 10_001 },
  { unknown: 'ignored by the SDK' },
  { labels: Array.from({ length: 65 }, (_, i) => `label-${i}`) },
  { labels: Array.from({ length: 20 }, (_, i) => `${i}-${'x'.repeat(248)}`) }
])('bounds external listActions request and response work before scanning: %p', async invalid => {
  const { wallet, calls } = fakeWallet([action()])
  const guarded = guardVaultAccess(wallet, ADMIN)
  await expect(guarded.listActions({ labels: [], ...invalid } as any, 'evil.com')).rejects.toBeInstanceOf(
    VaultAccessDenied
  )
  expect(calls).toHaveLength(0)
})

// XR-019: listOutputs had no bridge-level bound at all — an authenticated
// paired peer could request up to the SDK's own 10000-row ceiling, and with
// includeTransactions each row also carries a full aggregate BEEF, big
// enough to plausibly OOM a mobile app. This must be refused before it
// reaches the underlying wallet, exactly like the listActions bounds above.
test.each([
  { limit: 1001 },
  { limit: 10000 },
  { limit: 101, include: 'entire transactions' },
  { offset: 10_001 }
])('bounds external listOutputs request before it reaches the underlying wallet: %p', async invalid => {
  const { wallet, calls } = fakeWallet()
  const guarded = guardVaultAccess(wallet, ADMIN)
  await expect(guarded.listOutputs({ basket: 'x', ...invalid } as any, 'evil.com')).rejects.toBeInstanceOf(
    VaultAccessDenied
  )
  expect(calls.some(c => c.method === 'listOutputs')).toBe(false)
})

test('allows an external listOutputs call within the bound, and an admin call above it', async () => {
  const { wallet, calls } = fakeWallet()
  const guarded = guardVaultAccess(wallet, ADMIN)

  await guarded.listOutputs({ basket: 'x', limit: 1000 } as any, 'evil.com')
  expect(calls.some(c => c.method === 'listOutputs' && c.originator === 'evil.com')).toBe(true)

  // The admin (this app's own code) originator is never bound by this — it
  // is not the untrusted caller this guard defends against.
  await guarded.listOutputs({ basket: 'x', limit: 10000 } as any, ADMIN)
  expect(calls.some(c => c.method === 'listOutputs' && c.originator === ADMIN)).toBe(true)
})

// The bound validates the request, but must forward the caller's own args.
// The SDK's validated form swaps `include` for includeTransactions /
// includeLockingScripts, and the wallet validates again downstream: forwarding
// the validated object silently dropped `include`, so an external caller got
// no BEEF and no locking scripts, and a later createAction spending those
// outputs failed with "Every signableTransaction input must have a
// sourceTransaction".
// The bound must admit the SDK's own clients. @bsv/sdk's ContactsManager
// (behind IdentityClient.resolveByAttributes / resolveByIdentityKey and
// saveContact / removeContact) asks for these exact pages; refusing them broke
// identity lookups in every in-tab dApp with 'Wallet operation "listOutputs"
// is not permitted'.
test.each([
  { basket: 'contacts', include: 'locking scripts', includeCustomInstructions: true, tags: [], limit: 1000 },
  {
    basket: 'contacts',
    include: 'entire transactions',
    includeCustomInstructions: true,
    tags: [`identityKey ${'ab'.repeat(32)}`],
    limit: 100
  }
])('admits the SDK ContactsManager listOutputs page from an external origin: %p', async args => {
  const { wallet, calls } = fakeWallet()
  const guarded = guardVaultAccess(wallet, ADMIN)

  await guarded.listOutputs(args as any, 'fast.brc.dev')

  expect(calls.find(c => c.method === 'listOutputs')?.args).toEqual(args)
})

test.each(['entire transactions', 'locking scripts'] as const)(
  'forwards an external listOutputs `include: %p` to the underlying wallet',
  async include => {
    const { wallet, calls } = fakeWallet()
    const guarded = guardVaultAccess(wallet, ADMIN)
    const args = { basket: 'x', include, includeTags: true, limit: 5 }

    await guarded.listOutputs(args as any, 'evil.com')

    const forwarded = calls.find(c => c.method === 'listOutputs')?.args
    expect(forwarded).toEqual(args)
    const revalidated = Validation.validateListOutputsArgs(forwarded)
    expect(revalidated.includeTransactions).toBe(include === 'entire transactions')
    expect(revalidated.includeLockingScripts).toBe(include === 'locking scripts')
  }
)

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

    await expect(guarded.createAction({ description: 'ordinary', inputs: [] } as any, 'other.com')).resolves.toEqual({
      ok: true,
      method: 'createAction'
    })
    expect(calls.some(call => call.method === 'createAction')).toBe(true)
  } finally {
    jest.useRealTimers()
  }
})

test('blocks external createAction from reserving an admin-basket output by outpoint', async () => {
  const { wallet, calls } = fakeWallet()
  const lookup = fakeLookup({ adminOutpoints: [`${TXID}.0`] })
  const guarded = guardVaultAccess(wallet, ADMIN, { lookup })
  await expect(
    guarded.createAction(
      {
        description: 'Reserve someone else output',
        inputs: [{ outpoint: `${TXID}.0`, inputDescription: 'Vault input', unlockingScriptLength: 100 }]
      } as any,
      'evil.com'
    )
  ).rejects.toBeInstanceOf(VaultAccessDenied)
  expect(calls.some(c => c.method === 'createAction')).toBe(false)
  // Only the named outpoint is looked up; history is never read.
  expect(lookup.anyAdminOutpoint).toHaveBeenCalledWith([`${TXID}.0`])
  expect(calls.some(c => c.method === 'listActions')).toBe(false)
})

test('passes an external createAction whose named inputs are not in an admin basket', async () => {
  const { wallet, calls } = fakeWallet()
  const lookup = fakeLookup({ adminOutpoints: [`${TXID}.0`] })
  const guarded = guardVaultAccess(wallet, ADMIN, { lookup })
  await expect(
    guarded.createAction(
      {
        description: 'Spend my own output',
        inputs: [{ outpoint: `${NORMAL_TXID}.1`, inputDescription: 'Input', unlockingScriptLength: 100 }]
      } as any,
      'evil.com'
    )
  ).resolves.toEqual({ ok: true, method: 'createAction' })
  expect(calls.some(c => c.method === 'createAction')).toBe(true)
})

test.each(['00', '0e0', '-0', ''])(
  'canonicalizes SDK-accepted vout spelling %p before looking up an outpoint',
  async spelling => {
    const { wallet, calls } = fakeWallet()
    const lookup = fakeLookup({ adminOutpoints: [`${TXID}.0`] })
    const guarded = guardVaultAccess(wallet, ADMIN, { lookup })
    await expect(
      guarded.createAction(
        {
          description: 'Alternate outpoint spelling',
          inputs: [
            {
              outpoint: `${TXID.toUpperCase()}.${spelling}`,
              inputDescription: 'Vault input',
              unlockingScriptLength: 100
            }
          ]
        } as any,
        'evil.com'
      )
    ).rejects.toBeInstanceOf(VaultAccessDenied)
    expect(lookup.anyAdminOutpoint).toHaveBeenCalledWith([`${TXID}.0`])
    expect(calls.some(c => c.method === 'createAction')).toBe(false)
  }
)

test('fails closed on an unparseable external input outpoint', async () => {
  const { wallet, calls } = fakeWallet()
  const lookup = fakeLookup()
  const guarded = guardVaultAccess(wallet, ADMIN, { lookup })
  await expect(
    guarded.createAction(
      {
        description: 'Bad outpoint',
        inputs: [{ outpoint: 'nope', inputDescription: 'Input', unlockingScriptLength: 1 }]
      } as any,
      'evil.com'
    )
  ).rejects.toBeInstanceOf(VaultAccessDenied)
  expect(lookup.anyAdminOutpoint).not.toHaveBeenCalled()
  expect(calls.some(c => c.method === 'createAction')).toBe(false)
})

function vaultTxBeef() {
  const tx = new Transaction()
  tx.addOutput({ satoshis: 50_000, lockingScript: LockingScript.fromHex(vaultLock()) })
  const beef = new Beef()
  beef.mergeTransaction(tx)
  return { txid: tx.id('hex'), atomic: beef.toBinaryAtomic(tx.id('hex')) }
}

test('blocks external internalizeAction from reclassifying an admin-basket output', async () => {
  const { txid, atomic } = vaultTxBeef()
  const { wallet, calls } = fakeWallet()
  const lookup = fakeLookup({ adminOutpoints: [`${txid}.0`] })
  const guarded = guardVaultAccess(wallet, ADMIN, { lookup })
  await expect(
    guarded.internalizeAction(
      {
        tx: atomic,
        description: 'Move Vault output',
        labels: [],
        // The SDK accepts numeric spellings; the guard must normalize them too.
        outputs: [{ outputIndex: '00', protocol: 'basket insertion', insertionRemittance: { basket: 'normal' } }]
      } as any,
      'evil.com'
    )
  ).rejects.toBeInstanceOf(VaultAccessDenied)
  expect(lookup.anyAdminOutpoint).toHaveBeenCalledWith([`${txid}.0`])
  expect(calls.some(c => c.method === 'internalizeAction')).toBe(false)
})

test('fails closed on an external internalizeAction whose BEEF does not parse', async () => {
  const { wallet, calls } = fakeWallet()
  const guarded = guardVaultAccess(wallet, ADMIN, { lookup: fakeLookup() })
  await expect(
    guarded.internalizeAction(
      { tx: [1, 2, 3], description: 'Garbage', outputs: [{ outputIndex: 0, protocol: 'wallet payment' }] } as any,
      'evil.com'
    )
  ).rejects.toBeInstanceOf(VaultAccessDenied)
  expect(calls.some(c => c.method === 'internalizeAction')).toBe(false)
})

test('blocks external relinquishOutput of an admin-basket output and passes an ordinary one', async () => {
  const { wallet, calls } = fakeWallet()
  const lookup = fakeLookup({ adminOutpoints: [`${TXID}.0`] })
  const guarded = guardVaultAccess(wallet, ADMIN, { lookup })
  await expect(
    guarded.relinquishOutput({ basket: 'normal', output: `${TXID}.0` } as any, 'evil.com')
  ).rejects.toBeInstanceOf(VaultAccessDenied)
  await expect(
    guarded.relinquishOutput({ basket: 'normal', output: `${NORMAL_TXID}.0` } as any, 'evil.com')
  ).resolves.toEqual({ ok: true, method: 'relinquishOutput' })
  expect(calls.filter(c => c.method === 'relinquishOutput')).toHaveLength(1)
})

// An app may hold R1C outputs of its own: the locking script is not what
// makes an output the wallet's Vault, the admin basket is.
test('lets an external app create, internalize and spend R1C outputs outside admin baskets', async () => {
  const { txid, atomic } = vaultTxBeef()
  const { wallet, calls } = fakeWallet()
  const guarded = guardVaultAccess(wallet, ADMIN, { lookup: fakeLookup() })

  await expect(
    guarded.createAction(
      {
        description: 'App R1C output',
        outputs: [{ satoshis: 1, lockingScript: ` ${vaultLock()}\n`, outputDescription: 'Lock', basket: 'normal' }]
      } as any,
      'app.example'
    )
  ).resolves.toMatchObject({ ok: true })
  await expect(
    guarded.internalizeAction(
      {
        tx: atomic,
        description: 'App R1C internalization',
        labels: [],
        outputs: [{ outputIndex: 0, protocol: 'basket insertion', insertionRemittance: { basket: 'normal' } }]
      } as any,
      'app.example'
    )
  ).resolves.toMatchObject({ ok: true })
  await expect(
    guarded.createAction(
      {
        description: 'Spend app R1C output',
        inputs: [{ outpoint: `${txid}.0`, inputDescription: 'Input', unlockingScriptLength: 100 }]
      } as any,
      'app.example'
    )
  ).resolves.toMatchObject({ ok: true })
  expect(calls.filter(c => c.method === 'createAction')).toHaveLength(2)
  expect(calls.filter(c => c.method === 'internalizeAction')).toHaveLength(1)
})

test('does not inspect signAction or abortAction references', async () => {
  const { wallet, calls } = fakeWallet()
  const lookup = fakeLookup({ adminTxids: [TXID] })
  const guarded = guardVaultAccess(wallet, ADMIN, { lookup })
  await expect(guarded.signAction({ reference: 'vault-ref', spends: {} } as any, 'evil.com')).resolves.toMatchObject({
    ok: true
  })
  await expect(guarded.abortAction({ reference: 'vault-ref' } as any, 'evil.com')).resolves.toMatchObject({ ok: true })
  expect(lookup.anyAdminOutpoint).not.toHaveBeenCalled()
  expect(lookup.anyAdminTransaction).not.toHaveBeenCalled()
  expect(calls.some(c => c.method === 'listActions')).toBe(false)
})

test.each(['createAction', 'signAction'] as const)(
  'blocks external %s from releasing a held Vault transaction through sendWith',
  async method => {
    const { wallet, calls } = fakeWallet()
    const lookup = fakeLookup({ adminTxids: [TXID] })
    const guarded = guardVaultAccess(wallet, ADMIN, { lookup })
    const args =
      method === 'createAction'
        ? { description: 'Release held transaction', options: { sendWith: [NORMAL_TXID, TXID.toUpperCase()] } }
        : { reference: 'ordinary-ref', spends: {}, options: { sendWith: [TXID.toUpperCase()] } }

    await expect((guarded as any)[method](args, 'evil.com')).rejects.toBeInstanceOf(VaultAccessDenied)
    expect(lookup.anyAdminTransaction).toHaveBeenCalledWith(method === 'createAction' ? [NORMAL_TXID, TXID] : [TXID])
    expect(calls.some(c => c.method === method)).toBe(false)
  }
)

test.each(['createAction', 'signAction'] as const)(
  'passes external %s sendWith of ordinary transactions',
  async method => {
    const { wallet, calls } = fakeWallet()
    const guarded = guardVaultAccess(wallet, ADMIN, { lookup: fakeLookup({ adminTxids: [TXID] }) })
    const args =
      method === 'createAction'
        ? { description: 'Batch', options: { sendWith: [NORMAL_TXID] } }
        : { reference: 'ordinary-ref', spends: {}, options: { sendWith: [NORMAL_TXID] } }
    await expect((guarded as any)[method](args, 'app.example')).resolves.toMatchObject({ ok: true })
    expect(calls.some(c => c.method === method)).toBe(true)
  }
)

test.each(['createAction', 'signAction'] as const)(
  'fails closed on malformed external %s sendWith capabilities',
  async method => {
    const { wallet, calls } = fakeWallet([action()])
    const guarded = guardVaultAccess(wallet, ADMIN, { lookup: fakeLookup() })
    const args =
      method === 'createAction'
        ? { description: 'Malformed sendWith', options: { sendWith: 'ab'.repeat(32) } }
        : { reference: 'ordinary-ref', spends: {}, options: { sendWith: [123] } }

    await expect((guarded as any)[method](args, 'evil.com')).rejects.toBeInstanceOf(VaultAccessDenied)
    expect(calls.some(c => c.method === method)).toBe(false)
  }
)

test('refuses an external call that needs a lookup when none is configured, or when it fails', async () => {
  const unconfigured = fakeWallet()
  const bare = guardVaultAccess(unconfigured.wallet, ADMIN)
  await expect(
    bare.relinquishOutput({ basket: 'normal', output: `${NORMAL_TXID}.0` } as any, 'evil.com')
  ).rejects.toBeInstanceOf(VaultAccessDenied)
  await expect(
    bare.createAction({ description: 'Batch', options: { sendWith: [NORMAL_TXID] } } as any, 'evil.com')
  ).rejects.toBeInstanceOf(VaultAccessDenied)
  // Nothing named: no lookup needed.
  await expect(bare.createAction({ description: 'Plain', inputs: [] } as any, 'evil.com')).resolves.toMatchObject({
    ok: true
  })

  const failing = fakeWallet()
  const broken = guardVaultAccess(failing.wallet, ADMIN, {
    lookup: {
      anyAdminOutpoint: async () => {
        throw new Error('database is locked')
      },
      anyAdminTransaction: async () => false
    }
  })
  await expect(
    broken.relinquishOutput({ basket: 'normal', output: `${NORMAL_TXID}.0` } as any, 'evil.com')
  ).rejects.toBeInstanceOf(VaultAccessDenied)
  expect(failing.calls.some(c => c.method === 'relinquishOutput')).toBe(false)
})

test('admin output-naming calls pass straight through without a lookup or a shared queue', async () => {
  const { wallet, calls } = fakeWallet()
  const lookup = fakeLookup({ adminOutpoints: [`${TXID}.0`], adminTxids: [TXID] })
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  wallet.createAction = jest.fn(async (args: any, originator?: string) => {
    calls.push({ method: 'createAction', args, originator })
    if (args.description === 'slow admin') await gate
    return { ok: true }
  })
  const guarded = guardVaultAccess(wallet, ADMIN, { lookup })

  const slow = guarded.createAction(
    {
      description: 'slow admin',
      inputs: [{ outpoint: `${TXID}.0`, inputDescription: 'Vault input', unlockingScriptLength: 100 }]
    } as any,
    ADMIN
  )
  // A second call, external, is not held behind the admin one.
  await expect(guarded.createAction({ description: 'external', inputs: [] } as any, 'app.example')).resolves.toEqual({
    ok: true
  })
  release()
  await expect(slow).resolves.toEqual({ ok: true })
  await expect(
    guarded.createAction({ description: 'admin send', options: { sendWith: [TXID] } } as any, ADMIN)
  ).resolves.toEqual({ ok: true })
  expect(lookup.anyAdminOutpoint).not.toHaveBeenCalled()
  expect(lookup.anyAdminTransaction).not.toHaveBeenCalled()
})

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
