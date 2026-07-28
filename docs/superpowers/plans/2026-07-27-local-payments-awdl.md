# Local Payments over AWDL — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship iOS↔iOS nearby BSV payments over Apple peer-to-peer Wi-Fi (AWDL), with a single-static-QR fallback that keeps Android working.

**Architecture:** A payee mints a session (random `sessionId` + 32-byte PSK) and renders it as a small QR. On iOS↔iOS the payer discovers the payee's Bonjour service `_bsvpay._tcp` over AWDL and connects with TLS pre-shared-key auth derived from the QR; the payment frame crosses a TCP stream and is acknowledged. When either device is not iOS, the payer instead renders the signed transaction as a second static QR. Both paths converge on the same persist-then-internalize queue.

**Tech Stack:** React Native 0.83.6, Expo SDK 55, New Architecture, Nitro modules (`react-native-nitro-modules@^0.35.x`), Swift + `Network.framework` + `Security.framework`, `@bsv/sdk`, `@bsv/wallet-toolbox-mobile`, `expo-camera`, `react-native-qrcode-svg`, Jest (`jest-expo`).

**Design doc:** `docs/superpowers/specs/2026-07-27-local-payments-awdl-design.md`
**Branch:** `feat/local-payments-awdl`

## Global Constraints

- **Never link CoreBluetooth.** Not directly, not transitively, not via any new dependency. It is incompatible with `com.apple.developer.web-browser` — see `memory/project_web_browser_entitlement.md`. Any dependency added by this plan must be checked with `otool -L` before a build is delivered.
- **Never add any of these Info.plist keys:** `NSPhotoLibraryUsageDescription`, `NSLocationAlwaysUsageDescription`, `NSLocationAlwaysAndWhenInUseUsageDescription`, `NSHomeKitUsageDescription`, `NSBluetoothAlwaysUsageDescription`, `NSHealthShareUsageDescription`, `NSHealthUpdateUsageDescription`.
- **Nitro must stay on `^0.35.x`.** 0.36.x targets RN 0.85 and mismatches shipped codegen. Current: `react-native-nitro-modules@^0.35.2`.
- **Native modules follow the existing Nitro pattern** in `packages/react-native-secp-native` — `nitro.json`, `src/specs/<Name>.nitro.ts`, `src/index.ts` with a lazy never-throwing getter, `ios/Hybrid<Name>.swift`, `<Name>.podspec`, wired as `file:./packages/<name>`.
- **Bonjour service type:** `_bsvpay._tcp`
- **PeerPay protocol ID:** `[2, '3241645161d8']` — payload shape must stay `internalizeAction`-compatible.
- **No `UIBackgroundModes`.** Foreground only.
- **Android has no AWDL.** Every AWDL code path must be unreachable on Android, and the QR path must work on both.
- Tests live in `__tests__/`, preset `jest-expo`, run with `npm test`.

---

### Task 1: Payload codec

Pure TypeScript, no native, no React. The binary wire format for both transports.

**Files:**
- Create: `utils/localpay/codec.ts`
- Test: `__tests__/localpayCodec.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `encodeFrame(f: PaymentFrame): Uint8Array`
  - `decodeFrame(b: Uint8Array): PaymentFrame`
  - `interface PaymentFrame { version: number; senderIdentityKey: string; amount: number; outputIndex: number; derivationPrefix: string; derivationSuffix: string; transaction: Uint8Array }`
  - `class CodecError extends Error`
  - `FRAME_VERSION = 1`

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/localpayCodec.test.ts
import { encodeFrame, decodeFrame, CodecError, FRAME_VERSION, type PaymentFrame } from '@/utils/localpay/codec'

const sample = (): PaymentFrame => ({
  version: FRAME_VERSION,
  senderIdentityKey: '02'.padEnd(66, 'a'),
  amount: 1234,
  outputIndex: 0,
  derivationPrefix: 'cHJlZml4',
  derivationSuffix: 'c3VmZml4',
  transaction: new Uint8Array([1, 2, 3, 4, 5]),
})

describe('localpay codec', () => {
  it('round-trips a frame', () => {
    const f = sample()
    expect(decodeFrame(encodeFrame(f))).toEqual(f)
  })

  it('round-trips a large transaction', () => {
    const f = { ...sample(), transaction: new Uint8Array(50_000).fill(7) }
    expect(decodeFrame(encodeFrame(f)).transaction.length).toBe(50_000)
  })

  it('round-trips amounts above 32 bits', () => {
    const f = { ...sample(), amount: 2 ** 40 }
    expect(decodeFrame(encodeFrame(f)).amount).toBe(2 ** 40)
  })

  it('rejects truncated input', () => {
    const b = encodeFrame(sample())
    expect(() => decodeFrame(b.slice(0, b.length - 3))).toThrow(CodecError)
  })

  it('rejects an unknown version', () => {
    const b = encodeFrame(sample())
    b[0] = 99
    expect(() => decodeFrame(b)).toThrow(CodecError)
  })

  it('rejects trailing garbage', () => {
    const b = encodeFrame(sample())
    expect(() => decodeFrame(new Uint8Array([...b, 0, 0]))).toThrow(CodecError)
  })

  it('rejects a wrong-length identity key', () => {
    expect(() => encodeFrame({ ...sample(), senderIdentityKey: 'abcd' })).toThrow(CodecError)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- localpayCodec`
Expected: FAIL — cannot resolve `@/utils/localpay/codec`

- [ ] **Step 3: Write the implementation**

```ts
// utils/localpay/codec.ts
export const FRAME_VERSION = 1

export class CodecError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodecError'
  }
}

export interface PaymentFrame {
  version: number
  /** 66-char hex, compressed pubkey */
  senderIdentityKey: string
  amount: number
  outputIndex: number
  derivationPrefix: string
  derivationSuffix: string
  /** AtomicBEEF (AWDL path) or rawtx (QR path) */
  transaction: Uint8Array
}

// ── varint (LEB128, unsigned) ──

function putVarint(out: number[], n: number): void {
  if (!Number.isSafeInteger(n) || n < 0) throw new CodecError(`varint out of range: ${n}`)
  let v = n
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80)
    v = Math.floor(v / 128)
  }
  out.push(v)
}

function getVarint(b: Uint8Array, pos: { i: number }): number {
  let result = 0
  let shift = 1
  for (;;) {
    if (pos.i >= b.length) throw new CodecError('truncated varint')
    const byte = b[pos.i++]
    result += (byte & 0x7f) * shift
    if ((byte & 0x80) === 0) break
    shift *= 128
    if (shift > 2 ** 53) throw new CodecError('varint too large')
  }
  return result
}

function putBytes(out: number[], bytes: Uint8Array): void {
  putVarint(out, bytes.length)
  for (const byte of bytes) out.push(byte)
}

function getBytes(b: Uint8Array, pos: { i: number }): Uint8Array {
  const len = getVarint(b, pos)
  if (pos.i + len > b.length) throw new CodecError('truncated byte field')
  const slice = b.slice(pos.i, pos.i + len)
  pos.i += len
  return slice
}

const enc = new TextEncoder()
const dec = new TextDecoder()

function putStr(out: number[], s: string): void {
  putBytes(out, enc.encode(s))
}

function getStr(b: Uint8Array, pos: { i: number }): string {
  return dec.decode(getBytes(b, pos))
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new CodecError('odd-length hex')
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    if (Number.isNaN(byte)) throw new CodecError('invalid hex')
    out[i] = byte
  }
  return out
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
}

// ── frame ──

export function encodeFrame(f: PaymentFrame): Uint8Array {
  if (f.senderIdentityKey.length !== 66) {
    throw new CodecError(`senderIdentityKey must be 66 hex chars, got ${f.senderIdentityKey.length}`)
  }
  const out: number[] = [f.version & 0xff]
  for (const byte of hexToBytes(f.senderIdentityKey)) out.push(byte)
  putVarint(out, f.amount)
  putVarint(out, f.outputIndex)
  putStr(out, f.derivationPrefix)
  putStr(out, f.derivationSuffix)
  putBytes(out, f.transaction)
  return new Uint8Array(out)
}

export function decodeFrame(b: Uint8Array): PaymentFrame {
  if (b.length < 34) throw new CodecError('frame too short')
  const version = b[0]
  if (version !== FRAME_VERSION) throw new CodecError(`unsupported frame version ${version}`)
  const pos = { i: 1 }
  const senderIdentityKey = bytesToHex(b.slice(pos.i, pos.i + 33))
  pos.i += 33
  const amount = getVarint(b, pos)
  const outputIndex = getVarint(b, pos)
  const derivationPrefix = getStr(b, pos)
  const derivationSuffix = getStr(b, pos)
  const transaction = getBytes(b, pos)
  if (pos.i !== b.length) throw new CodecError('trailing bytes after frame')
  return { version, senderIdentityKey, amount, outputIndex, derivationPrefix, derivationSuffix, transaction }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- localpayCodec`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add utils/localpay/codec.ts __tests__/localpayCodec.test.ts
