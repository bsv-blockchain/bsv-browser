# Nearby Payment Encoding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the unverifiable `amount` field from `PaymentFrame`, take the settled figure from the AtomicBEEF output this device can prove it owns, and render every payment QR through `@bsv/air-gap` with 1 KiB source blocks.

**Architecture:** A new pure module `utils/localpay/verify.ts` parses the frame's AtomicBEEF, re-derives the payee's own expected P2PKH script from the frame's derivation nonces, and returns the satoshis of the output at `outputIndex` only if that output locks to that script. `NearbyFlow`'s single write path (`settleReceived`) uses that figure everywhere it used to read `frame.amount`, which leaves the field with no readers so the codec can drop it (`FRAME_VERSION` 1 → 2). `PaymentQrDisplay` then loses its static-QR branch and always fountains, which retires `MAX_FRAME_QR_CHARS` and the scanner's bare-envelope branch.

**Tech Stack:** TypeScript, React Native / Expo, `@bsv/sdk` (`Transaction`, `Beef`, `P2PKH`, `PublicKey`), `@bsv/air-gap`, `react-native-qrcode-svg`, Jest (`jest-expo`).

**Spec:** `docs/superpowers/specs/2026-07-30-nearby-payment-encoding-design.md`

## Global Constraints

- Branch: `feat/offline-nearby-payments`. Do not merge or rebase.
- Test command is `npx jest <path>` (package script is `jest`). Run the named files only; the full suite is slow.
- `Session` encoding is **unchanged**: `p`/`x` stay, and the nonce equality test at `NearbyFlow.tsx:602-616` stays exactly as it is. It is the whole frame-to-session binding.
- `Ack` and the `DeclineReason` union are **unchanged**. New failures map onto existing reasons: `decode_failed` for anything unparseable, `session_mismatch` for a frame that is not a payment to this device.
- Money-safety invariant, non-negotiable: every new failure path must occur **before** `settlingRef.current = true` and before any write, so it stays a provable "queued nothing" decline. Never report a failure after `savePending` resolves.
- `FRAME_VERSION = 2`, `FRAME_BLOCK_BYTES = 1024`.
- `estimatePartCharLength(FRAME_BLOCK_BYTES)` must stay ≤ 2331 (version-40 QR, EC level M). A test pins this.
- No storage schema migration. No new npm dependency.
- Comment style in `utils/localpay/*` is dense and explains *why*, in the imperative. Match it; do not add banner comments or restate types in prose.

---

### Task 1: `verifyFramePayment`

Pure addition — nothing imports it yet, so the tree keeps compiling.

**Files:**
- Create: `utils/localpay/verify.ts`
- Test: `__tests__/localpayVerify.test.ts`

**Interfaces:**
- Consumes: `PaymentFrame` from `utils/localpay/codec`, `PEERPAY_PROTOCOL_ID` from `utils/localpay/pending`, `isRequestableAmount` from `utils/localpay/session`.
- Produces:
  - `class FrameVerifyError extends Error` with `readonly kind: 'unparseable' | 'not_mine'`
  - `interface DerivingWallet { getPublicKey(args: unknown, originator?: string): Promise<{ publicKey: string }> }`
  - `verifyFramePayment(wallet: DerivingWallet, frame: PaymentFrame, originator: string): Promise<{ satoshis: number }>`

- [ ] **Step 1: Write the failing test**

Create `__tests__/localpayVerify.test.ts`:

