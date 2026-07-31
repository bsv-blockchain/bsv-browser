# PaymentFrame v3 (sealed frames + token format) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seal every payment frame with the session PSK, extend the frame/session codec with full BRC-92 token support (library-grade, for downstream stablecoin apps), add the token verify branch, delete the WoC error-string classification, and nudge proof collection on /pay.

**Architecture:** All wire-format work lands in `utils/localpay/` (the future `@bsv/local-payments` package): a sealed envelope around the frame bytes, a `kind`-discriminated frame v3, and a session `asset` block. bsv-browser's own pay flow keeps minting BSV-kind frames; token encode/decode/verify are built and test-pinned here but exercised by other apps. App-side work is limited to threading the PSK seal through the two radios and the QR path, one broadcast-classification deletion, and one /pay effect.

**Tech Stack:** TypeScript, React Native/Expo, Jest, `@bsv/sdk` (SymmetricKey, Transaction, Hash, Curve), `@bsv/templates` ≥1.8.0 (MandalaToken), `@bsv/air-gap`.

**Spec:** `docs/superpowers/specs/2026-07-31-token-payment-frame-v3-design.md` — read it before starting any task.

## Global Constraints

- `FRAME_VERSION = 3`, `SEAL_VERSION = 1`, kind bytes `0x01` (bsv) / `0x02` (token). Frames are never forward-compatible: unknown version, unknown kind, and trailing bytes all throw `CodecError`.
- `CAP_BLE = 0x04` (session capability bit; never set by this app's mint).
- New dependency `@bsv/templates` MUST be `^1.9.6` (≥1.8.0 is a hard floor — the assetId on-chain byte order changed in 1.8.0).
- Every failure out of `utils/localpay/codec.ts` and `session.ts` is a `CodecError` — including platform errors (atob, decrypt) which must be normalised.
- Token **flows** (building token frames, basket internalize, overlay drain) are NOT built in this app — do not add UI, storage, or drain code for tokens. Codec/verify support only.
- No regtest/svnode compatibility anywhere; Arcade responses are the only broadcast contract.
- Tests live in `__tests__/`, run with `npx jest <file> --silent`. Commit after every green task, conventional-commit style (`feat(pay): …` / `fix(pay): …` / `test(pay): …`).

---

### Task 1: Sealed envelope in the codec

**Files:**
- Modify: `utils/localpay/codec.ts` (append after `decodeFrame`, ~line 128)
- Test: `__tests__/localpayCodec.test.ts` (append a new `describe`)

**Interfaces:**
- Consumes: existing `encodeFrame`/`decodeFrame`, `CodecError`.
- Produces: `SEAL_VERSION = 1`; `sealFrame(f: PaymentFrame, psk: Uint8Array): Uint8Array`; `unsealFrame(b: Uint8Array, psk: Uint8Array): PaymentFrame`. Task 5 wires these through transports; Task 2 changes the `PaymentFrame` type they carry (sealing is byte-level, so Task 2 does not change this code).

- [ ] **Step 1: Write the failing tests**

Append to `__tests__/localpayCodec.test.ts` (inside the file, new top-level describe; reuse the existing `sample()` helper):

```ts
import { sealFrame, unsealFrame, SEAL_VERSION } from '@/utils/localpay/codec'

describe('sealed envelope', () => {
  const psk = new Uint8Array(32).fill(7)

  it('round-trips a frame under the session PSK', () => {
    const f = sample()
    expect(unsealFrame(sealFrame(f, psk), psk)).toEqual(f)
  })

  it('starts with SEAL_VERSION and is ciphertext, not a readable frame', () => {
    const sealed = sealFrame(sample(), psk)
    expect(sealed[0]).toBe(SEAL_VERSION)
    // 1 version byte + 32B IV + ciphertext + 16B tag
    expect(sealed.length).toBe(1 + 32 + encodeFrame(sample()).length + 16)
    expect(() => decodeFrame(sealed)).toThrow(CodecError) // reads version 1 → unsupported
  })

  it('refuses the wrong PSK as a CodecError, not a platform error', () => {
    const other = new Uint8Array(32).fill(8)
    expect(() => unsealFrame(sealFrame(sample(), psk), other)).toThrow(CodecError)
  })

  it('refuses a tampered body', () => {
    const sealed = sealFrame(sample(), psk)
    sealed[40] ^= 0xff
    expect(() => unsealFrame(sealed, psk)).toThrow(CodecError)
  })

  it('refuses an unknown seal version', () => {
    const sealed = sealFrame(sample(), psk)
    sealed[0] = 2
    expect(() => unsealFrame(sealed, psk)).toThrow(/unsupported seal version 2/)
  })

  it('refuses a PSK that is not 32 bytes', () => {
    expect(() => sealFrame(sample(), new Uint8Array(16))).toThrow(CodecError)
    expect(() => unsealFrame(sealFrame(sample(), psk), new Uint8Array(16))).toThrow(CodecError)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest __tests__/localpayCodec.test.ts --silent`
Expected: FAIL — `sealFrame is not a function` (module has no such export).

- [ ] **Step 3: Implement the envelope**

Append to `utils/localpay/codec.ts` after `decodeFrame` (import goes at the top of the file — this is the codec's first import; keep it the only one):

```ts
import { SymmetricKey } from '@bsv/sdk'
```

```ts
// ── Sealed envelope ──
//
// Every frame that leaves the device is sealed with the session PSK — radios
// and QR alike. On the radios this is redundant with TLS-PSK/Nearby link
// encryption and costs 49 bytes; the point is ONE wire shape, so the QR rung
// (line-of-sight readable) can never be the unsealed exception. AES-256-GCM
// via @bsv/sdk SymmetricKey: |32B IV|ciphertext|16B tag|, behind one version
// byte so an old decoder reads `1`, says `unsupported frame version 1`, and
// refuses cleanly.
//
// Only line of sight is closed: whoever photographed the PAIRING QR holds
// this PSK. That threat was noted-not-mitigated in the 07-27 design and is
// unchanged here.

export const SEAL_VERSION = 1

function pskKey(psk: Uint8Array): SymmetricKey {
  if (psk.length !== 32) throw new CodecError(`psk must be 32 bytes, got ${psk.length}`)
  return new SymmetricKey(Array.from(psk))
}

export function sealFrame(f: PaymentFrame, psk: Uint8Array): Uint8Array {
  const ct = pskKey(psk).encrypt(Array.from(encodeFrame(f))) as number[]
  return new Uint8Array([SEAL_VERSION, ...ct])
}

export function unsealFrame(b: Uint8Array, psk: Uint8Array): PaymentFrame {
  if (b.length < 1 + 32 + 16) throw new CodecError('sealed frame too short')
  if (b[0] !== SEAL_VERSION) throw new CodecError(`unsupported seal version ${b[0]}`)
  let plain: number[]
  try {
    plain = pskKey(psk).decrypt(Array.from(b.slice(1))) as number[]
  } catch {
    // GCM tag mismatch (wrong PSK or tampering) throws a platform error;
    // callers of this codec catch exactly one failure type.
    throw new CodecError('sealed frame failed authentication')
  }
  return decodeFrame(new Uint8Array(plain))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest __tests__/localpayCodec.test.ts --silent`
Expected: PASS (all existing + new).

- [ ] **Step 5: Commit**

```bash
git add utils/localpay/codec.ts __tests__/localpayCodec.test.ts
git commit -m "feat(pay): seal payment frames with the session PSK (AES-256-GCM envelope)"
```

---

### Task 2: PaymentFrame v3 — kind discriminator and token block

**Files:**
- Modify: `utils/localpay/codec.ts` (interface at :10-33, `encodeFrame` :102-113, `decodeFrame` :115-128, `FRAME_VERSION` :1)
- Modify: `utils/localpay/build.ts` (frame literal ~:170-175 gains `kind: 'bsv'`)
- Test: `__tests__/localpayCodec.test.ts`

**Interfaces:**
- Consumes: Task 1's seal (unchanged — it wraps whatever `encodeFrame` emits).
- Produces:
  ```ts
  export const FRAME_VERSION = 3
  export type FrameKind = 'bsv' | 'token'
  export interface TokenPayment {
    assetId: string                 // "<64-hex txid>.<vout>"
    overlayUrl: string
    overlayIdentityKey: string      // 66-hex compressed pubkey
    certificates: Uint8Array[]      // opaque serialized VerifiableCertificates
    linkage: Array<{ txid: string; payload: Uint8Array }> // per-txid MandalaLinkagePayload bytes, whole chain
    recipientLinkage: Uint8Array    // JSON SpecificLinkage bytes, verifier = payee
  }
  export interface PaymentFrame {
    version: number
    kind: FrameKind
    senderIdentityKey: string
    outputIndex: number
    derivationPrefix: string
    derivationSuffix: string
    token?: TokenPayment            // present iff kind === 'token'
    transaction: Uint8Array
  }
  ```
  Task 4 (verify) and Task 5 (wiring) rely on these exact names.

- [ ] **Step 1: Update existing fixtures and write the failing tests**

In `__tests__/localpayCodec.test.ts`: add `kind: 'bsv' as const,` to the existing `sample()` helper (line ~15, beside `version`). Then append:

```ts
import type { TokenPayment } from '@/utils/localpay/codec'

const tokenSample = (): PaymentFrame => ({
  ...sample(),
  kind: 'token',
  token: {
    assetId: 'ab'.repeat(32) + '.0',
    overlayUrl: 'https://overlay.issuer.example',
    overlayIdentityKey: '03'.padEnd(66, 'b'),
    certificates: [new Uint8Array([9, 9, 9]), new Uint8Array([])],
    linkage: [
      { txid: 'cd'.repeat(32), payload: new Uint8Array([1, 2, 3]) },
      { txid: 'ef'.repeat(32), payload: new Uint8Array([4]) },
    ],
    recipientLinkage: new Uint8Array([5, 6]),
  } satisfies TokenPayment,
})

describe('frame v3 kinds', () => {
  it('round-trips a bsv frame with kind preserved', () => {
    const decoded = decodeFrame(encodeFrame(sample()))
    expect(decoded.kind).toBe('bsv')
    expect(decoded.token).toBeUndefined()
    expect(decoded).toEqual(sample())
  })

  it('round-trips a token frame with every token field intact', () => {
    expect(decodeFrame(encodeFrame(tokenSample()))).toEqual(tokenSample())
  })

  it('seals and unseals a token frame', () => {
    const psk = new Uint8Array(32).fill(7)
    expect(unsealFrame(sealFrame(tokenSample(), psk), psk)).toEqual(tokenSample())
  })

  it('rejects a v2 frame: fail-closed versioning', () => {
    const bytes = encodeFrame(sample())
    bytes[0] = 2
    expect(() => decodeFrame(bytes)).toThrow(/unsupported frame version 2/)
  })

  it('rejects an unknown kind byte', () => {
    const bytes = encodeFrame(sample())
    bytes[1] = 0x03
    expect(() => decodeFrame(bytes)).toThrow(/unsupported frame kind 3/)
  })

  it('refuses to encode kind token without a token block, and kind bsv with one', () => {
    expect(() => encodeFrame({ ...sample(), kind: 'token' })).toThrow(CodecError)
    expect(() => encodeFrame({ ...sample(), token: tokenSample().token })).toThrow(CodecError)
  })

  it('refuses malformed token fields at encode', () => {
    const bad = (patch: Partial<TokenPayment>) =>
      encodeFrame({ ...tokenSample(), token: { ...tokenSample().token!, ...patch } })
    expect(() => bad({ overlayIdentityKey: '03short' })).toThrow(CodecError)
    expect(() => bad({ linkage: [{ txid: 'zz', payload: new Uint8Array([1]) }] })).toThrow(CodecError)
  })

  it('still rejects trailing bytes after a token frame', () => {
    const bytes = encodeFrame(tokenSample())
    const padded = new Uint8Array([...bytes, 0])
    expect(() => decodeFrame(padded)).toThrow(/trailing bytes/)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest __tests__/localpayCodec.test.ts --silent`
Expected: FAIL — type error on `kind` / `unsupported frame version` mismatches (v2 still current).

- [ ] **Step 3: Implement frame v3**

In `utils/localpay/codec.ts`:

1. Line 1: `export const FRAME_VERSION = 3`.
2. Replace the `PaymentFrame` interface (:10-33) with the `FrameKind`/`TokenPayment`/`PaymentFrame` definitions from this task's **Produces** block, keeping the existing doc comments on `outputIndex` and `transaction` verbatim, and adding above `token`:
   ```ts
   /**
    * Present iff kind === 'token'. Carried opaquely: the codec validates
    * shapes and lengths, never parses linkage payloads or certificates.
    * `linkage` maps EVERY unbroadcast token transaction in `transaction`'s
    * ancestry to the exact offChainValues bytes its issuer overlay consumes —
    * forwarded verbatim on chained re-spends so whoever reconnects first can
    * submit the whole chain.
    */
   ```
3. Add kind byte constants above `encodeFrame`:
   ```ts
   const KIND_BYTE: Record<FrameKind, number> = { bsv: 0x01, token: 0x02 }
   ```
4. Replace `encodeFrame` with:
   ```ts
   export function encodeFrame(f: PaymentFrame): Uint8Array {
     if (f.senderIdentityKey.length !== 66) {
       throw new CodecError(`senderIdentityKey must be 66 hex chars, got ${f.senderIdentityKey.length}`)
     }
     if ((f.kind === 'token') !== (f.token !== undefined)) {
       throw new CodecError(`kind ${f.kind} and token block presence disagree`)
     }
     const out: number[] = [f.version & 0xff, KIND_BYTE[f.kind] ?? 0]
     if (out[1] === 0) throw new CodecError(`unsupported frame kind ${String(f.kind)}`)
     for (const byte of hexToBytes(f.senderIdentityKey.toLowerCase())) out.push(byte)
     putVarint(out, f.outputIndex)
     putStr(out, f.derivationPrefix)
     putStr(out, f.derivationSuffix)
     if (f.token) {
       const t = f.token
       if (t.overlayIdentityKey.length !== 66) {
         throw new CodecError(`overlayIdentityKey must be 66 hex chars, got ${t.overlayIdentityKey.length}`)
       }
       putStr(out, t.assetId)
       putStr(out, t.overlayUrl)
       for (const byte of hexToBytes(t.overlayIdentityKey.toLowerCase())) out.push(byte)
       putVarint(out, t.certificates.length)
       for (const cert of t.certificates) putBytes(out, cert)
       putVarint(out, t.linkage.length)
       for (const entry of t.linkage) {
         if (entry.txid.length !== 64) throw new CodecError(`linkage txid must be 64 hex chars, got ${entry.txid.length}`)
         for (const byte of hexToBytes(entry.txid.toLowerCase())) out.push(byte)
         putBytes(out, entry.payload)
       }
       putBytes(out, t.recipientLinkage)
     }
     putBytes(out, f.transaction)
     return new Uint8Array(out)
   }
   ```
5. Replace `decodeFrame` with (minimum length is now 35: version + kind + pubkey):
   ```ts
   export function decodeFrame(b: Uint8Array): PaymentFrame {
     if (b.length < 35) throw new CodecError('frame too short')
     const version = b[0]
     if (version !== FRAME_VERSION) throw new CodecError(`unsupported frame version ${version}`)
     const kindByte = b[1]
     const kind: FrameKind | undefined = kindByte === 0x01 ? 'bsv' : kindByte === 0x02 ? 'token' : undefined
     if (kind === undefined) throw new CodecError(`unsupported frame kind ${kindByte}`)
     const pos = { i: 2 }
     const senderIdentityKey = bytesToHex(b.slice(pos.i, pos.i + 33))
     pos.i += 33
     const outputIndex = getVarint(b, pos)
     const derivationPrefix = getStr(b, pos)
     const derivationSuffix = getStr(b, pos)
     let token: TokenPayment | undefined
     if (kind === 'token') {
       const assetId = getStr(b, pos)
       const overlayUrl = getStr(b, pos)
       if (pos.i + 33 > b.length) throw new CodecError('truncated overlayIdentityKey')
       const overlayIdentityKey = bytesToHex(b.slice(pos.i, pos.i + 33))
       pos.i += 33
       const certificates: Uint8Array[] = []
       const certCount = getVarint(b, pos)
       for (let c = 0; c < certCount; c++) certificates.push(getBytes(b, pos))
       const linkage: Array<{ txid: string; payload: Uint8Array }> = []
       const linkCount = getVarint(b, pos)
       for (let l = 0; l < linkCount; l++) {
         if (pos.i + 32 > b.length) throw new CodecError('truncated linkage txid')
         const txid = bytesToHex(b.slice(pos.i, pos.i + 32))
         pos.i += 32
         linkage.push({ txid, payload: getBytes(b, pos) })
       }
       const recipientLinkage = getBytes(b, pos)
       token = { assetId, overlayUrl, overlayIdentityKey, certificates, linkage, recipientLinkage }
     }
     const transaction = getBytes(b, pos)
     if (pos.i !== b.length) throw new CodecError('trailing bytes after frame')
     return {
       version, kind, senderIdentityKey, outputIndex, derivationPrefix, derivationSuffix,
       ...(token === undefined ? {} : { token }),
       transaction,
     }
   }
   ```
6. In `utils/localpay/build.ts`, find the frame literal returned by `buildPaymentFrame` (~line 170, the object with `version: FRAME_VERSION, senderIdentityKey, outputIndex, derivationPrefix, derivationSuffix, transaction`) and add `kind: 'bsv' as const,` beside `version`.

- [ ] **Step 4: Run the full localpay suite — other fixtures will need `kind`**

Run: `npx jest __tests__/localpayCodec.test.ts __tests__/localpayBuild.test.ts __tests__/localpayVerify.test.ts __tests__/localpayTransportAwdl.test.ts __tests__/localpayPending.test.ts --silent`
Expected: codec PASSES; any other file constructing a `PaymentFrame` literal fails compilation — add `kind: 'bsv' as const,` to each such fixture (they are test-local `sample()`/`frame` helpers). Also check `__tests__/localpayBuild.test.ts` asserts on the built frame: it must now expect `kind: 'bsv'`. Re-run until all green.

- [ ] **Step 5: Typecheck the app**

Run: `npx tsc --noEmit`
Expected: clean. Any remaining error is a `PaymentFrame` literal somewhere missing `kind` — fix it the same way (production code constructs frames only in `build.ts`).

- [ ] **Step 6: Commit**

```bash
git add utils/localpay/codec.ts utils/localpay/build.ts __tests__/
git commit -m "feat(pay): PaymentFrame v3 — kind discriminator and BRC-92 token block"
```

---

### Task 3: Session `asset` block and CAP_BLE

**Files:**
- Modify: `utils/localpay/session.ts` (constants :4-6, `Session` :10-37, `mintSession` :39-67, `encodeSession` :93-109, `decodeSession` :111-156)
- Test: `__tests__/localpaySession.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const CAP_BLE = 0x04
  export interface SessionAsset {
    id: string                 // "<64-hex txid>.<vout>"
    label?: string
    ticker?: string
    decimals?: number
    overlayUrl: string
    overlayIdentityKey: string // 66-hex
  }
  // Session gains: asset?: SessionAsset  (amount is BASE UNITS of the asset when present)
  // mintSession args gain: asset?: SessionAsset
  ```
  Wire: `t: { i, n, s, d, u, k }` for id/label(name)/ticker(symbol)/decimals/overlayUrl/overlayIdentityKey. Session version stays 1.

- [ ] **Step 1: Write the failing tests**

Append to `__tests__/localpaySession.test.ts` (reuse its existing mint helper/args; if it has a `mintArgs()`-style helper, spread it):

```ts
import { CAP_BLE, type SessionAsset } from '@/utils/localpay/session'

const asset = (): SessionAsset => ({
  id: 'ab'.repeat(32) + '.0',
  label: 'Example Dollar',
  ticker: 'EXD',
  decimals: 2,
  overlayUrl: 'https://overlay.issuer.example',
  overlayIdentityKey: '03'.padEnd(66, 'b'),
})

describe('session asset block', () => {
  it('round-trips a token request with amount in base units', () => {
    const s = mintSession({ ...baseMintArgs(), amount: 12345, asset: asset() })
    const decoded = decodeSession(encodeSession(s))
    expect(decoded.asset).toEqual(asset())
    expect(decoded.amount).toBe(12345)
    expect(decoded.version).toBe(1)
  })

  it('round-trips an asset without optional display fields', () => {
    const bare = { id: asset().id, overlayUrl: asset().overlayUrl, overlayIdentityKey: asset().overlayIdentityKey }
    const s = mintSession({ ...baseMintArgs(), asset: bare })
    expect(decodeSession(encodeSession(s)).asset).toEqual(bare)
  })

  it('omits t entirely for a BSV session', () => {
    const s = mintSession(baseMintArgs())
    expect(decodeSession(encodeSession(s)).asset).toBeUndefined()
    expect(encodeSession(s)).not.toContain('"t"')
  })

  it('refuses a malformed asset at decode', () => {
    const s = mintSession({ ...baseMintArgs(), asset: asset() })
    const raw = JSON.parse(new TextDecoder().decode(b64urlToBytes(encodeSession(s).slice('bsvpay1:'.length))))
    raw.t.k = 'short'
    const forged = 'bsvpay1:' + bytesToB64url(new TextEncoder().encode(JSON.stringify(raw)))
    expect(() => decodeSession(forged)).toThrow(CodecError)
  })

  it('CAP_BLE is allocated and unknown-to-us bits survive decode', () => {
    expect(CAP_BLE).toBe(0x04)
    const s = mintSession(baseMintArgs())
    const raw = JSON.parse(new TextDecoder().decode(b64urlToBytes(encodeSession(s).slice('bsvpay1:'.length))))
    raw.c = (raw.c ?? 0) | CAP_BLE
    const forged = 'bsvpay1:' + bytesToB64url(new TextEncoder().encode(JSON.stringify(raw)))
    expect(decodeSession(forged).caps & CAP_BLE).toBe(CAP_BLE)
  })
})
```

If the test file already has a mint-args helper, reuse it as `baseMintArgs`. Otherwise add these at the top of the new describe:

```ts
const baseMintArgs = () => ({
  identityKey: '02'.padEnd(66, 'd'),
  derivationPrefix: 'cA',
  derivationSuffix: 'cw',
  supportsAwdl: true,
})
const bytesToB64url = (b: Uint8Array) => {
  let s = ''
  for (const byte of b) s += String.fromCharCode(byte)
  return globalThis.btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const b64urlToBytes = (s: string) => {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/')
  return Uint8Array.from(globalThis.atob(pad + '='.repeat((4 - (pad.length % 4)) % 4)), c => c.charCodeAt(0))
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest __tests__/localpaySession.test.ts --silent`
Expected: FAIL — `CAP_BLE` not exported / `asset` unknown property.

- [ ] **Step 3: Implement**

In `utils/localpay/session.ts`:

1. After `CAP_NEARBY` (:6): `export const CAP_BLE = 0x04 // allocated for BLE transports (e.g. Blitz); this app never advertises it`.
2. Add `SessionAsset` interface above `Session`, with doc comment:
   ```ts
   /**
    * The asset a token request names. When present on a Session, `amount` is
    * BASE UNITS of this asset, not satoshis, and remains a binding term.
    * label/ticker/decimals are payee-supplied display hints; overlayUrl and
    * overlayIdentityKey are the issuer endpoints a payer needs to mint
    * linkage blobs and (later) submit the transfer — no per-asset discovery
    * protocol exists, so the request carries them.
    */
   export interface SessionAsset {
     id: string
     label?: string
     ticker?: string
     decimals?: number
     overlayUrl: string
     overlayIdentityKey: string
   }
   ```
3. `Session` gains `asset?: SessionAsset` after `amount`; `mintSession` args gain `asset?: SessionAsset`; the mint body spreads it exactly like `amount`:
   ```ts
   ...(args.asset === undefined ? {} : { asset: args.asset }),
   ```
   and validates at mint: `if (args.asset !== undefined && args.asset.overlayIdentityKey.length !== 66) throw new CodecError('bad asset overlayIdentityKey')`.
4. `encodeSession` body object gains (after the `a` spread):
   ```ts
   ...(s.asset === undefined ? {} : {
     t: {
       i: s.asset.id,
       ...(s.asset.label === undefined ? {} : { n: s.asset.label }),
       ...(s.asset.ticker === undefined ? {} : { s: s.asset.ticker }),
       ...(s.asset.decimals === undefined ? {} : { d: s.asset.decimals }),
       u: s.asset.overlayUrl,
       k: s.asset.overlayIdentityKey,
     },
   }),
   ```
5. `decodeSession`: destructure `t` alongside the others; after the `os` line add:
   ```ts
   let asset: SessionAsset | undefined
   if (t !== undefined) {
     if (typeof t !== 'object' || t === null) throw new CodecError('bad asset block')
     const { i: ai, n, s: tick, d, u, k: ok } = t as Record<string, unknown>
     if (typeof ai !== 'string' || ai.length < 66 || !ai.includes('.')) throw new CodecError('bad assetId')
     if (typeof u !== 'string' || u.length === 0) throw new CodecError('bad overlayUrl')
     if (typeof ok !== 'string' || ok.length !== 66) throw new CodecError('bad overlayIdentityKey')
     if (n !== undefined && typeof n !== 'string') throw new CodecError('bad asset label')
     if (tick !== undefined && typeof tick !== 'string') throw new CodecError('bad asset ticker')
     if (d !== undefined && (typeof d !== 'number' || !Number.isSafeInteger(d) || d < 0)) throw new CodecError('bad asset decimals')
     asset = {
       id: ai, overlayUrl: u, overlayIdentityKey: ok,
       ...(n === undefined ? {} : { label: n }),
       ...(tick === undefined ? {} : { ticker: tick }),
       ...(d === undefined ? {} : { decimals: d }),
     }
   }
   ```
   and the return spreads `...(asset === undefined ? {} : { asset }),` after `amount`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest __tests__/localpaySession.test.ts __tests__/localpayTransportSelect.test.ts --silent`
Expected: PASS. (`selectTransport` masks specific bits, so CAP_BLE needs no change there — the select test run is the proof.)

- [ ] **Step 5: Commit**

```bash
git add utils/localpay/session.ts __tests__/localpaySession.test.ts
git commit -m "feat(pay): session asset block for token requests, CAP_BLE capability bit"
```

---

### Task 4: Token verify branch (`@bsv/templates`) and recipient-linkage check

**Files:**
- Modify: `package.json` (add dependency), `utils/localpay/verify.ts`
- Test: `__tests__/localpayVerify.test.ts`

**Interfaces:**
- Consumes: `PaymentFrame`/`TokenPayment` from Task 2.
- Produces:
  ```ts
  export const FT_PROTOCOL_ID: [2, string] = [2, 'mandala token']
  export type VerifiedPayment =
    | { kind: 'bsv'; satoshis: number }
    | { kind: 'token'; assetId: string; amount: number }
  // verifyFramePayment(wallet, frame, originator): Promise<VerifiedPayment>  (was { satoshis })
  export interface LinkageDecryptingWallet {
    decrypt(args: unknown, originator?: string): Promise<{ plaintext: number[] }>
  }
  export async function verifyRecipientLinkage(
    wallet: LinkageDecryptingWallet,
    recipientLinkage: Uint8Array,
    expectedPubKeyHash: number[],
    originator: string
  ): Promise<void> // throws FrameVerifyError('not_mine') on any mismatch
  ```

- [ ] **Step 1: Install the dependency**

Run: `npm install @bsv/templates@^1.9.6`
Expected: clean install (peer `@bsv/sdk ^2.1.6` is satisfied by the app's 2.1.9).

- [ ] **Step 2: Write the failing tests**

Append to `__tests__/localpayVerify.test.ts` (it already builds real BEEFs via its `beefOf` helper and mocks `getPublicKey` — reuse both):

```ts
import { MandalaToken } from '@bsv/templates'
import { BigNumber, Curve, Hash, PublicKey, Utils } from '@bsv/sdk'
import { FT_PROTOCOL_ID, verifyRecipientLinkage } from '@/utils/localpay/verify'

const ASSET_ID = 'ab'.repeat(32) + '.0'
const payeePkh = () => Hash.hash160(Utils.toArray(payeeKey.toString(), 'hex'))

function tokenScript(amount: number, pkh: number[] = payeePkh()): string {
  return new MandalaToken().lock(ASSET_ID, amount, pkh).toHex()
}

const tokenFrame = (overrides: Partial<PaymentFrame> = {}): PaymentFrame => ({
  version: 3,
  kind: 'token',
  senderIdentityKey,
  outputIndex: 0,
  derivationPrefix: 'p',
  derivationSuffix: 'x',
  token: {
    assetId: ASSET_ID,
    overlayUrl: 'https://overlay.issuer.example',
    overlayIdentityKey: '03'.padEnd(66, 'b'),
    certificates: [],
    linkage: [],
    recipientLinkage: new Uint8Array([1]),
  },
  transaction: beefOf([{ satoshis: 1, scriptHex: tokenScript(500) }]),
  ...overrides,
})

describe('verifyFramePayment: token kind', () => {
  it('returns the decoded token amount and assetId for an output locked to this device', async () => {
    const result = await verifyFramePayment(walletReturning(payeeKey.toString()), tokenFrame(), 'test')
    expect(result).toEqual({ kind: 'token', assetId: ASSET_ID, amount: 500 })
  })

  it('derives with the mandala FT protocol, not PEERPAY', async () => {
    const wallet = walletReturning(payeeKey.toString())
    await verifyFramePayment(wallet, tokenFrame(), 'test')
    expect(wallet.getPublicKey).toHaveBeenCalledWith(
      expect.objectContaining({ protocolID: FT_PROTOCOL_ID, forSelf: true }),
      'test'
    )
  })

  it('refuses a token output locked to someone else as not_mine', async () => {
    const otherPkh = Hash.hash160(Utils.toArray('02'.padEnd(66, 'c'), 'hex'))
    const frame = tokenFrame({ transaction: beefOf([{ satoshis: 1, scriptHex: tokenScript(500, otherPkh) }]) })
    await expect(verifyFramePayment(walletReturning(payeeKey.toString()), frame, 'test'))
      .rejects.toMatchObject({ kind: 'not_mine' })
  })

  it('refuses an output whose script assetId disagrees with the frame', async () => {
    const frame = tokenFrame()
    frame.token!.assetId = 'cd'.repeat(32) + '.1'
    await expect(verifyFramePayment(walletReturning(payeeKey.toString()), frame, 'test'))
      .rejects.toMatchObject({ kind: 'not_mine' })
  })

  it('refuses a non-token script under kind token as not_mine', async () => {
    const frame = tokenFrame({ transaction: beefOf([{ satoshis: 1, scriptHex: minesScript() }]) })
    await expect(verifyFramePayment(walletReturning(payeeKey.toString()), frame, 'test'))
      .rejects.toMatchObject({ kind: 'not_mine' })
  })
})

describe('verifyRecipientLinkage', () => {
  const scalar = new Uint8Array(32).fill(3)
  const counterpartyKey = PrivateKey.fromRandom().toPublicKey()

  function derivedPkh(): number[] {
    const curve = new Curve()
    const sum = counterpartyKey.add(curve.g.mul(new BigNumber(Array.from(scalar))))
    const derived = new PublicKey(sum.x, sum.y)
    return Hash.hash160(Utils.toArray(derived.toString(), 'hex'))
  }

  const linkageBytes = () => new TextEncoder().encode(JSON.stringify({
    prover: senderIdentityKey,
    verifier: payeeKey.toString(),
    counterparty: counterpartyKey.toString(),
    protocolID: FT_PROTOCOL_ID,
    keyID: 'p x',
    encryptedLinkage: [1, 2, 3],
    encryptedLinkageProof: [0],
    proofType: 0,
  }))

  const decryptingWallet = () => ({
    decrypt: jest.fn().mockResolvedValue({ plaintext: Array.from(scalar) }),
  })

  it('accepts when the recovered key hashes to the expected pkh', async () => {
    await expect(verifyRecipientLinkage(decryptingWallet(), linkageBytes(), derivedPkh(), 'test'))
      .resolves.toBeUndefined()
  })

  it('decrypts under the mirrored specific-linkage-revelation protocol', async () => {
    const wallet = decryptingWallet()
    await verifyRecipientLinkage(wallet, linkageBytes(), derivedPkh(), 'test')
    expect(wallet.decrypt).toHaveBeenCalledWith(
      expect.objectContaining({
        protocolID: [2, 'specific linkage revelation 2 mandala token'],
        keyID: 'p x',
        counterparty: senderIdentityKey,
      }),
      'test'
    )
  })

  it('refuses a pkh mismatch as not_mine', async () => {
    await expect(verifyRecipientLinkage(decryptingWallet(), linkageBytes(), payeePkh(), 'test'))
      .rejects.toMatchObject({ kind: 'not_mine' })
  })

  it('refuses unparseable linkage bytes', async () => {
    await expect(verifyRecipientLinkage(decryptingWallet(), new Uint8Array([0xff]), derivedPkh(), 'test'))
      .rejects.toMatchObject({ kind: 'unparseable' })
  })
})
```

(`walletReturning` — if the file's existing mock helper has a different name, use that name; it is the mock whose `getPublicKey` resolves `{ publicKey: <arg> }`.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx jest __tests__/localpayVerify.test.ts --silent`
Expected: FAIL — `FT_PROTOCOL_ID` not exported; existing bsv tests may also fail on the changed return shape once implementation starts, which Step 5 covers.

- [ ] **Step 4: Implement**

In `utils/localpay/verify.ts`:

1. Add imports: `import { BigNumber, Curve, Hash, PublicKey, Utils } from '@bsv/sdk'` (extend the existing import line) and `import { MandalaToken } from '@bsv/templates'`.
2. Export the protocol and result types from **Produces**. `FT_PROTOCOL_ID` gets a comment: `// mandala's FT derivation protocol — the payer locks token outputs under it with OUR payee-minted nonces as keyID, preserving the frame-to-session binding`.
3. In `verifyFramePayment`, after the `output` existence check, branch on `frame.kind`:
   - `kind === 'bsv'`: the existing derivation/P2PKH/satoshi logic verbatim, returning `{ kind: 'bsv', satoshis: output.satoshis }`.
   - `kind === 'token'` (guard `if (!frame.token) throw new FrameVerifyError('unparseable', 'token frame without token block')`):
     ```ts
     let decoded: { assetId: string; amount: number; pubKeyHash: number[] }
     try {
       decoded = MandalaToken.decode(output.lockingScript)
     } catch (e) {
       throw new FrameVerifyError('not_mine', `the named output is not a token script: ${messageOf(e)}`)
     }
     if (decoded.assetId !== frame.token.assetId) {
       throw new FrameVerifyError('not_mine', 'the output moves a different asset than the frame declares')
     }
     const { publicKey } = await wallet.getPublicKey(
       {
         protocolID: FT_PROTOCOL_ID,
         keyID: `${frame.derivationPrefix} ${frame.derivationSuffix}`,
         counterparty: frame.senderIdentityKey,
         forSelf: true
       },
       originator
     )
     const expectedPkh = Hash.hash160(Utils.toArray(publicKey, 'hex'))
     const mine = decoded.pubKeyHash.length === expectedPkh.length &&
       decoded.pubKeyHash.every((b, i) => b === expectedPkh[i])
     if (!mine) throw new FrameVerifyError('not_mine', 'the named token output does not pay this device')
     if (!Number.isSafeInteger(decoded.amount) || decoded.amount < 1) {
       throw new FrameVerifyError('not_mine', `the named output carries no usable token amount: ${decoded.amount}`)
     }
     return { kind: 'token', assetId: decoded.assetId, amount: decoded.amount }
     ```
4. Add `LinkageDecryptingWallet` and `verifyRecipientLinkage` (a port of `@bsv/overlay-topics` `verifyKeyLinkage`, kept local so the future package needs only `@bsv/sdk`):
   ```ts
   /**
    * Prove the payer minted honest linkage for OUR output: decrypt the
    * BRC-72 blob (we are its verifier), recover derivedKey = counterparty +
    * L·G, and require its hash160 to equal the output's pubKeyHash. This
    * shows the payer CAN produce valid linkage — the overlay's own verdict
    * at submission remains the real admission gate.
    */
   export async function verifyRecipientLinkage(
     wallet: LinkageDecryptingWallet,
     recipientLinkage: Uint8Array,
     expectedPubKeyHash: number[],
     originator: string
   ): Promise<void> {
     let linkage: {
       prover: string; counterparty: string
       protocolID: [number, string]; keyID: string; encryptedLinkage: number[]
     }
     try {
       const parsed = JSON.parse(new TextDecoder().decode(recipientLinkage)) as Record<string, unknown>
       if (
         typeof parsed.prover !== 'string' || typeof parsed.counterparty !== 'string' ||
         !Array.isArray(parsed.protocolID) || typeof parsed.keyID !== 'string' ||
         !Array.isArray(parsed.encryptedLinkage)
       ) throw new Error('missing linkage fields')
       linkage = parsed as typeof linkage
     } catch (e) {
       throw new FrameVerifyError('unparseable', `recipientLinkage is not a readable SpecificLinkage: ${messageOf(e)}`)
     }
     let plaintext: number[]
     try {
       ;({ plaintext } = await wallet.decrypt(
         {
           ciphertext: linkage.encryptedLinkage,
           protocolID: [2, `specific linkage revelation ${linkage.protocolID[0]} ${linkage.protocolID[1]}`],
           keyID: linkage.keyID,
           counterparty: linkage.prover
         },
         originator
       ))
     } catch (e) {
       throw new FrameVerifyError('not_mine', `recipientLinkage did not decrypt for this device: ${messageOf(e)}`)
     }
     const curve = new Curve()
     const sum = PublicKey.fromString(linkage.counterparty).add(curve.g.mul(new BigNumber(plaintext)))
     const derivedPkh = Hash.hash160(Utils.toArray(new PublicKey(sum.x, sum.y).toString(), 'hex'))
     const matches = derivedPkh.length === expectedPubKeyHash.length &&
       derivedPkh.every((b, i) => b === expectedPubKeyHash[i])
     if (!matches) throw new FrameVerifyError('not_mine', 'recipientLinkage does not control the paid output')
   }
   ```

- [ ] **Step 5: Fix the bsv-path callers of the changed return type**

Run: `npx tsc --noEmit`
Expected errors where `{ satoshis }` was destructured from `verifyFramePayment`: `components/pay/NearbyFlow.tsx` (settle path, ~:583-638) and existing tests. In NearbyFlow, the result is bsv-kind by construction today — change the destructure to:
```ts
const verified = await verifyFramePayment(...)
if (verified.kind !== 'bsv') {
  // This app's settle path only credits BSV payments today; a token frame
  // is refused before anything latches, exactly like a session mismatch.
  void confirm?.(false, 'session_mismatch')
  return
}
const satoshis = verified.satoshis
```
Update existing verify tests asserting `{ satoshis: n }` to `{ kind: 'bsv', satoshis: n }`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx jest __tests__/localpayVerify.test.ts --silent && npx tsc --noEmit`
Expected: PASS, clean typecheck.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json utils/localpay/verify.ts components/pay/NearbyFlow.tsx __tests__/localpayVerify.test.ts
git commit -m "feat(pay): token verify branch via @bsv/templates MandalaToken + recipient-linkage proof"
```

---

### Task 5: Thread the seal through radios, QR, and storage envelope

**Files:**
- Modify: `utils/localpay/transport/socket.ts` (:2 import, :152 receive, :196 send)
- Modify: `utils/localpay/codec.ts` (`frameToQr` :190-193 signature)
- Modify: `components/pay/NearbyFlow.tsx` (:130-136 imports, :921 scan decode, :1069/:1076, :1099/:1105 size checks + QR set, :1189 hold payload)
- Modify: `utils/pay/rails/nearby.ts` (re-export barrel, ~:16-19)
- Test: `__tests__/localpayTransportAwdl.test.ts`, `__tests__/localpayCodec.test.ts`

**Interfaces:**
- Consumes: `sealFrame`/`unsealFrame` (Task 1), `PaymentFrame` v3 (Task 2).
- Produces: `frameToQr(f: PaymentFrame, psk: Uint8Array): string` (signature change — the stored `framePayload` envelope now contains SEALED bytes). `frameBytesFromQr` is unchanged (opaque bytes out). Transport interface types are unchanged (`send(session, frame, signal)` — sealing is internal).

- [ ] **Step 1: Update the transport tests to speak sealed bytes**

In `__tests__/localpayTransportAwdl.test.ts`: extend the codec import (line 4) to `import { CodecError, FRAME_VERSION, SEAL_VERSION, encodeFrame, sealFrame, unsealFrame, type PaymentFrame } from '@/utils/localpay/codec'`. The file's fixtures (`fakeNative`, `session`, `frame`, `toBase64`, `toAckBase64`) are all module-level — reuse them. Every existing `onFrame(toBase64(encodeFrame(frame)))` becomes `onFrame(toBase64(sealFrame(frame, session.psk)))`. Add two new tests inside the existing describes:

```ts
// in describe('awdlTransport.receive'):
it('declines decode_failed on an UNSEALED frame: raw v3 bytes are not accepted on the wire', async () => {
  const startListening = jest.fn((_name: string, _psk: string, onFrame: (f: string) => void) => {
    onFrame(toBase64(encodeFrame(frame))) // raw, not sealed
    return Promise.resolve()
  })
  const native = fakeNative({ startListening: startListening as never })
  getLocalPayTransport.mockReturnValue(native)

  await expect(awdlTransport.receive(session, new AbortController().signal)).rejects.toThrow(CodecError)
  expect(native.confirmFrame).toHaveBeenCalledWith(false, 'decode_failed')
})

// in describe('awdlTransport.send'):
it('seals outgoing frames: sendFrame carries ciphertext the session PSK opens', async () => {
  const native = fakeNative({ sendFrame: jest.fn().mockResolvedValue(toAckBase64({ ok: true })) })
  getLocalPayTransport.mockReturnValue(native)

  await awdlTransport.send(session, frame, new AbortController().signal)
  const sentBase64 = (native.sendFrame as jest.Mock).mock.calls[0][2] as string
  const sentBytes = Uint8Array.from(globalThis.atob(sentBase64), c => c.charCodeAt(0))
  expect(sentBytes[0]).toBe(SEAL_VERSION)
  expect(unsealFrame(sentBytes, session.psk)).toEqual(frame)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest __tests__/localpayTransportAwdl.test.ts --silent`
Expected: FAIL — receive path still calls `decodeFrame` on raw bytes, so sealed input is declined and unsealed input accepted (inverted expectations).

- [ ] **Step 3: Implement transport sealing**

In `utils/localpay/transport/socket.ts`:
- Line 2: `import { sealFrame, unsealFrame, type PaymentFrame } from '../codec'` (drop `decodeFrame, encodeFrame`).
- Line 152: `frame = unsealFrame(fromBase64(frameBase64), session.psk)`.
- Line 196: `toBase64(sealFrame(frame, session.psk))`.

- [ ] **Step 4: Change `frameToQr` to seal, and update codec tests**

In `utils/localpay/codec.ts` replace `frameToQr`:

```ts
/** Wraps a SEALED frame for storage and later re-display. Rendered as air-gap parts, never as one symbol. */
export function frameToQr(f: PaymentFrame, psk: Uint8Array): string {
  return FRAME_QR_PREFIX + toB64url(sealFrame(f, psk))
}
```

Update the doc comment block above `FRAME_QR_PREFIX` (:130-141): append one sentence — `The envelope's payload is a SEALED frame: re-showing a stored payment yields ciphertext only the live session's PSK opens.`

In `__tests__/localpayCodec.test.ts`, existing `frameToQr`/`frameBytesFromQr` tests gain the psk argument; the round-trip assertion becomes `expect(unsealFrame(frameBytesFromQr(frameToQr(f, psk)), psk)).toEqual(f)`.

- [ ] **Step 5: Update NearbyFlow call sites**

In `components/pay/NearbyFlow.tsx`:
- Imports (:130-136): replace `decodeFrame` with `unsealFrame` and add `sealFrame` (via the same `@/utils/pay/rails/nearby` barrel — see Step 6).
- Scan handler (:921): `frame = unsealFrame(message, session.psk)` (the `session` const is bound at :904 in the same closure; the bare-catch comment stays).
- Send QR path (:1069 and :1076): the size check measures what actually renders, and the set seals —
  ```ts
  if (sealFrame(built.frame, session.psk).length > MAX_MESSAGE_BYTES) {
    // ...existing refusal body unchanged...
  }
  builtRef.current = built
  setPaymentQr(frameToQr(built.frame, session.psk))
  ```
  The radio-fallback block at :1099/:1105 gets the identical change.
- Hold payload (:1189): `framePayload: frameToQr(built.frame, session.psk)`.

Note the size checks now measure the sealed length (+49 bytes) — that is the length that actually renders, so this is a correction, not a regression.

- [ ] **Step 6: Update the rails barrel**

In `utils/pay/rails/nearby.ts` (:16-19 region): the re-export list drops `decodeFrame` if nothing imports it anymore and adds `sealFrame, unsealFrame, SEAL_VERSION`. Run `grep -rn "from '@/utils/pay/rails/nearby'" components/ app/ utils/ --include='*.ts*'` and reconcile every importer.

- [ ] **Step 7: Run the full suite and typecheck**

Run: `npx jest __tests__ --silent && npx tsc --noEmit`
Expected: PASS. Failures to expect and fix: any remaining test importing `frameToQr` with one argument.

- [ ] **Step 8: Commit**

```bash
git add utils/localpay utils/pay/rails/nearby.ts components/pay/NearbyFlow.tsx __tests__
git commit -m "feat(pay): sealed frames on every rung — radios, QR fountain, stored re-show envelope"
```

---

### Task 6: Delete the WoC error-string classification

**Files:**
- Modify: `services/arcadeBroadcastProvider.ts` (`createWocBroadcastService`, the classification at ~:184-192)
- Test: `__tests__/arcadeBroadcastProvider.test.ts`

**Interfaces:**
- Consumes: nothing new. Produces: no API change — `PostTxResultForTxid` shape unchanged; only the mapping changes. Decision 2 from the spec: Arcade's structured `txStatus` stays the sole terminal-verdict source; a WoC body string can mark success for the idempotent same-txid case only, never `doubleSpend`.

- [ ] **Step 1: Write the failing tests**

Append to `__tests__/arcadeBroadcastProvider.test.ts` (this file already parameterizes `handleArcResponse`; the WoC service needs `global.fetch` stubbing — copy the `mockFetchOnce` shape from `__tests__/payAddressRail.test.ts:16-24`):

```ts
import { Beef, Transaction } from '@bsv/sdk'
import { createWocBroadcastService } from '@/services/arcadeBroadcastProvider'

describe('createWocBroadcastService classification', () => {
  // createWocBroadcastService returns { name, service(beef, txids) } —
  // services/arcadeBroadcastProvider.ts:141-155. It reads the LAST tx out of
  // the beef and POSTs its raw hex, so a minimal empty transaction suffices.
  const postOne = async (status: number, body: string) => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
    }) as unknown as typeof fetch
    const tx = new Transaction()
    const beef = new Beef()
    beef.mergeTransaction(tx)
    const { service } = createWocBroadcastService('main')
    return service(beef, [tx.id('hex')])
  }

  it('keeps "already in the mempool" as success (same-txid idempotent rebroadcast)', async () => {
    const r = await postOne(422, 'unexpected response code 500: 257: txn-already-in-mempool already in the mempool')
    expect(r.txidResults[0].status).toBe('success')
    expect(r.txidResults[0].doubleSpend).toBeUndefined()
  })

  it('classifies "Missing inputs" as a retryable serviceError, never doubleSpend', async () => {
    const r = await postOne(422, 'unexpected response code 500: Missing inputs')
    expect(r.txidResults[0].doubleSpend).toBeUndefined()
    expect(r.txidResults[0].serviceError).toBe(true)
  })

  it('classifies "mempool-conflict" as a retryable serviceError, never doubleSpend', async () => {
    const r = await postOne(422, '258: txn-mempool-conflict')
    expect(r.txidResults[0].doubleSpend).toBeUndefined()
    expect(r.txidResults[0].serviceError).toBe(true)
  })
})
```

Before writing the invocation, read `createWocBroadcastService`'s signature at `services/arcadeBroadcastProvider.ts:141` and the surrounding function to call it exactly as production does (it returns the service function the toolbox invokes with `(beef, txids, services)` — mirror that; a minimal `Beef` with one raw tx from the fixtures already in this test file suffices).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest __tests__/arcadeBroadcastProvider.test.ts --silent`
Expected: FAIL — `doubleSpend` is `true` for both Missing-inputs and mempool-conflict cases.

- [ ] **Step 3: Implement the deletion**

In `services/arcadeBroadcastProvider.ts`, the block currently reading:

```ts
if (response.ok) {
  txResult.status = 'success'
} else if (body.includes('already in the mempool')) {
  txResult.status = 'success'
} else if (body.includes('mempool-conflict') || body.includes('Missing inputs')) {
  txResult.doubleSpend = true
} else {
  txResult.serviceError = true
}
```

becomes:

```ts
if (response.ok) {
  txResult.status = 'success'
} else if (body.includes('already in the mempool')) {
  // Idempotent same-txid rebroadcast — a conflicting DIFFERENT tx cannot
  // produce this message, so it can't mask a double-spend.
  txResult.status = 'success'
} else {
  // Never classify from WoC body strings. "Missing inputs" is ambiguous
  // (propagation lag vs mined double-spend) and a wrong terminal verdict
  // cascades to reject descendants. Terminal verdicts come from Arcade's
  // structured txStatus only (handleArcResponse); everything here is
  // retryable, and the release engine's topological order — foreign
  // ancestors included — is what prevents the orphan case at the source.
  txResult.serviceError = true
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest __tests__/arcadeBroadcastProvider.test.ts __tests__/offlinePlan.test.ts __tests__/processOfflineActions.test.ts --silent`
Expected: PASS — the offline-plan suites must stay green untouched (they never depended on the WoC strings; if one did, that test was pinning the bug — update it to expect `serviceError`).

- [ ] **Step 5: Commit**

```bash
git add services/arcadeBroadcastProvider.ts __tests__/arcadeBroadcastProvider.test.ts
git commit -m "fix(pay): stop classifying WoC body strings as double-spends — Arcade txStatus is the only terminal verdict"
```

---

### Task 7: Proof-collection nudge on /pay

**Files:**
- Create: `utils/pay/proofNudge.ts`
- Modify: `app/pay.tsx` (one `useEffect` on mount)
- Test: `__tests__/proofNudge.test.ts`

**Interfaces:**
- Consumes: `runMonitorTask(taskName: string): Promise<string>` from `useWallet()` (`context/WalletContext.tsx:159`); the Monitor task name is `'CheckForProofs'` (see the patch block at `WalletContext.tsx:~1004`).
- Produces: `takeProofNudge(nowMs: number): boolean` (10-minute gate, module-level state), `resetProofNudgeForTests(): void`.

- [ ] **Step 1: Write the failing test**

Create `__tests__/proofNudge.test.ts`:

```ts
import { takeProofNudge, resetProofNudgeForTests, PROOF_NUDGE_MIN_INTERVAL_MS } from '@/utils/pay/proofNudge'

describe('takeProofNudge', () => {
  beforeEach(resetProofNudgeForTests)

  it('grants the first nudge', () => {
    expect(takeProofNudge(1_000_000)).toBe(true)
  })

  it('refuses a second nudge inside the interval', () => {
    takeProofNudge(1_000_000)
    expect(takeProofNudge(1_000_000 + PROOF_NUDGE_MIN_INTERVAL_MS - 1)).toBe(false)
  })

  it('grants again after the interval', () => {
    takeProofNudge(1_000_000)
    expect(takeProofNudge(1_000_000 + PROOF_NUDGE_MIN_INTERVAL_MS)).toBe(true)
  })

  it('a refused attempt does not push the window forward', () => {
    takeProofNudge(1_000_000)
    takeProofNudge(1_000_000 + 1) // refused
    expect(takeProofNudge(1_000_000 + PROOF_NUDGE_MIN_INTERVAL_MS)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/proofNudge.test.ts --silent`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `utils/pay/proofNudge.ts`:

```ts
/**
 * Gate for the /pay proof-collection nudge.
 *
 * Frame size tracks unproven ancestry: a payer whose Monitor hasn't collected
 * proofs recently ships a ballooned AtomicBEEF and lands on a slower rung —
 * or past 64 KiB, fails outright. Navigating to /pay is the strongest signal
 * a frame build is imminent, so we run one CheckForProofs pass there, at most
 * once per interval, deferred so screen mount never blocks on it. The 2-hour
 * background trigger (WalletContext) is unchanged; this only pulls it earlier.
 */
export const PROOF_NUDGE_MIN_INTERVAL_MS = 10 * 60 * 1000

let lastGrantedMs = -Infinity

export function takeProofNudge(nowMs: number): boolean {
  if (nowMs - lastGrantedMs < PROOF_NUDGE_MIN_INTERVAL_MS) return false
  lastGrantedMs = nowMs
  return true
}

export function resetProofNudgeForTests(): void {
  lastGrantedMs = -Infinity
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest __tests__/proofNudge.test.ts --silent`
Expected: PASS.

- [ ] **Step 5: Wire into /pay**

In `app/pay.tsx`: `useWallet()` is already called (:~30 region) — pull `runMonitorTask` from it; `useOnline` is already imported. Add `InteractionManager` to the `react-native` import and, beside the screen's existing mount effects:

```ts
const { runMonitorTask } = useWallet()
const isOnline = useOnline()

// One deferred proof sweep per visit (10-min gated): see utils/pay/proofNudge.ts.
useEffect(() => {
  if (!isOnline) return
  const task = InteractionManager.runAfterInteractions(() => {
    if (!takeProofNudge(Date.now())) return
    runMonitorTask('CheckForProofs').catch(() => {
      // Best-effort by design: a failed sweep leaves the 2h background
      // trigger as the backstop, and must never surface on this screen.
    })
  })
  return () => task.cancel()
}, [isOnline, runMonitorTask])
```

(If `useWallet()`/`useOnline()` are already destructured in the component, extend the existing lines instead of duplicating hooks.)

- [ ] **Step 6: Typecheck and full suite**

Run: `npx tsc --noEmit && npx jest __tests__ --silent`
Expected: clean, all green.

- [ ] **Step 7: Commit**

```bash
git add utils/pay/proofNudge.ts app/pay.tsx __tests__/proofNudge.test.ts
git commit -m "feat(pay): run a gated CheckForProofs sweep on /pay so frames ship with fresh proofs"
```

---

## Out of scope (recorded elsewhere — do NOT implement)

- Token build flow, basket-insertion crediting, `offline_linkage` store, overlay-gated drain: consumer guidance in the spec (§4–§6), built by downstream stablecoin apps.
- Publishing `@bsv/local-payments` (todo: after device-proven; `ts-stack/packages/helpers`).
- Documentation alignment pass and the Blitz reply (todos in the spec's Deferred section).

## Final verification (after Task 7)

- `npx jest __tests__ --silent` — full suite green.
- `npx tsc --noEmit` — clean.
- Manual device row for the next matrix session: pay iPhone→iPhone over AWDL (sealed radio path), then force QR fallback (airplane-mode the radios) and complete the same payment via the fountain (sealed QR path); re-show the held payment from /pay (sealed stored envelope).