git commit -m "feat(localpay): binary payment frame codec"
```

---

### Task 2: Session mint and QR bootstrap

**Files:**
- Create: `utils/localpay/session.ts`
- Test: `__tests__/localpaySession.test.ts`

**Interfaces:**
- Consumes: `CodecError` from `utils/localpay/codec.ts`
- Produces:
  - `interface Session { version: number; caps: number; sessionId: Uint8Array; psk: Uint8Array; identityKey: string; amount: number; derivationPrefix: string; derivationSuffix: string }`
  - `mintSession(args: { identityKey: string; amount: number; derivationPrefix: string; derivationSuffix: string; supportsAwdl: boolean }): Session`
  - `encodeSession(s: Session): string` — base64url for the QR
  - `decodeSession(text: string): Session`
  - `instanceName(sessionId: Uint8Array): string` — Bonjour label
  - `CAP_AWDL = 0x01`
  - `SESSION_VERSION = 1`

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/localpaySession.test.ts
import {
  mintSession, encodeSession, decodeSession, instanceName, CAP_AWDL, SESSION_VERSION,
} from '@/utils/localpay/session'
import { CodecError } from '@/utils/localpay/codec'

const args = {
  identityKey: '02'.padEnd(66, 'b'),
  amount: 5000,
  derivationPrefix: 'cHJlZml4',
  derivationSuffix: 'c3VmZml4',
  supportsAwdl: true,
}

describe('localpay session', () => {
  it('mints 16-byte sessionId and 32-byte psk', () => {
    const s = mintSession(args)
    expect(s.sessionId.length).toBe(16)
    expect(s.psk.length).toBe(32)
    expect(s.version).toBe(SESSION_VERSION)
  })

  it('sets the AWDL capability bit', () => {
    expect(mintSession(args).caps & CAP_AWDL).toBe(CAP_AWDL)
    expect(mintSession({ ...args, supportsAwdl: false }).caps & CAP_AWDL).toBe(0)
  })

  it('mints distinct sessions', () => {
    const a = mintSession(args)
    const b = mintSession(args)
    expect(Buffer.from(a.sessionId)).not.toEqual(Buffer.from(b.sessionId))
    expect(Buffer.from(a.psk)).not.toEqual(Buffer.from(b.psk))
  })

  it('round-trips through the QR encoding', () => {
    const s = mintSession(args)
    expect(decodeSession(encodeSession(s))).toEqual(s)
  })

  it('stays small enough for one static QR', () => {
    expect(encodeSession(mintSession(args)).length).toBeLessThan(300)
  })

  it('rejects malformed QR text', () => {
    expect(() => decodeSession('not-a-session')).toThrow(CodecError)
  })

  it('derives a DNS-SD-safe instance name', () => {
    const n = instanceName(mintSession(args).sessionId)
    expect(n).toMatch(/^bsvpay-[a-z2-7]{26}$/)
    expect(n.length).toBeLessThanOrEqual(63)
  })

  it('derives the same instance name on both sides', () => {
    const s = mintSession(args)
    expect(instanceName(decodeSession(encodeSession(s)).sessionId)).toBe(instanceName(s.sessionId))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- localpaySession`
Expected: FAIL — cannot resolve `@/utils/localpay/session`

- [ ] **Step 3: Write the implementation**

Randomness comes from `@bsv/sdk`'s `Random`, already a dependency and already used for wallet key material.

```ts
// utils/localpay/session.ts
import { Random } from '@bsv/sdk'
import { CodecError } from './codec'

export const SESSION_VERSION = 1
export const CAP_AWDL = 0x01

export interface Session {
  version: number
  caps: number
  sessionId: Uint8Array
  psk: Uint8Array
  identityKey: string
  amount: number
  derivationPrefix: string
  derivationSuffix: string
}

export function mintSession(args: {
  identityKey: string
  amount: number
  derivationPrefix: string
  derivationSuffix: string
  supportsAwdl: boolean
}): Session {
  if (args.identityKey.length !== 66) throw new CodecError('identityKey must be 66 hex chars')
  return {
    version: SESSION_VERSION,
    caps: args.supportsAwdl ? CAP_AWDL : 0,
    sessionId: new Uint8Array(Random(16)),
    psk: new Uint8Array(Random(32)),
    identityKey: args.identityKey,
    amount: args.amount,
    derivationPrefix: args.derivationPrefix,
    derivationSuffix: args.derivationSuffix,
  }
}

// Base64url, no padding — QR alphanumeric-safe and dependency-free.
function toB64url(b: Uint8Array): string {
  let s = ''
  for (const byte of b) s += String.fromCharCode(byte)
  return globalThis.btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64url(s: string): Uint8Array {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = globalThis.atob(pad + '='.repeat((4 - (pad.length % 4)) % 4))
  return Uint8Array.from(bin, c => c.charCodeAt(0))
}

export function encodeSession(s: Session): string {
  const body = JSON.stringify({
    v: s.version,
    c: s.caps,
    s: toB64url(s.sessionId),
    k: toB64url(s.psk),
    i: s.identityKey,
    a: s.amount,
    p: s.derivationPrefix,
    x: s.derivationSuffix,
  })
  return 'bsvpay1:' + toB64url(new TextEncoder().encode(body))
}

export function decodeSession(text: string): Session {
  if (!text.startsWith('bsvpay1:')) throw new CodecError('not a bsvpay session QR')
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(new TextDecoder().decode(fromB64url(text.slice('bsvpay1:'.length))))
  } catch {
    throw new CodecError('malformed session payload')
  }
  const { v, c, s, k, i, a, p, x } = parsed as Record<string, never>
  if (v !== SESSION_VERSION) throw new CodecError(`unsupported session version ${String(v)}`)
  if (typeof i !== 'string' || (i as string).length !== 66) throw new CodecError('bad identityKey')
  if (typeof a !== 'number') throw new CodecError('bad amount')
  const sessionId = fromB64url(s as string)
  const psk = fromB64url(k as string)
  if (sessionId.length !== 16) throw new CodecError('bad sessionId length')
  if (psk.length !== 32) throw new CodecError('bad psk length')
  return {
    version: v as number,
    caps: (c as number) ?? 0,
    sessionId,
    psk,
    identityKey: i as string,
    amount: a as number,
    derivationPrefix: p as string,
    derivationSuffix: x as string,
  }
}

// RFC 4648 base32, lowercase, no padding. 16 bytes → 26 chars.
const B32 = 'abcdefghijklmnopqrstuvwxyz234567'

export function instanceName(sessionId: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of sessionId) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return `bsvpay-${out}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- localpaySession`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add utils/localpay/session.ts __tests__/localpaySession.test.ts
git commit -m "feat(localpay): session mint and QR bootstrap encoding"
```

---

### Task 3: Pending-payment queue

Port of `utils/ble/pendingPayments.ts` from `5fc72a7` — transport-agnostic, duck-typed on storage. Read the original first: `git show 5fc72a7:utils/ble/pendingPayments.ts`.

Changes from the original: storage key `ble_pending_payments` → `localpay_pending`; `BLEPaymentPayload` → `PaymentFrame`; constants inlined rather than imported from the deleted `utils/ble/constants.ts`.

**Files:**
- Create: `utils/localpay/pending.ts`
- Test: `__tests__/localpayPending.test.ts`

**Interfaces:**
- Consumes: `PaymentFrame` from `utils/localpay/codec.ts`
- Produces:
  - `type PendingStatus = 'pending' | 'processing' | 'completed' | 'failed'`
  - `interface PendingPayment { id: string; receivedAt: string; frame: PaymentFrame; status: PendingStatus; failureReason?: string; lastAttemptAt?: string }`
  - `interface KVStorage { getKeyValue(k: string): Promise<string | undefined>; setKeyValue(k: string, v: string): Promise<void> }`
  - `savePending(storage, frame): Promise<PendingPayment>`
  - `getPending(storage): Promise<PendingPayment[]>`
  - `getUnprocessed(storage): Promise<PendingPayment[]>`
  - `updateStatus(storage, id, status, failureReason?): Promise<void>`
  - `processPending(wallet, storage, originator): Promise<{ id: string; success: boolean; error?: string }[]>`
  - `markSessionSpent(storage, sessionId: Uint8Array): Promise<void>`
  - `isSessionSpent(storage, sessionId: Uint8Array): Promise<boolean>`
  - `PENDING_KEY = 'localpay_pending'`
  - `SPENT_KEY = 'localpay_spent_sessions'`

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/localpayPending.test.ts
import {
  savePending, getPending, getUnprocessed, updateStatus, processPending, PENDING_KEY,
} from '@/utils/localpay/pending'
import { FRAME_VERSION, type PaymentFrame } from '@/utils/localpay/codec'