```ts
import { Beef, LockingScript, P2PKH, PrivateKey, Transaction } from '@bsv/sdk'
import { FrameVerifyError, verifyFramePayment } from '@/utils/localpay/verify'
import { PEERPAY_PROTOCOL_ID } from '@/utils/localpay/pending'
import type { PaymentFrame } from '@/utils/localpay/codec'

const payeeKey = PrivateKey.fromRandom().toPublicKey()
const senderIdentityKey = '02' + 'ab'.repeat(32)

/** The script a correct payer produces for this payee and these nonces. */
function minesScript(): string {
  return new P2PKH().lock(payeeKey.toAddress()).toHex()
}

/** A real AtomicBEEF carrying `outputs`, in order. */
function beefOf(outputs: { satoshis?: number; scriptHex: string }[]): Uint8Array {
  const tx = new Transaction()
  for (const o of outputs) {
    tx.addOutput({ satoshis: o.satoshis, lockingScript: LockingScript.fromHex(o.scriptHex) })
  }
  const beef = new Beef()
  beef.mergeTransaction(tx)
  return new Uint8Array(beef.toBinaryAtomic(tx.id('hex')))
}

function frameFor(transaction: Uint8Array, outputIndex = 0): PaymentFrame {
  return {
    version: 1,
    senderIdentityKey,
    amount: 0, // still on the type at this task; unread by verify
    outputIndex,
    derivationPrefix: 'cHJlZml4',
    derivationSuffix: 'c3VmZml4',
    transaction
  } as PaymentFrame
}

/** A payee wallet that derives exactly one key, and records how it was asked. */
function payeeWallet() {
  return {
    getPublicKey: jest.fn(async () => ({ publicKey: payeeKey.toString() }))
  }
}

describe('verifyFramePayment', () => {
  it('returns the satoshis of the output that locks to this device’s derived key', async () => {
    const frame = frameFor(beefOf([{ satoshis: 4200, scriptHex: minesScript() }]))
    await expect(verifyFramePayment(payeeWallet(), frame, 'admin.com')).resolves.toEqual({ satoshis: 4200 })
  })

  it('derives with the payee’s own key, keyed by the frame’s nonces and the sender', async () => {
    const w = payeeWallet()
    await verifyFramePayment(w, frameFor(beefOf([{ satoshis: 1, scriptHex: minesScript() }])), 'admin.com')
    expect(w.getPublicKey).toHaveBeenCalledWith(
      {
        protocolID: PEERPAY_PROTOCOL_ID,
        keyID: 'cHJlZml4 c3VmZml4',
        counterparty: senderIdentityKey,
        forSelf: true
      },
      'admin.com'
    )
  })

  it('reads the output named by outputIndex, not the first one', async () => {
    const transaction = beefOf([
      { satoshis: 9, scriptHex: '76a914' + '00'.repeat(20) + '88ac' },
      { satoshis: 777, scriptHex: minesScript() }
    ])
    await expect(verifyFramePayment(payeeWallet(), frameFor(transaction, 1), 'admin.com')).resolves.toEqual({
      satoshis: 777
    })
  })

  // The hole this module closes: correct nonces, an output paying someone else.
  // Accepting it acks ok, the payer broadcasts, and the payee is credited nothing.
  it('refuses an output that pays a stranger', async () => {
    const transaction = beefOf([{ satoshis: 4200, scriptHex: '76a914' + '11'.repeat(20) + '88ac' }])
    await expect(verifyFramePayment(payeeWallet(), frameFor(transaction), 'admin.com')).rejects.toMatchObject({
      name: 'FrameVerifyError',
      kind: 'not_mine'
    })
  })

  it('refuses an output carrying no usable satoshi value', async () => {
    for (const satoshis of [undefined, 0]) {
      const transaction = beefOf([{ satoshis, scriptHex: minesScript() }])
      await expect(verifyFramePayment(payeeWallet(), frameFor(transaction), 'admin.com')).rejects.toMatchObject({
        kind: 'not_mine'
      })
    }
  })

  it('treats unreadable transaction bytes as a decode failure, not a mismatch', async () => {
    const frame = frameFor(new Uint8Array([1, 2, 3, 4, 5]))
    await expect(verifyFramePayment(payeeWallet(), frame, 'admin.com')).rejects.toMatchObject({
      kind: 'unparseable'
    })
  })

  it('treats an outputIndex past the end as a decode failure', async () => {
    const frame = frameFor(beefOf([{ satoshis: 4200, scriptHex: minesScript() }]), 3)
    await expect(verifyFramePayment(payeeWallet(), frame, 'admin.com')).rejects.toMatchObject({
      kind: 'unparseable'
    })
  })

  it('surfaces a wallet that cannot derive as an error, never as a pass', async () => {
    const w = { getPublicKey: jest.fn(async () => Promise.reject(new Error('locked'))) }
    await expect(
      verifyFramePayment(w as never, frameFor(beefOf([{ satoshis: 1, scriptHex: minesScript() }])), 'admin.com')
    ).rejects.toThrow('locked')
  })

  it('is a FrameVerifyError, so callers can switch on kind', async () => {
    const err = await verifyFramePayment(payeeWallet(), frameFor(new Uint8Array([0])), 'admin.com').catch(e => e)
    expect(err).toBeInstanceOf(FrameVerifyError)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/localpayVerify.test.ts`
Expected: FAIL — `Cannot find module '@/utils/localpay/verify'`.

- [ ] **Step 3: Write the implementation**

Create `utils/localpay/verify.ts`:

```ts
import { P2PKH, PublicKey, Transaction } from '@bsv/sdk'
import type { PaymentFrame } from './codec'
import { PEERPAY_PROTOCOL_ID } from './pending'
import { isRequestableAmount } from './session'

/**
 * Why a frame could not be shown to pay this device.
 *
 * Two kinds, because the payee's decline reason differs: bytes that are not a
 * transaction are a decode problem the payer can retry from, whereas a
 * transaction that pays someone else is a frame that was never for us.
 */
export type FrameVerifyKind = 'unparseable' | 'not_mine'

export class FrameVerifyError extends Error {
  readonly kind: FrameVerifyKind
  constructor(kind: FrameVerifyKind, message: string) {
    super(message)
    this.name = 'FrameVerifyError'
    this.kind = kind
  }
}

/** The one wallet capability this module needs: BRC-42 derivation. */
export interface DerivingWallet {
  getPublicKey(args: unknown, originator?: string): Promise<{ publicKey: string }>
}

/**
 * The satoshis a delivered frame actually pays this device.
 *
 * `internalizeAction` credits the output, not any field beside it, so the
 * figure a payee renders as a receipt has to come from the transaction — and
 * is only worth reading once the output is shown to be ours. Step 3 is the
 * payee-side mirror of the payer's derivation in `build.ts`: same protocol,
 * same keyID, same counterparty, `forSelf` flipped. If the script matches, the
 * output is spendable by this device and its satoshi count is the payment.
 *
 * Throws on every failure and returns on none, so a caller cannot mistake a
 * refusal for a zero-value payment. MUST be called before the settle path
 * latches or writes anything: every throw here has to remain a provable
 * "queued nothing" decline.
 */
export async function verifyFramePayment(
  wallet: DerivingWallet,
  frame: PaymentFrame,
  originator: string
): Promise<{ satoshis: number }> {
  let tx: Transaction
  try {
    tx = Transaction.fromAtomicBEEF(frame.transaction)
  } catch (e) {
    throw new FrameVerifyError('unparseable', `frame transaction is not readable AtomicBEEF: ${messageOf(e)}`)
  }

  const output = tx.outputs[frame.outputIndex]
  if (!output) {
    throw new FrameVerifyError(
      'unparseable',
      `frame names outputIndex ${frame.outputIndex}, but the transaction has ${tx.outputs.length} outputs`
    )
  }

  const { publicKey } = await wallet.getPublicKey(
    {
      protocolID: PEERPAY_PROTOCOL_ID,
      keyID: `${frame.derivationPrefix} ${frame.derivationSuffix}`,
      counterparty: frame.senderIdentityKey,
      forSelf: true
    },
    originator
  )

  let expected: string
  try {
    expected = new P2PKH().lock(PublicKey.fromString(publicKey).toAddress()).toHex()
  } catch (e) {
    // The derived key is ours and should always parse; a failure here means we
    // cannot say the output is ours, which is the same refusal either way.
    throw new FrameVerifyError('not_mine', `could not derive this device’s expected script: ${messageOf(e)}`)
  }

  if (output.lockingScript.toHex() !== expected) {
    throw new FrameVerifyError('not_mine', 'the named output does not pay this device')
  }

  // Optional on the SDK type, and a zero or fractional value would render as a
  // receipt for money that never moved.
  if (!isRequestableAmount(output.satoshis)) {
    throw new FrameVerifyError('not_mine', `the named output carries no usable satoshi value: ${output.satoshis}`)
  }

  return { satoshis: output.satoshis }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest __tests__/localpayVerify.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors (pre-existing errors elsewhere, if any, unchanged).

- [ ] **Step 6: Commit**

```bash
git add utils/localpay/verify.ts __tests__/localpayVerify.test.ts
git commit -m "feat(pay): verifyFramePayment proves a frame's output pays this device

The settled figure has to come from the AtomicBEEF output internalizeAction
actually credits, and is only worth reading once that output is shown to lock
to a key this device derives. Payee-side mirror of build.ts's derivation."
```

---

### Task 2: Settle from the transaction, not the frame field

`settleReceived` stops reading `frame.amount`. The field still exists on the type after this task; it simply has no readers left, which is what lets Task 3 delete it.

**Files:**
- Modify: `components/pay/NearbyFlow.tsx` (imports ~:124-145; `settleReceived` :556-772)
- Test: `__tests__/localpayVerify.test.ts` (already covers the module; the settle wiring is covered by the assertions below plus existing NearbyFlow coverage)

**Interfaces:**
- Consumes: `verifyFramePayment`, `FrameVerifyError` from Task 1.
- Produces: no new exports. `settleReceived`'s signature is unchanged: `(frame: PaymentFrame, session: Session, confirm?: ConfirmDelivery) => Promise<void>`.

- [ ] **Step 1: Add the verify step to `settleReceived`**

In `components/pay/NearbyFlow.tsx`, add to the `@/utils/pay/rails/nearby` import block (alphabetical, so after `nearbyTransport`):

```ts
  verifyFramePayment,