function fakeStorage() {
  const map = new Map<string, string>()
  return {
    map,
    getKeyValue: async (k: string) => map.get(k),
    setKeyValue: async (k: string, v: string) => void map.set(k, v),
  }
}

const frame = (): PaymentFrame => ({
  version: FRAME_VERSION,
  senderIdentityKey: '02'.padEnd(66, 'c'),
  amount: 42,
  outputIndex: 0,
  derivationPrefix: 'cHJlZml4',
  derivationSuffix: 'c3VmZml4',
  transaction: new Uint8Array([9, 9, 9]),
})

describe('localpay pending queue', () => {
  it('persists under the localpay key', async () => {
    const s = fakeStorage()
    await savePending(s, frame())
    expect(s.map.has(PENDING_KEY)).toBe(true)
  })

  it('returns saved entries as pending', async () => {
    const s = fakeStorage()
    await savePending(s, frame())
    const all = await getPending(s)
    expect(all).toHaveLength(1)
    expect(all[0].status).toBe('pending')
    expect(all[0].frame.amount).toBe(42)
  })

  it('treats corrupt storage as empty rather than throwing', async () => {
    const s = fakeStorage()
    s.map.set(PENDING_KEY, 'not json')
    await expect(getPending(s)).resolves.toEqual([])
  })

  it('excludes completed entries from unprocessed', async () => {
    const s = fakeStorage()
    const p = await savePending(s, frame())
    await updateStatus(s, p.id, 'completed')
    expect(await getUnprocessed(s)).toHaveLength(0)
  })

  it('re-offers a processing entry after a crash', async () => {
    const s = fakeStorage()
    const p = await savePending(s, frame())
    await updateStatus(s, p.id, 'processing')
    expect(await getUnprocessed(s)).toHaveLength(1)
  })

  it('records a failure reason', async () => {
    const s = fakeStorage()
    const p = await savePending(s, frame())
    await updateStatus(s, p.id, 'failed', 'no network')
    expect((await getPending(s))[0].failureReason).toBe('no network')
  })

  it('marks completed when internalizeAction succeeds', async () => {
    const s = fakeStorage()
    await savePending(s, frame())
    const wallet = { internalizeAction: jest.fn().mockResolvedValue({ accepted: true }) }
    const results = await processPending(wallet as never, s, 'admin.com')
    expect(results).toEqual([expect.objectContaining({ success: true })])
    expect((await getPending(s))[0].status).toBe('completed')
  })

  it('marks failed and keeps the entry when internalizeAction throws', async () => {
    const s = fakeStorage()
    await savePending(s, frame())
    const wallet = { internalizeAction: jest.fn().mockRejectedValue(new Error('offline')) }
    const results = await processPending(wallet as never, s, 'admin.com')
    expect(results).toEqual([expect.objectContaining({ success: false, error: 'offline' })])
    const all = await getPending(s)
    expect(all[0].status).toBe('failed')
    expect(all).toHaveLength(1)
  })
})

describe('spent session guard', () => {
  const sid = () => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])

  it('reports an unseen session as unspent', async () => {
    await expect(isSessionSpent(fakeStorage(), sid())).resolves.toBe(false)
  })

  it('reports a marked session as spent', async () => {
    const s = fakeStorage()
    await markSessionSpent(s, sid())
    await expect(isSessionSpent(s, sid())).resolves.toBe(true)
  })

  it('distinguishes different sessions', async () => {
    const s = fakeStorage()
    await markSessionSpent(s, sid())
    const other = new Uint8Array(16).fill(9)
    await expect(isSessionSpent(s, other)).resolves.toBe(false)
  })

  it('is idempotent', async () => {
    const s = fakeStorage()
    await markSessionSpent(s, sid())
    await markSessionSpent(s, sid())
    expect(JSON.parse(s.map.get(SPENT_KEY)!)).toHaveLength(1)
  })

  it('treats corrupt storage as no sessions spent', async () => {
    const s = fakeStorage()
    s.map.set(SPENT_KEY, 'not json')
    await expect(isSessionSpent(s, sid())).resolves.toBe(false)
  })
})
```

Import line for the test file becomes:

```ts
import {
  savePending, getPending, getUnprocessed, updateStatus, processPending,
  markSessionSpent, isSessionSpent, PENDING_KEY, SPENT_KEY,
} from '@/utils/localpay/pending'
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- localpayPending`
Expected: FAIL — cannot resolve `@/utils/localpay/pending`

- [ ] **Step 3: Write the implementation**

```ts
// utils/localpay/pending.ts
import type { PaymentFrame } from './codec'

export const PENDING_KEY = 'localpay_pending'
export const PEERPAY_PROTOCOL_ID: [number, string] = [2, '3241645161d8']
export const PEERPAY_LABEL = 'localpay'
export const PEERPAY_DESCRIPTION = 'Payment received from a nearby device'

export type PendingStatus = 'pending' | 'processing' | 'completed' | 'failed'

export interface PendingPayment {
  id: string
  receivedAt: string
  frame: PaymentFrame
  status: PendingStatus
  failureReason?: string
  lastAttemptAt?: string
}

export interface KVStorage {
  getKeyValue(k: string): Promise<string | undefined>
  setKeyValue(k: string, v: string): Promise<void>
}

interface Serialised extends Omit<PendingPayment, 'frame'> {
  frame: Omit<PaymentFrame, 'transaction'> & { transaction: number[] }
}

function toWire(p: PendingPayment): Serialised {
  return { ...p, frame: { ...p.frame, transaction: Array.from(p.frame.transaction) } }
}

function fromWire(s: Serialised): PendingPayment {
  return { ...s, frame: { ...s.frame, transaction: new Uint8Array(s.frame.transaction) } }
}

async function readAll(storage: KVStorage): Promise<PendingPayment[]> {
  try {
    const raw = await storage.getKeyValue(PENDING_KEY)
    if (!raw) return []
    return (JSON.parse(raw) as Serialised[]).map(fromWire)
  } catch {
    return []
  }
}

async function writeAll(storage: KVStorage, list: PendingPayment[]): Promise<void> {
  await storage.setKeyValue(PENDING_KEY, JSON.stringify(list.map(toWire)))
}

export async function savePending(storage: KVStorage, frame: PaymentFrame): Promise<PendingPayment> {
  const entry: PendingPayment = {
    id: `${Date.now()}_${frame.senderIdentityKey.slice(0, 8)}`,
    receivedAt: new Date().toISOString(),
    frame,
    status: 'pending',
  }
  await writeAll(storage, [...(await readAll(storage)), entry])
  return entry
}

export async function getPending(storage: KVStorage): Promise<PendingPayment[]> {
  return readAll(storage)
}

/** `processing` is included: a crash mid-flight must not strand a payment. */
export async function getUnprocessed(storage: KVStorage): Promise<PendingPayment[]> {
  return (await readAll(storage)).filter(p => p.status !== 'completed')
}

export async function updateStatus(
  storage: KVStorage,
  id: string,
  status: PendingStatus,
  failureReason?: string
): Promise<void> {
  const all = await readAll(storage)
  const next = all.map(p =>
    p.id === id ? { ...p, status, failureReason, lastAttemptAt: new Date().toISOString() } : p
  )
  await writeAll(storage, next)
}

interface InternalizingWallet {
  internalizeAction(args: unknown, originator?: string): Promise<unknown>
}

export async function processPending(
  wallet: InternalizingWallet,
  storage: KVStorage,
  originator: string
): Promise<{ id: string; success: boolean; error?: string }[]> {
  const results: { id: string; success: boolean; error?: string }[] = []
  for (const p of await getUnprocessed(storage)) {
    await updateStatus(storage, p.id, 'processing')
    try {
      await wallet.internalizeAction(
        {
          tx: Array.from(p.frame.transaction),
          outputs: [
            {
              outputIndex: p.frame.outputIndex,
              protocol: 'wallet payment',
              paymentRemittance: {
                derivationPrefix: p.frame.derivationPrefix,
                derivationSuffix: p.frame.derivationSuffix,
                senderIdentityKey: p.frame.senderIdentityKey,
              },
            },
          ],
          description: PEERPAY_DESCRIPTION,
          labels: [PEERPAY_LABEL],
        },
        originator
      )
      await updateStatus(storage, p.id, 'completed')
      results.push({ id: p.id, success: true })
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      await updateStatus(storage, p.id, 'failed', error)
      results.push({ id: p.id, success: false, error })
    }
  }
  return results
}
```

Then append the spent-session guard. A payee must refuse a session it has already settled, so a re-scanned QR cannot double-credit.

```ts
// utils/localpay/pending.ts — append

export const SPENT_KEY = 'localpay_spent_sessions'

function sessionKey(sessionId: Uint8Array): string {
  return Array.from(sessionId, b => b.toString(16).padStart(2, '0')).join('')
}

async function readSpent(storage: KVStorage): Promise<string[]> {
  try {
    const raw = await storage.getKeyValue(SPENT_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as string[]) : []
  } catch {
    return []
  }
}

export async function markSessionSpent(storage: KVStorage, sessionId: Uint8Array): Promise<void> {
  const key = sessionKey(sessionId)
  const spent = await readSpent(storage)
  if (spent.includes(key)) return
  await storage.setKeyValue(SPENT_KEY, JSON.stringify([...spent, key]))
}

export async function isSessionSpent(storage: KVStorage, sessionId: Uint8Array): Promise<boolean> {
  return (await readSpent(storage)).includes(sessionKey(sessionId))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- localpayPending`
Expected: PASS, 13 tests

- [ ] **Step 5: Commit**

```bash
git add utils/localpay/pending.ts __tests__/localpayPending.test.ts
git commit -m "feat(localpay): transport-agnostic pending payment queue"
```

---

### Task 4: Nitro transport module scaffold

Creates the package and proves it builds and autolinks. No networking behaviour yet — the Swift class returns a fixed capability answer. This task exists separately because a Nitro codegen or pod-integration failure must surface before any AWDL logic is written on top of it.

Mirror `packages/react-native-secp-native` throughout. Read it first.

**Files:**
- Create: `packages/react-native-localpay-transport/package.json`
- Create: `packages/react-native-localpay-transport/nitro.json`
- Create: `packages/react-native-localpay-transport/LocalPayTransport.podspec`
- Create: `packages/react-native-localpay-transport/src/specs/LocalPayTransport.nitro.ts`
- Create: `packages/react-native-localpay-transport/src/index.ts`
- Create: `packages/react-native-localpay-transport/ios/HybridLocalPayTransport.swift`
- Modify: `package.json` — add `"react-native-localpay-transport": "file:./packages/react-native-localpay-transport"`

**Interfaces:**
- Consumes: nothing
- Produces: `getLocalPayTransport(): LocalPayTransport | null` from `react-native-localpay-transport`, and the Nitro spec type `LocalPayTransport` with `isSupported(): boolean` (extended in Task 5)

- [ ] **Step 1: Write the Nitro spec**

```ts
// packages/react-native-localpay-transport/src/specs/LocalPayTransport.nitro.ts
import type { HybridObject } from 'react-native-nitro-modules'

export interface LocalPayTransport extends HybridObject<{ ios: 'swift' }> {
  /** True when AWDL peer-to-peer networking is usable on this device. */
  isSupported(): boolean
}
```

- [ ] **Step 2: Write package.json, nitro.json and the podspec**

```json
// packages/react-native-localpay-transport/package.json
{
  "name": "react-native-localpay-transport",
  "version": "0.1.0",
  "private": true,
  "description": "Nitro module exposing Network.framework AWDL peer-to-peer TCP with TLS-PSK for BSV Browser local payments. iOS only.",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "files": ["src", "ios", "nitrogen/generated", "nitro.json", "LocalPayTransport.podspec"],
  "peerDependencies": {
    "react-native": "*",
    "react-native-nitro-modules": "*"
  }
}
```

```json
// packages/react-native-localpay-transport/nitro.json
{
  "cxxNamespace": ["localpaytransport"],
  "ios": { "iosModuleName": "LocalPayTransport" },
  "android": {
    "androidNamespace": ["localpaytransport"],
    "androidCxxLibName": "LocalPayTransport"
  },
  "autolinking": {
    "LocalPayTransport": {
      "ios": { "language": "swift", "implementationClassName": "HybridLocalPayTransport" }
    }
  }
}
```

```ruby
# packages/react-native-localpay-transport/LocalPayTransport.podspec
require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name         = 'LocalPayTransport'
  s.version      = package['version']
  s.summary      = package['description']
  s.homepage     = 'https://github.com/Calgooon/bsv-browser'
  s.license      = 'Open BSV'
  s.authors      = 'BSV Browser'
  s.platforms    = { ios: '15.1' }
  s.source       = { git: '.', tag: s.version.to_s }
  s.source_files = ['ios/HybridLocalPayTransport.swift', 'ios/AwdlSession.swift']
  s.frameworks   = 'Network', 'Security'

  # `load`, not `require`: every Nitro package's autolinking.rb defines a method
  # named `add_nitrogen_files`, and this repo has three of them. `load` re-executes
  # the file so the definition in scope is this package's, immediately before the call.
  load File.join(__dir__, 'nitrogen', 'generated', 'ios', 'LocalPayTransport+autolinking.rb')
  add_nitrogen_files(s)

  # Supplies the New Architecture C++ interop build settings the Swift<->C++ bridge
  # needs. Listing React-jsi / React-callinvoker / NitroModules by hand instead does
  # NOT configure interop, and the generated bridge fails to compile.
  install_modules_dependencies(s)
end
```

**Codegen tool — read this carefully.** The binary is `nitrogen`, a devDependency of this repo (`nitrogen@^0.35.2`, installed 0.35.10, present at `node_modules/.bin/nitrogen`). Do **not** run `npx nitro-codegen`: that name resolves to an unrelated abandoned package at 0.29.4, and generating with it against the 0.35.10 runtime produces a bridge that fails to compile with `'bridge' is not a member type of enum '__ObjC.margelo.nitro.<ns>'`.

- [ ] **Step 3: Write the lazy TS getter**

Mirrors `getSecpNative()` — must never throw on web, Jest or Expo Go.

```ts
// packages/react-native-localpay-transport/src/index.ts
import type { LocalPayTransport } from './specs/LocalPayTransport.nitro'

export type { LocalPayTransport }

let cached: LocalPayTransport | null | undefined

/**
 * Returns the LocalPayTransport hybrid object, or null when the native module
 * is unavailable (Android, web, jest, Expo Go, or any build without the pod).
 * Never throws.
 */
export function getLocalPayTransport(): LocalPayTransport | null {
  if (cached !== undefined) return cached
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nitro = require('react-native-nitro-modules') as typeof import('react-native-nitro-modules')
    cached = nitro.NitroModules.createHybridObject<LocalPayTransport>('LocalPayTransport')
  } catch {
    cached = null
  }
  return cached ?? null
}
```

- [ ] **Step 4: Write the minimal Swift implementation**

```swift
// packages/react-native-localpay-transport/ios/HybridLocalPayTransport.swift
import Foundation
import Network