```

and add above it, in the same block, nothing else — `FrameVerifyError` comes from the same rail (Task 4 adds the re-export; for this task import it directly):

```ts
import { FrameVerifyError, verifyFramePayment } from '@/utils/localpay/verify'
```

Then, immediately after the `settlingRef.current` re-entry guard (`NearbyFlow.tsx:567-572`) and **before** the binding block at :574, insert:

```ts
      // (0a) What this frame actually pays this device. The figure below is the
      //      satoshis of the AtomicBEEF output at `frame.outputIndex`, and it is
      //      only produced once that output is shown to lock to a key this
      //      device derives — so it is both the real number and a proof the
      //      payment is ours to spend. Nothing has latched and nothing has been
      //      written, so every failure here is a provable "queued nothing".
      let satoshis: number
      try {
        ;({ satoshis } = await verifyFramePayment(
          wallet as unknown as DerivingWallet,
          frame,
          adminOriginator
        ))
      } catch (e) {
        // `not_mine` is a frame that was never for this request; `unparseable`
        // is bytes that are not a transaction. Both leave the request LIVE and
        // unspent, exactly as a nonce mismatch does, so the genuine payer can
        // still complete.
        const kind = e instanceof FrameVerifyError ? e.kind : 'unparseable'
        void confirm?.(false, kind === 'not_mine' ? 'session_mismatch' : 'decode_failed')
        scanLatchRef.current = false
        setSessionMismatch(true)
        setPhase('receive_wait')
        setListenerEpoch(n => n + 1)
        return
      }
```

Add the type-only import beside the value import:

```ts
import { FrameVerifyError, verifyFramePayment, type DerivingWallet } from '@/utils/localpay/verify'
```

- [ ] **Step 2: Bind against the verified figure**

Replace the `amountDisagrees` line (`NearbyFlow.tsx:602`) with:

```ts
      const amountDisagrees = session.amount !== undefined && satoshis !== session.amount
```

and delete the now-stale bullet in the comment above it — the one beginning
`· frame.amount is display-only`. Replace that bullet with:

```
      //     · the amount check compares the payee's requested figure against the
      //       satoshis verified above, not against anything the frame asserts.
```

- [ ] **Step 3: Use the verified figure for the receipt**

At `NearbyFlow.tsx:718`:

```ts
      setSettledAmount(satoshis)
```

At `NearbyFlow.tsx:764`:

```ts
        if (credited) setReceivedOverlay({ amount: satoshis, broadcast: await broadcastCheck })
```

Add `wallet` and `adminOriginator` to the `settleReceived` `useCallback` dependency array if they are not already there (they are: `[storage, wallet, adminOriginator, radioTransport, fail, t]`).

- [ ] **Step 4: Verify no reader of `frame.amount` remains**

Run: `grep -rn "frame\.amount\|\.frame\.amount" components utils app --include="*.ts" --include="*.tsx"`
Expected: no matches outside `utils/localpay/codec.ts` (`encodeFrame`/`decodeFrame`) and `utils/localpay/build.ts`.

- [ ] **Step 5: Typecheck and run the pay suites**

Run: `npx tsc --noEmit && npx jest __tests__/payScreen.test.tsx __tests__/localpayVerify.test.ts`
Expected: PASS. If `payScreen.test.tsx` stubs a wallet without `getPublicKey`, add it to the stub returning a key that produces the fixture's locking script — do not weaken `verifyFramePayment`.

- [ ] **Step 6: Commit**

```bash
git add components/pay/NearbyFlow.tsx
git commit -m "fix(pay): settle from the verified output, not the frame's amount field

A frame with correct nonces and an output paying a third party was accepted,
acked ok — releasing the payer's broadcast — and shown as received, failing
only later inside processPending. Verify before the latch instead, and take
the settled figure from the output that proves it pays us."
```

---

### Task 3: `PaymentFrame` v2 — drop `amount`

**Files:**
- Modify: `utils/localpay/codec.ts` (`FRAME_VERSION` :1, `PaymentFrame` :8-24, `encodeFrame` :96-107, `decodeFrame` :109-122)
- Modify: `utils/localpay/build.ts` (:170-177, the returned frame)
- Test: `__tests__/localpayCodec.test.ts`, `__tests__/localpayBuild.test.ts`, `__tests__/localpayPending.test.ts`, `__tests__/localpayAirGap.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `PaymentFrame` without `amount`; `FRAME_VERSION = 2`.

- [ ] **Step 1: Update the codec tests to the v2 shape**