final class HybridLocalPayTransport: HybridLocalPayTransportSpec {
  func isSupported() throws -> Bool {
    if #available(iOS 15.0, *) { return true }
    return false
  }
}
```

- [ ] **Step 5: Wire the package into the app and generate Nitro code**

```bash
cd /Users/personal/git/ts/bsv-browser
npm pkg set dependencies.react-native-localpay-transport="file:./packages/react-native-localpay-transport"
npm install
npx nitrogen --config packages/react-native-localpay-transport/nitro.json
```

Expected: `packages/react-native-localpay-transport/nitrogen/generated/` created, containing `ios/LocalPayTransport+autolinking.rb`.

- [ ] **Step 6: Build and verify no CoreBluetooth crept in**

```bash
npm run prebuild:ios
grep -n "LocalPayTransport" ios/Podfile.lock
npm run ios-build-for-app-store
```

Then, on the produced `.ipa`:

```bash
unzip -q -o build-*.ipa -d /tmp/lpcheck && otool -L /tmp/lpcheck/Payload/BSVBrowser.app/BSVBrowser | grep -ci corebluetooth
```

Expected: `LocalPayTransport` present in `Podfile.lock`; CoreBluetooth count **0**. A non-zero count is a stop-the-line failure — find the dependency that pulled it in and remove it.

- [ ] **Step 7: Commit**

```bash
git add packages/react-native-localpay-transport package.json package-lock.json ios/
git commit -m "feat(localpay): scaffold LocalPayTransport nitro module"
```

---

### Task 5: AWDL transport in Swift

**Files:**
- Modify: `packages/react-native-localpay-transport/src/specs/LocalPayTransport.nitro.ts`
- Modify: `packages/react-native-localpay-transport/ios/HybridLocalPayTransport.swift`
- Create: `packages/react-native-localpay-transport/ios/AwdlSession.swift`

**Interfaces:**
- Consumes: `getLocalPayTransport()` from Task 4
- Produces, on the `LocalPayTransport` hybrid object:
  - `isSupported(): boolean`
  - `startListening(instanceName: string, pskBase64: string, onFrame: (frameBase64: string) => void, onError: (message: string) => void): Promise<void>`
  - `stopListening(): Promise<void>`
  - `sendFrame(instanceName: string, pskBase64: string, frameBase64: string, timeoutMs: number): Promise<string>` — resolves with the base64 ack frame

**Carried forward from Task 4's review:** `isSupported()` currently reads `if #available(iOS 15.0, *) { return true }` while the podspec pins the deployment target to iOS 15.1. The check can never evaluate false, so it is dead code and the method is effectively `return true`. Replace it with a real capability probe in this task — at minimum confirm `NWParameters` peer-to-peer is usable, rather than asserting support unconditionally.

- [ ] **Step 1: Extend the Nitro spec**

```ts
// packages/react-native-localpay-transport/src/specs/LocalPayTransport.nitro.ts
import type { HybridObject } from 'react-native-nitro-modules'

export interface LocalPayTransport extends HybridObject<{ ios: 'swift' }> {
  isSupported(): boolean
  startListening(
    instanceName: string,
    pskBase64: string,
    onFrame: (frameBase64: string) => void,
    onError: (message: string) => void
  ): Promise<void>
  stopListening(): Promise<void>
  sendFrame(
    instanceName: string,
    pskBase64: string,
    frameBase64: string,
    timeoutMs: number
  ): Promise<string>
}
```

- [ ] **Step 2: Write the shared TLS-PSK parameter builder**

```swift
// packages/react-native-localpay-transport/ios/AwdlSession.swift
import Foundation
import Network
import Security

enum AwdlSession {
  static let serviceType = "_bsvpay._tcp"

  /// TCP over AWDL, authenticated and encrypted with a pre-shared key.
  /// Only a peer that saw the pairing QR holds the PSK, so this is mutual auth.
  static func parameters(psk: Data, identity: Data) -> NWParameters {
    let tls = NWProtocolTLS.Options()
    let opts = tls.securityProtocolOptions
    psk.withUnsafeBytes { pskBuf in
      identity.withUnsafeBytes { idBuf in
        let pskData = DispatchData(bytes: pskBuf)
        let idData = DispatchData(bytes: idBuf)
        sec_protocol_options_add_pre_shared_key(
          opts,
          pskData as __DispatchData,
          idData as __DispatchData
        )
      }
    }
    sec_protocol_options_append_tls_ciphersuite(
      opts,
      tls_ciphersuite_t(rawValue: TLS_PSK_WITH_AES_128_GCM_SHA256)!
    )
    let params = NWParameters(tls: tls)
    params.includePeerToPeer = true
    return params
  }

  /// 4-byte big-endian length prefix, so a stream yields discrete frames.
  static func lengthPrefixed(_ payload: Data) -> Data {
    var out = Data(count: 4)
    let n = UInt32(payload.count).bigEndian
    withUnsafeBytes(of: n) { out.replaceSubrange(0..<4, with: $0) }
    out.append(payload)
    return out
  }

  static func readFrame(on conn: NWConnection, completion: @escaping (Result<Data, Error>) -> Void) {
    conn.receive(minimumIncompleteLength: 4, maximumLength: 4) { header, _, _, error in
      if let error { return completion(.failure(error)) }
      guard let header, header.count == 4 else {
        return completion(.failure(NSError(domain: "LocalPayTransport", code: 1,
          userInfo: [NSLocalizedDescriptionKey: "short header"])))
      }
      let length = Int(header.withUnsafeBytes { $0.load(as: UInt32.self).bigEndian })
      guard length > 0, length <= 8 * 1024 * 1024 else {
        return completion(.failure(NSError(domain: "LocalPayTransport", code: 2,
          userInfo: [NSLocalizedDescriptionKey: "frame length out of range: \(length)"])))
      }
      conn.receive(minimumIncompleteLength: length, maximumLength: length) { body, _, _, error in
        if let error { return completion(.failure(error)) }
        guard let body, body.count == length else {
          return completion(.failure(NSError(domain: "LocalPayTransport", code: 3,
            userInfo: [NSLocalizedDescriptionKey: "short body"])))
        }
        completion(.success(body))
      }
    }
  }
}
```

- [ ] **Step 3: Implement listen and send**

```swift
// packages/react-native-localpay-transport/ios/HybridLocalPayTransport.swift
import Foundation
import Network

final class HybridLocalPayTransport: HybridLocalPayTransportSpec {
  private var listener: NWListener?
  private var live: [NWConnection] = []
  private let queue = DispatchQueue(label: "org.bsvassociation.localpay")

  func isSupported() throws -> Bool {
    if #available(iOS 15.0, *) { return true }
    return false
  }

  func startListening(
    instanceName: String,
    pskBase64: String,
    onFrame: @escaping (String) -> Void,
    onError: @escaping (String) -> Void
  ) throws -> Promise<Void> {
    let promise = Promise<Void>()
    guard let psk = Data(base64Encoded: pskBase64),
          let identity = instanceName.data(using: .utf8) else {
      promise.reject(withError: NSError(domain: "LocalPayTransport", code: 10,
        userInfo: [NSLocalizedDescriptionKey: "bad psk or instance name"]))
      return promise
    }
    do {
      let params = AwdlSession.parameters(psk: psk, identity: identity)
      let l = try NWListener(using: params)
      l.service = NWListener.Service(name: instanceName, type: AwdlSession.serviceType)
      l.newConnectionHandler = { [weak self] conn in
        guard let self else { return }
        self.live.append(conn)
        conn.start(queue: self.queue)
        AwdlSession.readFrame(on: conn) { result in
          switch result {
          case .success(let data):
            onFrame(data.base64EncodedString())
            let ack = AwdlSession.lengthPrefixed(Data("{\"ok\":true}".utf8))
            conn.send(content: ack, completion: .contentProcessed { _ in conn.cancel() })
          case .failure(let error):
            onError(error.localizedDescription)
            conn.cancel()
          }
        }
      }
      l.stateUpdateHandler = { state in
        if case .failed(let error) = state { onError(error.localizedDescription) }
      }
      l.start(queue: queue)
      listener = l
      promise.resolve(withResult: ())
    } catch {
      promise.reject(withError: error)
    }
    return promise
  }

  func stopListening() throws -> Promise<Void> {
    let promise = Promise<Void>()
    listener?.cancel()
    listener = nil
    live.forEach { $0.cancel() }
    live.removeAll()
    promise.resolve(withResult: ())
    return promise
  }

  func sendFrame(
    instanceName: String,
    pskBase64: String,
    frameBase64: String,
    timeoutMs: Double
  ) throws -> Promise<String> {
    let promise = Promise<String>()
    guard let psk = Data(base64Encoded: pskBase64),
          let payload = Data(base64Encoded: frameBase64),
          let identity = instanceName.data(using: .utf8) else {
      promise.reject(withError: NSError(domain: "LocalPayTransport", code: 11,
        userInfo: [NSLocalizedDescriptionKey: "bad psk or frame"]))
      return promise
    }

    let params = AwdlSession.parameters(psk: psk, identity: identity)
    let endpoint = NWEndpoint.service(
      name: instanceName, type: AwdlSession.serviceType, domain: "local", interface: nil
    )
    let conn = NWConnection(to: endpoint, using: params)

    var settled = false
    let settle: (Result<String, Error>) -> Void = { result in
      guard !settled else { return }
      settled = true
      switch result {
      case .success(let ack): promise.resolve(withResult: ack)
      case .failure(let error): promise.reject(withError: error)
      }
      conn.cancel()
    }

    queue.asyncAfter(deadline: .now() + .milliseconds(Int(timeoutMs))) {
      settle(.failure(NSError(domain: "LocalPayTransport", code: 12,
        userInfo: [NSLocalizedDescriptionKey: "timed out waiting for peer"])))
    }

    conn.stateUpdateHandler = { state in
      switch state {
      case .ready:
        conn.send(content: AwdlSession.lengthPrefixed(payload), completion: .contentProcessed { error in
          if let error { return settle(.failure(error)) }
          AwdlSession.readFrame(on: conn) { result in
            switch result {
            case .success(let ack): settle(.success(ack.base64EncodedString()))
            case .failure(let error): settle(.failure(error))
            }
          }
        })
      case .failed(let error):
        settle(.failure(error))
      case .cancelled:
        settle(.failure(NSError(domain: "LocalPayTransport", code: 13,
          userInfo: [NSLocalizedDescriptionKey: "connection cancelled"])))
      default:
        break
      }
    }
    conn.start(queue: queue)
    return promise
  }
}
```