In `__tests__/localpayCodec.test.ts`:
- delete `amount: 1234,` from `sample()`
- delete the `round-trips amounts above 32 bits` case (:39-42) and replace it with:

```ts
  it('carries no amount field: the transaction is the only source of the figure', () => {
    const decoded = decodeFrame(encodeFrame(sample())) as Record<string, unknown>
    expect('amount' in decoded).toBe(false)
  })

  it('rejects a v1 frame, whose layout put an amount after the identity key', () => {
    const v1 = encodeFrame(sample())
    v1[0] = 1
    expect(() => decodeFrame(v1)).toThrow('unsupported frame version 1')
  })

  it('is version 2', () => {
    expect(FRAME_VERSION).toBe(2)
    expect(encodeFrame(sample())[0]).toBe(2)
  })
```

In `__tests__/localpayAirGap.test.ts`, delete `amount: 123456,` from `bigFrame()`, set its `version: 2`, and delete the `expect(decoded.amount).toBe(frame.amount)` assertion.

In `__tests__/localpayPending.test.ts`, delete `amount: 42,` from `frame()` and change `expect(all[0].frame.amount).toBe(42)` to `expect(all[0].frame.outputIndex).toBe(0)`.

In `__tests__/localpayBuild.test.ts`, rename the `echoes the session derivation nonces and amount` case to `echoes the session derivation nonces`, delete `expect(frame.amount).toBe(777)`, and in the open-session case replace `expect(built.frame.amount).toBe(4200)` / `expect(...satoshis).toBe(built.frame.amount)` with:

```ts
    expect(w.createAction.mock.calls[0][0].outputs[0].satoshis).toBe(4200)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest __tests__/localpayCodec.test.ts`
Expected: FAIL — `expect(FRAME_VERSION).toBe(2)` receives 1, and the `'amount' in decoded` case is false-positive-free only after the codec changes.

- [ ] **Step 3: Change the codec**

In `utils/localpay/codec.ts`:

```ts
export const FRAME_VERSION = 2
```

Remove `amount` from the interface and note why in its place:

```ts
export interface PaymentFrame {
  version: number
  /** 66-char hex, compressed pubkey */
  senderIdentityKey: string
  /**
   * Which output of `transaction` pays the payee.
   *
   * There is deliberately no `amount` beside it. `internalizeAction` credits
   * the output, so a satoshi count on the frame could only ever agree with or
   * lie about the transaction — and `verifyFramePayment` has to parse the
   * transaction anyway to prove the output is the payee's. See verify.ts.
   */
  outputIndex: number
  derivationPrefix: string
  derivationSuffix: string
  /**
   * AtomicBEEF, on both transports. The design originally specified a bare
   * rawtx on the QR path to shrink the symbol, but ancestry is what lets the
   * payee internalize offline, and the fountain removed the symbol ceiling —
   * so one encoding serves both.
   */
  transaction: Uint8Array
}
```

In `encodeFrame`, delete `putVarint(out, f.amount)`. In `decodeFrame`, delete `const amount = getVarint(b, pos)` and drop `amount` from the returned object.

- [ ] **Step 4: Stop building the field**

In `utils/localpay/build.ts`, the returned frame becomes:

```ts
    frame: {
      version: FRAME_VERSION,
      senderIdentityKey,
      outputIndex: 0,
      derivationPrefix: session.derivationPrefix,
      derivationSuffix: session.derivationSuffix,
      transaction: new Uint8Array(result.tx),
    },
```

`amount` remains a validated parameter of `buildPaymentFrame` and still sizes the output — only the frame field goes.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest __tests__/localpayCodec.test.ts __tests__/localpayBuild.test.ts __tests__/localpayPending.test.ts __tests__/localpayAirGap.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. A residual error naming `amount` means a reader survived Task 2 — fix the reader, do not re-add the field.

- [ ] **Step 7: Commit**

```bash
git add utils/localpay/codec.ts utils/localpay/build.ts __tests__
git commit -m "feat(pay): PaymentFrame v2 drops the amount field

The figure now comes from the AtomicBEEF output verifyFramePayment proves is
ours, so a satoshi count on the frame could only agree with the transaction or
lie about it. FRAME_VERSION 2; a v1 frame is refused as decode_failed."
```

---

### Task 4: Always fountain, 1 KiB blocks

**Files:**
- Modify: `utils/localpay/codec.ts` (add `FRAME_BLOCK_BYTES`; delete `MAX_FRAME_QR_CHARS` and `frameFromQr`)
- Modify: `utils/pay/rails/nearby.ts` (export surface)
- Modify: `components/pay/PaymentQrDisplay.tsx`
- Modify: `components/pay/NearbyFlow.tsx` (scan branch :902-919; hint :1693; imports)
- Test: `__tests__/localpayCodec.test.ts`, `__tests__/localpayAirGap.test.ts`

**Interfaces:**
- Consumes: `PaymentFrame` v2 from Task 3.
- Produces: `FRAME_BLOCK_BYTES = 1024` from `utils/localpay/codec` and re-exported by `utils/pay/rails/nearby`. `MAX_FRAME_QR_CHARS` and `frameFromQr` no longer exist.

- [ ] **Step 1: Write the failing tests**

In `__tests__/localpayCodec.test.ts`: remove `frameFromQr` and `MAX_FRAME_QR_CHARS` from the import list, add `FRAME_BLOCK_BYTES`, and replace the four cases that referenced them (`round-trips a frame through a QR string`, `round-trips a realistic single-input AtomicBEEF frame`, `stays clear of the version-40 / EC-M capacity`, `reports a length a caller can gate on before rendering`, plus the two `rejects a … payload` cases for `frameFromQr`) with:

```ts
  it('round-trips a frame through the stored envelope', () => {
    const f = sample()
    expect(Array.from(frameBytesFromQr(frameToQr(f)))).toEqual(Array.from(encodeFrame(f)))
    expect(decodeFrame(frameBytesFromQr(frameToQr(f)))).toEqual(f)
  })

  it('rejects an envelope that is not a frame payload', () => {
    expect(() => frameBytesFromQr('bsvpay1:AAAA')).toThrow(CodecError)
    expect(() => frameBytesFromQr('https://example.com')).toThrow(CodecError)
  })
```

In `__tests__/localpayAirGap.test.ts`, replace every `MAX_FRAME_QR_CHARS` reference (import, and the three assertions at the `genuinely needs the fountain` line and inside `every part fits the symbol this app renders`) with the block-size contract:

```ts
import { FRAME_BLOCK_BYTES, decodeFrame, encodeFrame, frameBytesFromQr, frameToQr, type PaymentFrame } from '@/utils/localpay/codec'

/** Version-40 QR, error-correction level M, byte mode. */
const SYMBOL_CAPACITY_M = 2331

  it('sizes every part to fit the symbol this app renders', () => {
    expect(FRAME_BLOCK_BYTES).toBe(1024)
    expect(estimatePartCharLength(FRAME_BLOCK_BYTES)).toBeLessThanOrEqual(SYMBOL_CAPACITY_M)

    const encoder = new AirGapEncoder(frameBytesFromQr(frameToQr(bigFrame(40000))), {
      blockBytes: FRAME_BLOCK_BYTES
    })
    for (const seq of [0, 1, encoder.blockCount, encoder.blockCount + 17]) {
      expect(encoder.partAt(seq).length).toBeLessThanOrEqual(SYMBOL_CAPACITY_M)
    }
  })

  it('renders a one-block payment as a single unchanging part', () => {
    const small = frameBytesFromQr(frameToQr(bigFrame(200)))
    expect(small.length).toBeLessThanOrEqual(FRAME_BLOCK_BYTES)
    const encoder = new AirGapEncoder(small, { blockBytes: FRAME_BLOCK_BYTES })
    expect(encoder.blockCount).toBe(1)
    const first = encoder.partAt(0)
    for (const seq of [1, 2, 17, 999]) expect(encoder.partAt(seq)).toBe(first)
  })
```

Also add `blockBytes: FRAME_BLOCK_BYTES` to the `new AirGapEncoder(...)` calls in the two existing round-trip cases, and update the `routes parts and non-parts` case to assert `isAirGapPart(frameToQr(bigFrame(10))) === false` (unchanged) — the stored envelope must still never enter the decoder.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest __tests__/localpayCodec.test.ts __tests__/localpayAirGap.test.ts`
Expected: FAIL — `FRAME_BLOCK_BYTES` is not exported.

- [ ] **Step 3: Change the codec surface**

In `utils/localpay/codec.ts`, delete the `MAX_FRAME_QR_CHARS` declaration and its doc comment, delete `frameFromQr`, and add in their place:

```ts
/**
 * Source-block size for the animated payment code, in bytes.
 *
 * Every payment code is `@bsv/air-gap` parts — there is no single-symbol path
 * to fall back to, so this is the one number that decides symbol density.
 * `estimatePartCharLength(1024)` is 1,404 characters, and a part is
 * single-byte ASCII throughout, so it occupies 1,404 bytes of a byte-mode QR:
 * inside the 2,331-byte capacity of a version-40 symbol at error-correction
 * level M with ~40% headroom for a scanner that is not looking at the screen
 * straight on. `react-native-qrcode-svg` rethrows out of render past capacity,
 * which takes the app down through the error boundary, so the headroom is not
 * cosmetic.
 *
 * A frame of this size or smaller is a single source block, so its part string
 * never changes and the code renders as a still QR without any special case.
 */