- [ ] **Step 4: Regenerate Nitro bindings and build**

```bash
npx nitrogen --config packages/react-native-localpay-transport/nitro.json
npm run prebuild:ios
npm run ios-build-for-app-store
```

Expected: build succeeds. Swift compile errors in the Nitro-generated spec conformance mean the `.nitro.ts` signature and the Swift method signature disagree — reconcile against `nitrogen/generated/ios/swift/HybridLocalPayTransportSpec.swift`.

- [ ] **Step 5: Manual two-device check**

Install on two iPhones. On device A call `startListening('bsvpay-testtesttesttesttesttes', <32 zero bytes base64>, …)`; on device B call `sendFrame` with the same arguments and a small payload. Turn **Wi-Fi on but join no network** on both, to force the AWDL path.

Expected: device A's `onFrame` fires with the payload; device B's promise resolves with the ack. Confirm the Local Network permission prompt appears on first run and that denying it surfaces via `onError` rather than hanging.

- [ ] **Step 6: Commit**

```bash
git add packages/react-native-localpay-transport ios/
git commit -m "feat(localpay): AWDL listener and sender with TLS-PSK"
```

---

### Task 6: Transport interface and adapters

**Files:**
- Create: `utils/localpay/transport/types.ts`
- Create: `utils/localpay/transport/awdl.ts`
- Create: `utils/localpay/transport/qr.ts`
- Create: `utils/localpay/transport/select.ts`
- Test: `__tests__/localpayTransportSelect.test.ts`

**Interfaces:**
- Consumes: `Session`, `CAP_AWDL`, `instanceName` (Task 2); `PaymentFrame`, `encodeFrame`, `decodeFrame` (Task 1); `getLocalPayTransport` (Task 4)
- Produces:
  - `interface LocalPaymentTransport { kind: 'awdl' | 'qr'; receive(session, signal): Promise<PaymentFrame>; send(session, frame, signal): Promise<Ack> }`
  - `interface Ack { ok: boolean; error?: string }`
  - `selectTransport(session: Session): 'awdl' | 'qr'`
  - `awdlTransport: LocalPaymentTransport`
  - `qrTransport: LocalPaymentTransport` — its `receive`/`send` throw `QrHandoffRequired`, because the QR path is driven by the UI rather than by a promise
  - `class QrHandoffRequired extends Error`

- [ ] **Step 1: Write the failing test**

Selection is the only part of this task that is unit-testable without devices; the adapters are exercised in Task 9's manual pass.

```ts
// __tests__/localpayTransportSelect.test.ts
import { Platform } from 'react-native'
import { selectTransport } from '@/utils/localpay/transport/select'
import { mintSession, CAP_AWDL } from '@/utils/localpay/session'

jest.mock('react-native-localpay-transport', () => ({
  getLocalPayTransport: () => ({ isSupported: () => true }),
}))

const base = {
  identityKey: '02'.padEnd(66, 'd'),
  amount: 1,
  derivationPrefix: 'cA',
  derivationSuffix: 'cw',
}

describe('transport selection', () => {
  afterEach(() => { Platform.OS = 'ios' })

  it('uses AWDL when both sides support it', () => {
    Platform.OS = 'ios'
    expect(selectTransport(mintSession({ ...base, supportsAwdl: true }))).toBe('awdl')
  })

  it('falls back to QR when the payee cannot do AWDL', () => {
    Platform.OS = 'ios'
    expect(selectTransport(mintSession({ ...base, supportsAwdl: false }))).toBe('qr')
  })

  it('falls back to QR when the local device is Android', () => {
    Platform.OS = 'android'
    expect(selectTransport(mintSession({ ...base, supportsAwdl: true }))).toBe('qr')
  })

  it('leaves the AWDL capability bit set only when advertised', () => {
    expect(mintSession({ ...base, supportsAwdl: false }).caps & CAP_AWDL).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- localpayTransportSelect`
Expected: FAIL — cannot resolve `@/utils/localpay/transport/select`

- [ ] **Step 3: Write the types and selection**

```ts
// utils/localpay/transport/types.ts
import type { PaymentFrame } from '../codec'
import type { Session } from '../session'

export interface Ack {
  ok: boolean
  error?: string
}

export interface LocalPaymentTransport {
  readonly kind: 'awdl' | 'qr'
  receive(session: Session, signal: AbortSignal): Promise<PaymentFrame>
  send(session: Session, frame: PaymentFrame, signal: AbortSignal): Promise<Ack>
}

export class QrHandoffRequired extends Error {
  constructor() {
    super('QR transport is driven by the UI, not by this interface')
    this.name = 'QrHandoffRequired'
  }
}
```

```ts
// utils/localpay/transport/select.ts
import { Platform } from 'react-native'
import { getLocalPayTransport } from 'react-native-localpay-transport'
import { CAP_AWDL, type Session } from '../session'

/** True when this device can act as an AWDL peer. */
export function localSupportsAwdl(): boolean {
  if (Platform.OS !== 'ios') return false
  try {
    return getLocalPayTransport()?.isSupported() ?? false
  } catch {
    return false
  }
}

export function selectTransport(session: Session): 'awdl' | 'qr' {
  const peerSupports = (session.caps & CAP_AWDL) !== 0
  return peerSupports && localSupportsAwdl() ? 'awdl' : 'qr'
}
```

- [ ] **Step 4: Write the AWDL adapter**

```ts
// utils/localpay/transport/awdl.ts
import { getLocalPayTransport } from 'react-native-localpay-transport'
import { decodeFrame, encodeFrame, type PaymentFrame } from '../codec'
import { instanceName, type Session } from '../session'
import type { Ack, LocalPaymentTransport } from './types'

const SEND_TIMEOUT_MS = 20_000

function toBase64(b: Uint8Array): string {
  let s = ''
  for (const byte of b) s += String.fromCharCode(byte)
  return globalThis.btoa(s)
}

function fromBase64(s: string): Uint8Array {
  return Uint8Array.from(globalThis.atob(s), c => c.charCodeAt(0))
}

export const awdlTransport: LocalPaymentTransport = {
  kind: 'awdl',

  receive(session: Session, signal: AbortSignal): Promise<PaymentFrame> {
    const native = getLocalPayTransport()
    if (!native) return Promise.reject(new Error('AWDL transport unavailable'))
    const name = instanceName(session.sessionId)

    return new Promise<PaymentFrame>((resolve, reject) => {
      let settled = false
      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        void native.stopListening()
        fn()
      }
      signal.addEventListener('abort', () => finish(() => reject(new Error('cancelled'))))

      native
        .startListening(
          name,
          toBase64(session.psk),
          frameBase64 => {
            try {
              finish(() => resolve(decodeFrame(fromBase64(frameBase64))))
            } catch (e) {
              finish(() => reject(e))
            }
          },
          message => finish(() => reject(new Error(message)))
        )
        .catch(e => finish(() => reject(e)))
    })
  },

  async send(session: Session, frame: PaymentFrame): Promise<Ack> {
    const native = getLocalPayTransport()
    if (!native) throw new Error('AWDL transport unavailable')
    const ackBase64 = await native.sendFrame(
      instanceName(session.sessionId),
      toBase64(session.psk),
      toBase64(encodeFrame(frame)),
      SEND_TIMEOUT_MS
    )
    try {
      return JSON.parse(new TextDecoder().decode(fromBase64(ackBase64))) as Ack
    } catch {
      return { ok: false, error: 'malformed ack' }
    }
  },
}
```

- [ ] **Step 5: Write the QR adapter stub**

```ts
// utils/localpay/transport/qr.ts
import { QrHandoffRequired, type LocalPaymentTransport } from './types'

/**
 * The QR path has no socket: the payer renders a frame and the payee scans it.
 * The screen drives both halves directly, so these entry points exist only to
 * satisfy the interface and must not be called.
 */
export const qrTransport: LocalPaymentTransport = {
  kind: 'qr',
  receive() {
    return Promise.reject(new QrHandoffRequired())
  },
  send() {
    return Promise.reject(new QrHandoffRequired())
  },
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- localpayTransportSelect`
Expected: PASS, 4 tests

- [ ] **Step 7: Commit**

```bash
git add utils/localpay/transport __tests__/localpayTransportSelect.test.ts
git commit -m "feat(localpay): transport interface, AWDL adapter and selection"
```

---

### Task 7: Payment construction

Builds the `PaymentFrame` a payer sends, from a scanned `Session`.

**Files:**
- Create: `utils/localpay/build.ts`
- Test: `__tests__/localpayBuild.test.ts`

**Interfaces:**
- Consumes: `PaymentFrame` (Task 1), `Session` (Task 2), `PEERPAY_PROTOCOL_ID` (Task 3)
- Produces: `buildPaymentFrame(wallet, session, transportKind, originator): Promise<PaymentFrame>`

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/localpayBuild.test.ts
import { buildPaymentFrame } from '@/utils/localpay/build'
import { mintSession } from '@/utils/localpay/session'

const session = () => mintSession({
  identityKey: '02'.padEnd(66, 'e'),
  amount: 777,
  derivationPrefix: 'cHJlZml4',
  derivationSuffix: 'c3VmZml4',
  supportsAwdl: true,
})

function walletStub() {
  return {
    getPublicKey: jest.fn().mockResolvedValue({ publicKey: '03'.padEnd(66, 'f') }),
    createAction: jest.fn().mockResolvedValue({ tx: [1, 2, 3], txid: 'deadbeef' }),
  }
}