export const FRAME_BLOCK_BYTES = 1024
```

Update the `── QR handoff ──` section comment: `bsvpayf1:` is now the persistence envelope for `offline_actions.framePayload`, not a QR wire format. Point at `FRAME_BLOCK_BYTES` for what is actually rendered, and say why there is no decoder for the envelope (nothing reads a stored payload back as a frame; the re-show path renders it).

Amend `frameToQr`'s doc comment: `/** Encodes a frame for storage and re-display. Rendered as air-gap parts, never as one symbol. */`

- [ ] **Step 4: Update the rail's export surface**

In `utils/pay/rails/nearby.ts`, in the codec re-export block: drop `MAX_FRAME_QR_CHARS` and `frameFromQr`, add `FRAME_BLOCK_BYTES`. Add a re-export for the new module beside the others:

```ts
export { FrameVerifyError, verifyFramePayment, type DerivingWallet, type FrameVerifyKind } from '@/utils/localpay/verify'
```

- [ ] **Step 5: Always-fountain renderer**

Rewrite the body of `components/pay/PaymentQrDisplay.tsx` (keep the file's existing `FRAME_MS` and `SEQ_WRAP_CYCLES` constants and their comments):

```ts
import { AirGapEncoder, FRAME_BLOCK_BYTES, frameBytesFromQr } from '@/utils/pay/rails/nearby'

export default function PaymentQrDisplay({
  frameQr,
  size = 288,
  onError
}: {
  /** The stored bsvpayf1: envelope. */
  frameQr: string
  size?: number
  /** Backstop for the encoder throwing out of render — pass the screen's handler. */
  onError?: () => void
}) {
  const encoder = useMemo(() => {
    try {
      return new AirGapEncoder(frameBytesFromQr(frameQr), { blockBytes: FRAME_BLOCK_BYTES })
    } catch {
      return null // >64 KB or malformed: nothing renderable, surface via onError
    }
  }, [frameQr])

  const [part, setPart] = useState<string | null>(null)

  useEffect(() => {
    if (!encoder) {
      setPart(null)
      return
    }
    const wrapAt = encoder.blockCount * SEQ_WRAP_CYCLES
    let seq = 0
    setPart(encoder.partAt(0))
    // One-block frames — every ordinary single-input payment — have a single
    // part string, so there is nothing to animate and no timer to run.
    if (encoder.blockCount === 1) return
    const id = setInterval(() => {
      seq = (seq + 1) % wrapAt
      setPart(encoder.partAt(seq))
    }, FRAME_MS)
    return () => clearInterval(id)
  }, [encoder])

  useEffect(() => {
    if (!encoder) onError?.()
  }, [encoder, onError])

  if (!part) return null
  return <QRCode value={part} size={size} ecl="M" color="#000" backgroundColor="#fff" onError={onError} />
}
```

Update the file's header comment: there is one path now — air-gap parts at `FRAME_BLOCK_BYTES`, of which a small payment happens to have exactly one.

- [ ] **Step 6: Parts-only scanner and a block-count hint**

In `components/pay/NearbyFlow.tsx`:

- delete the bare-envelope branch at :902-919 (from `if (scanLatchRef.current) return` through the `void settleRef.current(frame, session)` that follows `frameFromQr`), leaving `onFrameScanned` with only the air-gap branch. Add above the remaining branch:

```ts
      // Frames arrive as air-gap parts and nothing else: the payer's code is
      // always a fountain, so a bare bsvpayf1: envelope is not a payment QR
      // this build renders or accepts.
```
  Drop the now-unused `if (isAirGapPart(data))` guard's `return` fallthrough by making the function early-return when `!isAirGapPart(data)`.

- remove `frameFromQr` and `MAX_FRAME_QR_CHARS` from the rail import block; add `FRAME_BLOCK_BYTES`.
- replace the hint condition at :1693:

```ts
            {paymentQrBlocks > 1 && (
              <Text style={[styles.support, { color: colors.textSecondary }]}>{t('local_pay_animated_hint')}</Text>
            )}