describe('buildPaymentFrame', () => {
  it('echoes the session derivation nonces and amount', async () => {
    const s = session()
    const f = await buildPaymentFrame(walletStub() as never, s, 'awdl', 'admin.com')
    expect(f.amount).toBe(777)
    expect(f.derivationPrefix).toBe(s.derivationPrefix)
    expect(f.derivationSuffix).toBe(s.derivationSuffix)
  })

  it('uses the local identity key as sender', async () => {
    const f = await buildPaymentFrame(walletStub() as never, session(), 'awdl', 'admin.com')
    expect(f.senderIdentityKey).toBe('03'.padEnd(66, 'f'))
  })

  it('carries the transaction bytes', async () => {
    const f = await buildPaymentFrame(walletStub() as never, session(), 'awdl', 'admin.com')
    expect(Array.from(f.transaction)).toEqual([1, 2, 3])
  })

  it('propagates a createAction failure', async () => {
    const w = walletStub()
    w.createAction.mockRejectedValue(new Error('insufficient funds'))
    await expect(buildPaymentFrame(w as never, session(), 'awdl', 'admin.com'))
      .rejects.toThrow('insufficient funds')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- localpayBuild`
Expected: FAIL — cannot resolve `@/utils/localpay/build`

- [ ] **Step 3: Write the implementation**

```ts
// utils/localpay/build.ts
import { P2PKH, PublicKey } from '@bsv/sdk'
import { FRAME_VERSION, type PaymentFrame } from './codec'
import type { Session } from './session'
import { PEERPAY_LABEL, PEERPAY_PROTOCOL_ID } from './pending'

interface PayingWallet {
  getPublicKey(args: unknown, originator?: string): Promise<{ publicKey: string }>
  createAction(args: unknown, originator?: string): Promise<{ tx?: number[]; txid?: string }>
}

/**
 * Builds the frame a payer sends. BRC-29: the output locks to a key derived
 * for the payee from the session's derivation nonces.
 */
export async function buildPaymentFrame(
  wallet: PayingWallet,
  session: Session,
  transportKind: 'awdl' | 'qr',
  originator: string
): Promise<PaymentFrame> {
  const { publicKey: senderIdentityKey } = await wallet.getPublicKey({ identityKey: true }, originator)

  const { publicKey: derived } = await wallet.getPublicKey(
    {
      protocolID: PEERPAY_PROTOCOL_ID,
      keyID: `${session.derivationPrefix} ${session.derivationSuffix}`,
      counterparty: session.identityKey,
      forSelf: false,
    },
    originator
  )

  const lockingScript = new P2PKH()
    .lock(PublicKey.fromString(derived).toAddress())
    .toHex()

  const result = await wallet.createAction(
    {
      description: 'Payment to a nearby device',
      labels: [PEERPAY_LABEL],
      outputs: [
        {
          lockingScript,
          satoshis: session.amount,
          outputDescription: 'Nearby payment',
        },
      ],
      options: { randomizeOutputs: false, noSend: true },
    },
    originator
  )

  if (!result.tx) throw new Error('createAction returned no transaction')

  return {
    version: FRAME_VERSION,
    senderIdentityKey,
    amount: session.amount,
    outputIndex: 0,
    derivationPrefix: session.derivationPrefix,
    derivationSuffix: session.derivationSuffix,
    transaction: new Uint8Array(result.tx),
  }
}
```

Note on `transportKind`: it is accepted now so the signature is stable, and becomes meaningful in the deferred offline spike where the QR path will trim ancestry. Today both paths send what `createAction` returns.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- localpayBuild`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add utils/localpay/build.ts __tests__/localpayBuild.test.ts
git commit -m "feat(localpay): build BRC-29 payment frame from a scanned session"
```

---

### Task 8: Configuration and permissions

**Files:**
- Modify: `app.json` — `ios.infoPlist`
- Modify: `utils/permissionsManager.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `_bsvpay._tcp` declared in `NSBonjourServices`; a real `NSLocalNetworkUsageDescription`

- [ ] **Step 1: Add the Bonjour service and a real local-network purpose string**

In `app.json`, inside `expo.ios.infoPlist`, add:

```json
"NSBonjourServices": ["_bsvpay._tcp"],
"NSLocalNetworkUsageDescription": "BSV Browser uses the local network to send and receive payments directly between nearby devices."
```

Two cautions:
- The generated `ios/BSVBrowser/Info.plist` currently carries `NSBonjourServices = ["_expo._tcp"]` and Expo Dev Launcher's dev-server purpose string, both injected by the dev-client plugin at prebuild. Setting these in `app.json` provides the shipping values; after prebuild, verify both `_expo._tcp` and `_bsvpay._tcp` are present in dev-client builds and that the purpose string is **ours**, not Expo's.
- Do **not** add any key from the Global Constraints prohibited list.

- [ ] **Step 2: Verify the generated plist**

```bash
npm run prebuild:ios
python3 -c "
import plistlib
d=plistlib.load(open('ios/BSVBrowser/Info.plist','rb'))
print('bonjour:', d.get('NSBonjourServices'))
print('purpose:', d.get('NSLocalNetworkUsageDescription'))
banned=['NSPhotoLibraryUsageDescription','NSLocationAlwaysUsageDescription','NSLocationAlwaysAndWhenInUseUsageDescription','NSHomeKitUsageDescription','NSBluetoothAlwaysUsageDescription','NSHealthShareUsageDescription','NSHealthUpdateUsageDescription']
print('banned present:', [k for k in banned if k in d] or 'none')
"
```

Expected: `_bsvpay._tcp` present, purpose string is ours, banned list empty.

- [ ] **Step 3: Commit**

```bash
git add app.json ios/BSVBrowser/Info.plist
git commit -m "feat(localpay): declare _bsvpay._tcp and a real local-network purpose string"
```

---

### Task 9: Local payments screen

**Files:**
- Create: `app/local-payments.tsx`
- Modify: `context/i18n/translations.tsx`

Read the removed screen for UI structure and copy before writing: `git show 5fc72a7:app/local-payments.tsx`. Reuse its layout and phase machine; replace every BLE mention with the transports here. Reuse `components/QRScanner.tsx` (props: `onScan`, `onClose`, `hintText`, `multiScan`, `renderBottom`) and `react-native-qrcode-svg` for rendering.

**Interfaces:**
- Consumes: everything from Tasks 1–7
- Produces: route `/local-payments`

- [ ] **Step 1: Add i18n keys for all four locales**

`context/i18n/translations.tsx` has `en`, `zh`, `hi` and `es` blocks. Add to each (English shown; translate the rest, and note the old strings said "Bluetooth" — these must not):

```
local_payments: 'Local Payments'
local_payments_subtitle: 'Send or receive BSV payments to a nearby device.'
local_pay_request: 'Request Payment'
local_pay_send: 'Send Payment'
local_pay_show_qr: 'Show this code to the payer'
local_pay_scan_qr: 'Scan the payee’s code'
local_pay_waiting: 'Waiting for the payer…'
local_pay_show_payment_qr: 'Show this code to the payee'
local_pay_sent: 'Payment sent'
local_pay_received: 'Payment received'
local_pay_failed: 'Payment failed'
local_pay_network_denied: 'Local Network access is off. Enable it in Settings to pay nearby devices.'
local_pay_amount: 'Amount'
```

- [ ] **Step 2: Build the screen**

Phase machine, mirroring the original's structure:

```
choose_role
  ├── receive: enter amount → mintSession → render session QR
  │     ├── AWDL: awdlTransport.receive() → savePending → processPending → 'received'
  │     └── QR:   QRScanner scans the payer's frame QR → savePending → processPending
  └── send: QRScanner scans session QR → decodeSession → confirm amount + payee
        ├── selectTransport === 'awdl': buildPaymentFrame → awdlTransport.send() → 'sent'
        └── selectTransport === 'qr':   buildPaymentFrame → render encodeFrame as QR → 'sent'
```

Requirements that must be met, not paraphrased:

- The payee sets `supportsAwdl: localSupportsAwdl()` when minting, so an Android payee advertises no AWDL capability and the payer takes the QR path automatically.
- The payee starts `awdlTransport.receive()` **only** when `localSupportsAwdl()`, and always renders the QR regardless, so a QR-path payer can complete.
- Every `receive()` is passed an `AbortSignal` aborted on unmount and on back-navigation. Leaking a listener leaves the device advertising.
- On receive: `savePending(storage, frame)` **before** any internalize attempt. Then `processPending(...)`. Never internalize without persisting first.
- On receive, before persisting: `if (await isSessionSpent(storage, session.sessionId)) return` — surface `local_pay_failed` and stop. After a successful `savePending`, call `markSessionSpent(storage, session.sessionId)`. A re-scanned session QR must never double-credit.
- **Ordering is money-safety-critical: `savePending` MUST complete before `markSessionSpent`.** Reversing them means a crash in between marks the session handled while the payment was never persisted — and since a session is one-shot (bound to a single QR and PSK), that payment is unrecoverable. Never mark spent optimistically.
- Neither `PaymentFrame` nor `PendingPayment` carries a `sessionId`, so the queue cannot reconstruct which session an entry came from. Thread the live `session.sessionId` through at receive time; do not attempt to recover it during a cold-start `processPending` retry.
- Local Network denial surfaces as `local_pay_network_denied` with a route to Settings — not a spinner that never resolves.
- Render the payment QR with `react-native-qrcode-svg` at error-correction level `M`, sized to at least 280pt.
- Every `decodeSession` and `decodeFrame` call sits inside a `try/catch` that handles **all** errors, not only `CodecError`. A structurally valid envelope carrying malformed base64, or a body that parses to literal `null`, still throws a native error from `atob`/destructuring. A hostile or corrupted QR must surface `local_pay_failed`, never crash the screen.

- [ ] **Step 3: Verify the screen renders in the existing sanity test**

Run: `npm test -- render-sanity`
Expected: PASS. If the new route breaks it, fix the screen — do not weaken the test.

- [ ] **Step 4: Commit**

```bash
git add app/local-payments.tsx context/i18n/translations.tsx
git commit -m "feat(localpay): local payments screen with AWDL and QR paths"
```

---

### Task 10: Wallet wiring and entry point

Restores the background retry loop `ed454e9` removed. Read the original: `git show ed454e9 -- context/WalletContext.tsx`.

**Files:**
- Modify: `context/WalletContext.tsx`
- Modify: `app/_layout.tsx`
- Modify: `app/settings.tsx`

**Interfaces:**
- Consumes: `processPending` (Task 3), route `/local-payments` (Task 9)
- Produces: `localPayNotification` and `clearLocalPayNotification` on the wallet context

- [ ] **Step 1: Add notification state and the retry effect to WalletContext**

Add to the context value type and provider:

```ts
localPayNotification: { message: string; type: 'success' | 'error' | 'info' } | null
clearLocalPayNotification: () => void
```

Then the effect, adapted from the removed BLE version — it ran after wallet build and again whenever connectivity returned:

```ts
useEffect(() => {
  if (!walletBuilt || !managers.permissionsManager || !storage) return

  const tryProcess = async () => {
    try {
      const netState = await NetInfo.fetch()
      if (!netState.isConnected || netState.isInternetReachable === false) return
      const results = await processPending(managers.permissionsManager as any, storage, adminOriginator)
      const successes = results.filter(r => r.success)
      if (successes.length > 0) {
        setLocalPayNotification({
          message:
            successes.length === 1
              ? 'A local payment was added to your wallet'
              : `${successes.length} local payments were added to your wallet`,
          type: 'success',
        })
      }
    } catch {
      // Best-effort — failures are recorded per-entry in the queue
    }
  }

  tryProcess()
  const unsubscribe = NetInfo.addEventListener(state => {
    if (state.isConnected && state.isInternetReachable !== false) tryProcess()
  })
  return () => unsubscribe()
}, [walletBuilt, managers.permissionsManager, storage, adminOriginator])
```

`@react-native-community/netinfo` is already a dependency (11.5.2) — no install needed.

- [ ] **Step 2: Surface the notification globally**

In `app/_layout.tsx`, read `localPayNotification` / `clearLocalPayNotification` from the wallet context and render the existing global snackbar, so a payment internalized in the background is visible from any screen. Follow what `ed454e9` removed: `git show ed454e9 -- app/_layout.tsx`.

- [ ] **Step 3: Add the settings entry**

In `app/settings.tsx`, add a row routing to `/local-payments`, using `local_payments` and `local_payments_subtitle`. Match the surrounding rows' structure exactly.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS, no regressions.

- [ ] **Step 5: Commit**

```bash
git add context/WalletContext.tsx app/_layout.tsx app/settings.tsx
git commit -m "feat(localpay): background internalize retry, global snackbar, settings entry"
```

---

### Task 11: End-to-end verification

No new code. This task exists because every prior task's tests are unit-level, and the transports cannot be proven without hardware.

- [ ] **Step 1: Confirm no CoreBluetooth in the shipping binary**

```bash
npm run ios-build-for-app-store
unzip -q -o build-*.ipa -d /tmp/lpfinal
otool -L /tmp/lpfinal/Payload/BSVBrowser.app/BSVBrowser | grep -ci corebluetooth
strings -a /tmp/lpfinal/Payload/BSVBrowser.app/BSVBrowser | grep -c "CBCentralManager\|CBPeripheralManager"
```

Expected: **0** and **0**. Anything else blocks release.

- [ ] **Step 2: Two iPhones, no network**

Wi-Fi on, joined to no network, on both. Payee requests 1000 sat; payer scans and pays.
Expected: payer sees `local_pay_sent`, payee sees `local_pay_received`, and the payment appears in the payee's transaction list once online.

- [ ] **Step 3: Two iPhones, same Wi-Fi**

Same flow on a shared network. Expected: identical result — confirms `includePeerToPeer` doesn't regress when infrastructure Wi-Fi is present. This is the configuration most likely to misbehave.

- [ ] **Step 4: iOS payer → Android payee, and Android payer → iOS payee**

Expected: both take the QR path automatically, with no AWDL attempt and no error surfaced.

- [ ] **Step 5: Failure paths**

Each must produce a clear message and leave no stuck state:
- Local Network permission denied on the payer
- Payer walks out of range mid-transfer
- Payee backgrounds the app mid-transfer
- Payee offline at receipt, then reconnects — payment must internalize via the retry effect and raise the global snackbar
- The same session QR scanned twice — the second attempt must not double-spend or double-credit

- [ ] **Step 6: Commit any fixes and open the PR**

```bash
git add -A
git commit -m "fix(localpay): device-test findings"
```

---

## Deferred, deliberately

- **Offline and chained unconfirmed spends.** Separate spike. When it lands, the QR path needs fountain-coded animated QR (payload grows ~226 B per chained spend), and `buildPaymentFrame` would need a per-transport encoding switch again — the `transportKind` parameter it originally carried was removed as dead, since both paths ship AtomicBEEF.
- **Android as an AWDL peer.** Not possible; would need Wi-Fi Aware, which is entitlement-gated with unproven Android interop.
- **Payee-initiated request with no fixed amount.** Open question 1 in the spec.
- **Retention policy for completed pending entries.** Open question 2. The queue grows unbounded until decided.