```

  and add beside the other derived values (near the `sessionQr` memo, ~:1256):

```ts
  // Source blocks in the payment code. One block renders as a still QR, so the
  // "hold steady while it animates" hint would be wrong copy for it.
  const paymentQrBlocks = useMemo(() => {
    if (!paymentQr) return 0
    try {
      return Math.ceil(frameBytesFromQr(paymentQr).length / FRAME_BLOCK_BYTES)
    } catch {
      return 0
    }
  }, [paymentQr])
```

  Add `frameBytesFromQr` to the rail import block.

- update the comment at :1240 (`every frameToQr() call site already gates on MAX_MESSAGE_BYTES before calling it`) — still true, keep it, but drop any mention of a symbol-size ceiling if present.

- [ ] **Step 7: Run the tests**

Run: `npx jest __tests__/localpayCodec.test.ts __tests__/localpayAirGap.test.ts __tests__/payNearbyRail.test.ts __tests__/payScreen.test.tsx __tests__/localpayVerify.test.ts`
Expected: PASS. `payNearbyRail.test.ts:15-16` asserts `nearby.frameFromQr === codec.frameFromQr` and the same for `MAX_FRAME_QR_CHARS`; delete both lines and add `expect(nearby.FRAME_BLOCK_BYTES).toBe(codec.FRAME_BLOCK_BYTES)` plus `expect(nearby.verifyFramePayment).toBe(verify.verifyFramePayment)` with `import * as verify from '@/utils/localpay/verify'`.

- [ ] **Step 8: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint components/pay/PaymentQrDisplay.tsx components/pay/NearbyFlow.tsx utils/localpay utils/pay/rails/nearby.ts`
Expected: clean. An "unused import" for `isAirGapPart`, `decodeFrame` or similar means Step 6 left a stale import — remove it.

- [ ] **Step 9: Full localpay + pay suite**

Run: `npx jest __tests__/localpay __tests__/pay`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add utils/localpay/codec.ts utils/pay/rails/nearby.ts components/pay/PaymentQrDisplay.tsx components/pay/NearbyFlow.tsx __tests__
git commit -m "feat(pay): every payment code is an air-gap fountain, 1 KiB blocks

The static single-symbol path existed only because it predated the fountain,
and carrying both meant two accepted formats on the scanner and a size gate at
every render site. One path now: 1,024-byte blocks, 1,404-character parts,
inside a version-40 EC-M symbol. A one-block payment renders as a still QR
with no special case, and MAX_FRAME_QR_CHARS and frameFromQr are gone.

bsvpayf1: survives only as the offline_actions.framePayload envelope."
```

---

### Task 5: Device matrix note

**Files:**
- Modify: `docs/superpowers/plans/2026-07-29-offline-transport-fixes.md` (its device-matrix section)

- [ ] **Step 1: Add the rows this change needs on-device**

Append rows, matching the file's existing table shape:

- iOS → Android and Android → iOS, single-input payment over QR: code renders still (one block), scans, settles, figure on the receipt matches the amount sent.
- Multi-input payment over QR (fund a wallet with several small UTXOs first, then send an amount that needs 3+ inputs): code animates, scan completes within ~15 s, settles. This path was refused before render prior to this change and has never run on a device.
- Frame that pays a stranger: not reproducible by hand; covered by unit test only. Note that explicitly so nobody looks for a device row.
- Payer on an old build (v1 frame) scanned by a new build: expect the mismatch screen, request stays live, no double-credit.

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers
git commit -m "docs(plan): device-matrix rows for frame v2 and the always-fountain code"
```

---

## Self-Review

**Spec coverage:**

| spec section | task |
| --- | --- |
| 1. `PaymentFrame` v2 — `amount` deleted | Task 3 |
| 2. `verifyFramePayment` | Task 1 |
| 3. Settle path + decline mapping | Task 2 |
| 4. QR wire: always air-gap, 1 KiB blocks | Task 4 |
| 5. Compatibility (v1 refused; both on-disk formats) | Task 3 Step 1 (v1 refusal test), Task 4 Step 1 (envelope round-trip); no migration needed, nothing to implement |
| Testing section | Tasks 1, 3, 4 |
| Non-goals (`Session`, `Ack` untouched) | Global Constraints |

**Type consistency:** `verifyFramePayment(wallet, frame, originator) → { satoshis }`, `FrameVerifyError.kind: 'unparseable' | 'not_mine'`, `DerivingWallet.getPublicKey`, `FRAME_BLOCK_BYTES`, `FRAME_VERSION = 2` — used under those exact names in Tasks 2 and 4.

**Ordering rationale:** Task 1 adds only. Task 2 removes the last `frame.amount` readers while the field still exists. Task 3 deletes the field once nothing reads it. Task 4 changes the QR surface last, since it deletes exports two other files import. Every task leaves the tree typechecking.
