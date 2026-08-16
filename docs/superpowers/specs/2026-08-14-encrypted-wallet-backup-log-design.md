# Encrypted wallet backup log

**Status:** design proposal, awaiting approval
**Date:** 2026-08-14
**Scope:** client (bsv-browser, TypeScript) + server (new Go service)

---

## The problem, restated

User research found that most users never back up their mnemonic, never print recovery
shares, and never export wallet data. That framing understates the danger, because it
assumes the mnemonic is what matters.

**A mnemonic alone recovers nothing.** Spending a wallet output requires derivation
metadata that exists only in the local SQLite database:

- Change outputs are created with `const n = randomDerivation(16)` — a random derivation
  suffix persisted only in the DB
  (`@bsv/wallet-toolbox-mobile/out/src/storage/methods/createAction.js`).
- Received BRC-29 outputs carry `senderIdentityKey`, `derivationPrefix` and
  `derivationSuffix` chosen by the *sender*
  (`.../storage/schema/tables/TableOutput.d.ts:21-23`).
- No rescan or reconstruct-from-chain path exists anywhere in `StorageProvider`.

So a user who dutifully printed recovery shares and then lost their phone still cannot
spend their coins. The backup feature the app ships today is necessary but not
sufficient, and that gap is silent.

This design fixes the database half. It converts the recovery requirement from
"you need **both** the mnemonic and the device" into "you need **only** the mnemonic or
the printed shares" — which makes the existing paper backup genuinely sufficient for the
first time.

### Explicitly out of scope

- **Backing up the entropy/mnemonic itself.** Decided out of scope. It cannot ride in
  this log: the log is encrypted under a key derived from the entropy, so encrypting the
  entropy into it is circular. A separate mechanism (platform-synced keychain, passkey
  PRF, hardware wrap) would be a future change. See [BRC-157 entropy backup migration](2026-08-14-brc157-entropy-backup-migration.md).
- **Forcing, gating, or nagging users to back up.** Decided out of scope. This feature is
  automatic; there is no prompt, snooze, or blocking gate anywhere in it.

### Enablement — on by default, with disclosure and an off switch

**Assumption, stated for the record and easily overturned.** The stated goal is that
users who back up nothing today are protected. An opt-in service reproduces exactly the
problem it exists to solve — the people who never printed shares are the people who will
never tick a box. So backup is **on by default**.

That default means the app sends the user's encrypted wallet database to a
BSV-Association-operated server without them asking, which deserves honesty rather than
silence:

- Disclose it at wallet creation and in settings — what is sent, that it is encrypted
  with a key only their seed can derive, and that the operator cannot read it.
- Provide an off switch in settings that stops pushing and offers to delete the log
  (`DELETE /v1/generation/...`).
- Do not present this as a substitute for the mnemonic. The log is useless without the
  seed or shares, and the UI must not imply otherwise — that misconception would make
  users *less* likely to keep their paper backup, actively worsening the situation.

If the preference is opt-in instead, everything else in this design is unchanged; only the
default flips and the expected coverage drops sharply.

---

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Transport of DB state | Toolbox `SyncChunk` deltas | Incremental and chunked by construction |
| Server role | Opaque append-only blob log | Not a storage provider; cannot read anything |
| Encryption | `wallet.encrypt`, `counterparty: 'self'` | Verified: server decrypt fails |
| Server identity of a user | The authenticated AuthFetch key, which is a derived pseudonym | No user-supplied identity field anywhere |
| Server language/stack | Go, `go-sdk` + `go-bsv-middleware`, chi | House convention |
| Blob persistence | Postgres `bytea` behind a `BlobStore` interface | Transactional generation swaps; S3 seam preserved |
| Retention | Keep 2 generations, never idle-expire | Deleting an idle backup destroys exactly the user who lost their phone |
| Deployment | Single instance, `SessionManager` seam for later | Backup traffic is tiny and latency-insensitive |
| Client SDK | `@bsv/sdk` 2.4.0 only, no 2.1.9 path | Raw binary upload; 2.1.9's AuthFetch cannot send it |
| Payments | Free for v1; paid variant under review | See open questions |

---

## Architecture

```
┌─ bsv-browser (React Native) ───────────────────────────────────────────┐
│                                                                        │
│  primaryKey (m/0'/0')          ← the only secret BOTH cohorts have     │
│      │                                                                 │
│      └─ BRC-42/43 derive (fixed protocol + keyID)                      │
│           └─ backupKey ──> CompletedProtoWallet                        │
│                              ├─ identity ──> AuthFetch peer identity   │
│                              └─ encrypt({counterparty:'self'})         │
│                                                                        │
│  push:    phoneStorage.getSyncChunk({since,offsets,maxRoughSize})      │
│             → stringifyJsonRpc(chunk, binary=true)                     │
│             → encrypt → POST raw octet-stream                          │
│                                                                        │
│  restore: EncryptedRemoteSyncReader implements WalletStorageSyncReader │
│             → WalletStorageManager.syncFromReader()                    │
└────────────────────────────────────────────────────────────────────────┘
                                   │ AuthFetch (BRC-103/104)
                                   ▼
┌─ go-wallet-backup-server ──────────────────────────────────────────────┐
│  chi router, mounted at the ORIGIN ROOT (mandatory)                    │
│    ├─ GET /health                              unauthenticated         │
│    └─ middleware.NewAuth(CompletedProtoWallet).HTTPHandler             │
│         │  (/.well-known/auth handled internally — do NOT route it)    │
│         └─ pseudonym := ShouldGetAuthenticatedIdentity(ctx).ToDERHex() │
│                                                                        │
│  Postgres: blob bytes + (pseudonym, device, generation, seq) index     │
└────────────────────────────────────────────────────────────────────────┘
```

---

## Client design

### Key derivation — derive from `primaryKey`, not `rootKey`

This is the single most important client detail.

The mnemonic path yields both a `rootKey` and a `primaryKey`
([utils/mnemonicWallet.ts:48-61](../../../utils/mnemonicWallet.ts)). The shares path
yields **only** the primary key: `PrivateKey.fromBackupShares()` produces the `m/0'/0'`
WIF, and `buildWalletFromRecoveredKey` uses it directly
([context/WalletContext.tsx:1289](../../../context/WalletContext.tsx)).

Deriving the backup key from `rootKey` would silently lock share-restored wallets out of
their own backups — the exact cohort this feature most helps. Derive from `primaryKey`.

```ts
import { CompletedProtoWallet, KeyDeriver, PrivateKey } from '@bsv/sdk'
import type { WalletProtocol } from '@bsv/sdk'

// Versioned constants. Restore has only the seed, so these must never vary
// per-install, per-device, or per-random. Covered by a test.
// NOTE: in TypeScript WalletProtocol is a TUPLE [SecurityLevel, string] —
// not the {securityLevel, protocol} struct the Go SDK uses.
export const BACKUP_PROTOCOL: WalletProtocol = [2, 'wallet backup log']
export const BACKUP_KEY_ID = '1'

export function deriveBackupWallet(primaryKey: number[]): CompletedProtoWallet {
  const deriver = new KeyDeriver(new PrivateKey(primaryKey))
  const backupPriv = deriver.derivePrivateKey(BACKUP_PROTOCOL, BACKUP_KEY_ID, 'self')
  return new CompletedProtoWallet(backupPriv)
}
```

Protocol names are validated at runtime, not compile time: 5–400 chars, `^[a-z0-9 ]+$`,
no double spaces, must not end in `" protocol"`.

`CompletedProtoWallet` is exported from the `@bsv/sdk` root (verified at 2.1.9 and 2.4.0) and
implements the full `WalletInterface` that `AuthFetch` requires. `ProtoWallet` alone is
insufficient — `AuthFetch`'s constructor is typed against `WalletInterface`.

Using a dedicated wallet rather than the app's main wallet has a second benefit: blob
encryption never routes through `WalletPermissionsManager`, so it cannot trigger
protocol-permission prompts or spending-authorization gates.

### Encryption — `counterparty: 'self'` is the entire security property

Verified empirically against `go-sdk`: a client encrypting with `CounterpartyTypeSelf`
produces ciphertext the server cannot decrypt even while holding the client's public key
(`cipher: message authentication failed`). With `CounterpartyTypeOther{serverKey}` the
server *can* decrypt via ECDH.

The blindness is a property of one enum value chosen by the client. The server's job is
to be structurally unable to help: no identity field in any request, no decrypt path, no
server key in the encryption protocol.

BRC-2 wire layout is `IV(32) || ciphertext || tag(16)` — AES-256-GCM, 48 bytes of
overhead, no plaintext-recoverable metadata.

### Push

Registered as a monitor task beside `TaskSendOffline`
([context/WalletContext.tsx:945](../../../context/WalletContext.tsx)), where
`phoneStorage` is already in scope.

```
1. cursor = AsyncStorage[`backupCursor-${pseudonym}-${deviceId}`]  // {since, offsets, seq, generation, prevSha256}
2. chunk = await phoneStorage.getSyncChunk({
     fromStorageIdentityKey, toStorageIdentityKey, identityKey,
     since: cursor.since, offsets: cursor.offsets,
     maxRoughSize: 512_000, maxItems: 200,
   })
3. if every entity array is empty → nothing to do, return
4. body = stringifyJsonRpc(chunk, /* binary */ true)   // optional deflate — see Wire format
5. ct = await backupWallet.encrypt({ plaintext: body, protocolID, keyID, counterparty: 'self' })
6. POST /v1/log/{deviceId}?seq=&generation=&prevSha256=   // raw octet-stream body
7. advance cursor from the chunk's max updated_at + returned offsets; persist
```

Call `getSyncChunk` **directly on the local provider**, not through
`WalletStorageManager`. Reasons:

- `updateBackups`/`syncToWriter` take the manager's sync lock via `runAsSync`, blocking
  all reads *and* writes to active storage for the duration — against the standing
  no->100ms-JS-block goal.
- Registering a remote as a backup store hits the `_conflictingActives` trap: a fresh
  remote user gets `activeStorage = <remote's own key>`, so `isActiveEnabled` goes false
  and `updateBackups()` throws `WERR_NOT_ACTIVE` via `getAuth(true)`.
- `getSyncChunk` is fully implemented on `StorageReader`
  (`.../storage/StorageReader.js:82`), which `StorageExpoSQLite` extends. It works today.

Bypassing the manager lock means a chunk can be read mid-write. This is safe: chunks are
`since`-based and replay is idempotent, so a torn read self-corrects on the next round.

Monitor tasks run back-to-back with no yielding, so deflate + encrypt + HTTP must be
deferred via `InteractionManager` and rate-limited (precedent:
[utils/pay/proofNudge.ts](../../../utils/pay/proofNudge.ts)).

### Wire format

Sync chunks are dominated by raw transaction bytes — `TableProvenTx.rawTx`,
`TableProvenTxReq.rawTx`/`inputBEEF`, `TableTransaction.rawTx`/`inputBEEF`, `merklePath`,
all typed `number[]`. Naive `JSON.stringify` renders each byte as up to four characters.

Use the toolbox's own `binaryJsonReplacer` / `binaryJsonReviver` / `stringifyJsonRpc`
(`.../storage/remoting/BinaryJson.ts`) for round-trip fidelity with the toolbox's types
rather than inventing an encoding.

**Correction, found during implementation:** that serialiser does **not**, on its own,
compact these fields. `binaryJsonReplacer` base64-encodes `Uint8Array` only, and every
binary field on the toolbox's tables is typed `number[]`, so `rawTx` and friends would go
over the wire as decimal arrays at roughly 2.9 characters per byte. The client therefore
runs a packing pass first, converting byte-valued arrays to `Uint8Array` so the serialiser
can compact them and converting them back on decode. The transform is lossless in both
directions — an array that merely looks byte-like, such as small integer ids, returns
exactly the values it started with — and is covered by tests including a 256-value
all-bytes case and a non-byte numeric array.

Because the server stores opaque bytes and never parses payloads, the serialization
format is a purely client-internal choice with no interop constraint.

**Compression is optional and deferred.** If used it must happen *before* encryption,
since ciphertext is incompressible. But no compression library is currently a dependency
(`pako` and `fflate` are both absent), and the gain is modest: the payload is dominated by
transaction bytes — hashes, keys and signatures — which are high-entropy and barely
compress. Deflate would mostly reclaim the base64 expansion introduced by `BinaryJson`
plus the JSON field names, on the order of 30%. Weigh that against a new dependency
(`fflate` is the lighter choice, pure JS, no native code) and CPU spent on a
non-yielding monitor task. Recommend shipping without it and revisiting if real-world
blob sizes justify it — especially since moving to SDK 2.4.0 removes the larger overhead.

Chunk sizing: the protocol default `maxRoughSize` is 10,000,000 — far too large to push
from a phone on cellular, and the server-side estimator re-marshals the accumulating
chunk on every page (O(n²) on large syncs). Use ~512 KB with `maxItems: 200`, yielding
ciphertext comfortably under the 1 MiB cap.

### Upload is raw binary — and that requires SDK 2.4.0

Uploads `POST` raw `application/octet-stream`. There is no base64 envelope and no JSON
body encoding. **This is only possible on `@bsv/sdk` 2.4.0**, which is therefore a hard
prerequisite (see below), not a nice-to-have.

The reason it is version-gated is worth recording, because it is not obvious and someone
will otherwise try to backport. On `2.1.9`, `AuthFetch.normalizeBodyToNumberArray`
(`dist/cjs/src/auth/clients/AuthFetch.js:724-745`) tests `typeof body === 'object'` as its
*first* branch and returns `Utils.toArray(JSON.stringify(body))`. Arrays, `Uint8Array`,
`ArrayBuffer`, `Blob`, `FormData` and `URLSearchParams` are all `typeof 'object'`, so every
subsequent binary branch is dead code and a `Uint8Array` body is serialized as
`{"0":12,"1":255,…}`.

2.4.0 removes that branch and restores the intended order — `number[]` → `string` →
`ArrayBuffer`/`TypedArray` → `Blob` → `FormData`. It also fixes a latent bug in the
TypedArray branch: 2.1.9 does `new Uint8Array(body.buffer)`, ignoring `byteOffset` and
`byteLength`, which silently corrupts any subarray view. 2.4.0 passes all three.

Downloads need no special handling on either version — the response path builds
`new Response(new Uint8Array(responseBody))` (`AuthFetch.js:191-196`).

### Generations and compaction

An append-only delta log grows without bound: soft deletes mean nothing shrinks, and the
first backup of an established wallet is a full snapshot spanning many chunks.

The client periodically starts a new **generation**: a fresh full snapshot
(`since: undefined`) written as generation `N+1`, after which generation `N` is deleted.
This bounds server storage per user, bounds restore time, and gives the server a
legitimate deletion primitive it can execute without understanding any content.

Trigger heuristic: when `seq` in the current generation exceeds a threshold (e.g. 200
chunks), or cumulative bytes exceed a multiple of the last full snapshot.

### Restore

`WalletStorageSyncReader` is a two-method interface, which is the whole restore contract:

```ts
class EncryptedRemoteSyncReader implements WalletStorageSyncReader {
  async makeAvailable(): Promise<TableSettings> { /* from the manifest */ }
  async getSyncChunk(args: RequestSyncChunkArgs): Promise<SyncChunk> {
    const blob = await this.fetchNext()          // GET /v1/log/{device}/{seq}
    const plain = inflate(await this.wallet.decrypt({ ciphertext: blob, ...proto }))
    return parseJsonRpc(plain, /* binary */ true)
  }
}
```

Then `WalletStorageManager.syncFromReader(identityKey, reader)` performs the restore
unmodified.

Restore flow: install → enter mnemonic or scan shares → derive `primaryKey` → derive
pseudonym → `GET /v1/manifest` → pick device → replay the newest complete generation.

**Risk:** zero tests cover sync anywhere in this repo, and
`StorageExpoSQLite.processSyncChunk` is a pass-through with a comment implying it has
never been exercised ([storage/StorageExpoSQLite.ts:1507](../../../storage/StorageExpoSQLite.ts)).
The primitive this design rests on has never run in this app. **Build the restore path
test-first**, with a round-trip test that seeds a DB, pushes to a fake server, restores
into a fresh DB, and asserts `listOutputs`/`listActions` equality.

### Configuration

[context/config.tsx:20-24](../../../context/config.tsx) already has the pattern
(`DEFAULT_MESSAGEBOX_URL`). Add `DEFAULT_BACKUP_URL`. `DEFAULT_STORAGE_URL` stays
`'local'` — the backup service is deliberately not a storage provider.

### SDK upgrade to 2.4.0 — hard prerequisite

The app is on `@bsv/sdk@2.1.9`; latest is **2.4.0**. This feature targets 2.4.0 only.
There is no 2.1.9 compatibility path, and the client should not carry one.

- **Raw binary upload requires it**, removing the base64 envelope and ~1.33× of
  bandwidth and server storage on every push (see above).
- The `byteOffset`-ignoring TypedArray bug is fixed, which matters as soon as any code
  passes a subarray view.
- `KeyDeriver` gains an optional `derivePrivateKeys?(derivations)` batch hook — upstream's
  version of what the local patch implements by hand via `batchBrc42DeriveChild`. Worth
  checking whether the upgrade lets part of the patch be retired rather than rebased.
- `toEntropy()` / `fromEntropy()` land, which the
  [BRC-157 entropy backup migration](2026-08-14-brc157-entropy-backup-migration.md) spec
  separately depends on.

APIs this design uses are unchanged in 2.4.0 (verified): `WalletProtocol` is still the
tuple `[SecurityLevel, ProtocolString5To400Bytes]`, `derivePrivateKey(protocolID, keyID,
counterparty)` keeps its signature, and `CompletedProtoWallet` is still exported.

**Cost:** `patches/@bsv+sdk+2.1.9.patch` is 2168 lines — the native secp256k1 route
(Nitro libsecp256k1 with a `@noble/secp256k1` fallback) patched into `ECDSA.js` and
friends. That patch must be rebased onto 2.4.0 and re-verified for byte-exactness, and
the companion `patches/@bsv+wallet-toolbox-mobile+2.4.3.patch` reviewed alongside it.

This is a three-minor jump underneath a live wallet. Per the BRC-157 spec's conclusion, it
should be **its own branch and its own verification pass** against the existing test
suite, not folded into this feature's commits. It is a blocking dependency: the backup
client cannot ship before it lands.

---

## Server design

### Module and layout

```
module github.com/bsv-blockchain/go-wallet-backup-server
go 1.26.3
```

Mirrors the newer house layout (`go-uhrp-storage-server`'s `internal/`, not
`go-message-box-server`'s `pkg/`):

```
cmd/server/main.go              composition root + graceful shutdown
internal/config/config.go       plain struct + Load() from os.Getenv
internal/logger/logger.go       Configure(LOG_LEVEL, LOG_FORMAT) *slog.Logger
internal/server/server.go       chi router, middleware chain, route groups
internal/server/handlers/       one file per endpoint + _test.go
internal/server/middlewares/    RequireIdentityKey
internal/server/responses/      {status,code,description} envelope
internal/blobstore/             BlobStore interface + postgres impl
internal/store/                 database/sql metadata + migrations
internal/wallet/                server identity + mocks/
test-client/                    Jest + @bsv/sdk AuthFetch integration tests
```

House conventions: `SERVER_PRIVATE_KEY` as 64-char hex with no dev default, `log/slog`,
`database/sql` with no ORM, `{"status":"success"|"error","code":"ERR_…"}` envelope,
multi-stage alpine Dockerfile, GHCR publish workflow.

Deliberate deviations, each closing a documented gap rather than breaking convention:
add `GET /health` (pattern from `merkle-service`), add a `go test` + `golangci-lint`
workflow (neither small service has one), set `SetMaxOpenConns`/`SetConnMaxLifetime`,
and use versioned migrations. Take graceful shutdown from `go-message-box-server`; uhrp
lacks it. Fail fast when `SERVER_PRIVATE_KEY` is unset — every route is authenticated, so
a wallet-less server is useless.

### Auth wiring

```go
priv, _      := ec.PrivateKeyFromHex(cfg.ServerPrivateKey)
srvWallet, _ := sdkwallet.NewCompletedProtoWallet(priv)   // crypto-only, no storage

sessions := auth.NewSessionManager()
authMW := middleware.NewAuth(srvWallet,
    middleware.WithAuthDisallowUnauthenticated(),
    middleware.WithAuthSessionManager(sessions),
    middleware.WithAuthLogger(logger),
)

r.Handle("/.well-known/auth", authMW.HTTPHandler(http.NotFoundHandler()))
r.Group(func(r chi.Router) {
    r.Use(authMW.HTTPHandler)
    r.Use(middlewares.RequireIdentityKey)
    // routes
})
```

Handlers read the caller as
`middleware.ShouldGetAuthenticatedIdentity(r.Context())` → `*ec.PublicKey` →
`.ToDERHex()`. Re-stash it under a local typed context key (as uhrp does) so handlers are
unit-testable — the library's own context key is unexported, and without the re-stash
handler tests can only assert 401s.

**Mount at the origin root.** The middleware intercepts `POST /.well-known/auth` on an
exact path compare and never calls `next`, while the TS client always posts the handshake
to `${new URL(url).origin}/.well-known/auth`. Mounting only under an `/api` subtree makes
the handshake miss and every request 401.

**Do not construct the payment middleware.** Omitting it engages nothing. Constructing
`NewPayment` without `WithRequestPriceCalculator` silently charges 100 sat per request,
and the payment path dereferences the result of `CompletedProtoWallet.InternalizeAction`,
which returns `(nil, nil)`.

### 402 is a privacy invariant, not a product preference

The service is free. This was re-examined in detail against
[go-402-pay](https://github.com/bsv-blockchain/go-402-pay) (BRC-121) combined with a
[BRC-228](https://bsv.brc.dev/payments/0228) ephemeral `senderIdentityKey`, on the
reasoning that an unlinked payment identity would preserve the property. **It does not.**
BRC-228 removes the least important leak.

The pseudonymous `CompletedProtoWallet` cannot fund anything — `createAction` throws
`not implemented` — so the user's real wallet must pay. What that hands the server:

- **The BEEF is the leak, not the sender key.** `x-bsv-beef` carries each input's ancestry
  back to a proof, which means one or more *complete prior transactions of the user's
  wallet* — the bytes, not references. Delivered inside a request BRC-104 has
  cryptographically bound to the pseudonym, it is a signed assertion that this pseudonym
  controls these outpoints. BRC-228 does not touch this.
- **Change chaining collapses the pseudonym.** Payment *n*'s change funds payment *n+1*,
  so after two payments the operator can walk the wallet forward indefinitely with any
  public indexer. Change *amounts* additionally disclose balance and balance trajectory,
  which is close to a unique fingerprint at this user-base size.
- **A cross-service join needs no chain analysis at all.** This app already sends the real
  identity key in cleartext as `x-bsv-sender` to ordinary BRC-121 merchants
  (`utils/webview/bsvPaymentHandler.ts:175-179`), and every BRC-103 peer learns it by
  construction. One join against any service holding both the identity key and an outpoint
  from the same wallet is sufficient — and the operator here also runs the app and the
  ARC broadcaster the client posts to directly from the device's IP.
- **Charging forces the server to keep records it otherwise would not.** go-402-pay
  delegates replay protection to the wallet's `InternalizeAction`, so a paid server needs
  a funded, storage-backed wallet and gains a permanent per-payment ledger keyed by
  pseudonym. The free server holds one key and opaque bytes.

The distinction that decides it: today's residual is **correlational and deniable** —
it requires the operator to deliberately retain and cross-reference logs they have no
business reason to keep, it degrades under CGNAT, VPNs and roaming, and it leaves no
artifact that survives a breach or a subpoena. Payment replaces all of that at once with a
**cryptographic, durable, self-documenting and legally-retained** record.

If revenue becomes necessary, in order of preference: charge elsewhere in a relationship
where the user is already identified; or, if the real motive is abuse control, enforce
per-pseudonym quotas and rate limits, which cost a day and leak nothing. Blind-signed
tokens are the only genuinely private paid design and are not worth building for a small
user base, because the anonymity set would not support the claim.

**Do not ship per-request 402 and describe the result as pseudonymous.** That is worse
than either honest alternative, because users would act on a claim the architecture does
not support.

Three engineering blockers stand independently of privacy, recorded so nobody rediscovers
them: the server's `CompletedProtoWallet` panics on a nil dereference under the payment
middleware; `AuthFetch` hard-errors on a BRC-121 402 response, demanding an
`x-bsv-payment-version` header go-402-pay never sends, so **no client today speaks both
BRC-103 auth and BRC-121 payment**; and this app's own 402 client is GET/HTML-only with no
retry, so a binary `POST` upload would be a rewrite rather than a reuse.

### The honest residual, free design included

The free design is **not** unlinkable. The server observes source IP, TLS fingerprint,
request cadence, ciphertext lengths, device count, total volume, and — because one
pseudonym spans a user's devices so restore can enumerate them — that those devices belong
to one person.

IP is the real residual and it is not small: a phone's IP is geolocatable,
ISP-attributable, and often stable enough within a session to individuate. Any claim that
this design achieves unlinkability against *this* operator is overselling it. What it does
buy is that the correlation is a policy failure rather than an architectural fact.

### The pseudonym, honestly

BRC-103 is transport-level mutual auth: the server necessarily learns the public key it
authenticated. There is no configuration that authenticates a caller without revealing
their key.

Therefore any scheme where the server computes a pseudonym *from* the user's real identity
key is theatre — the server holds both on every request. The only construction that works
is the one above: **the AuthFetch identity itself is a derived key**, so the real identity
key never touches the wire. The server writes `pseudonym := identityKey.ToDERHex()` and
there is no user-supplied identity field in any request body anywhere in the API.

That last point structurally eliminates the bug found in `go-wallet-toolbox`, where sync
routes trust `args.identityKey` from the request body without binding it to the
authenticated peer, letting any authenticated caller read or overwrite another user's
data. **The row key is the auth key or it does not exist.**

Residual leakage, to be documented rather than hidden: the server observes source IP, TLS
fingerprint, request cadence, ciphertext lengths, device count, and total volume. Because
one pseudonym is shared across a user's devices so that restore can enumerate them, those
devices are linkable to each other.

Dependency worth stating: this requires the client to hold the root private key
in-process. bsv-browser does today (`swm.providePrimaryKey(primaryKey)`). If the app ever
moves to a remote BRC-100 substrate, it could still `encrypt`/`decrypt` but could not
extract a derived private key, and this construction would become impossible.

### Routes

Base path `/v1`. Everything except `/health` and `/.well-known/auth` sits inside the auth
group. `{deviceId}` is a client-generated opaque `[a-f0-9]{32}`. `seq` is 1-based and
contiguous per `(pseudonym, deviceId, generation)`.

| Method | Path | Success | Errors |
|---|---|---|---|
| `GET` | `/health` | `200 {"status":"ok"}` | `503` |
| `GET` | `/v1/manifest` | `200` device + generation list | `401` |
| `POST` | `/v1/log/{deviceId}` | `201 {"seq":N,"sha256":"…"}` | `400 ERR_INVALID_JSON`, `401 ERR_AUTH_REQUIRED`, `409 ERR_SEQ_CONFLICT`, `413 ERR_BLOB_TOO_LARGE`, `429 ERR_RATE_LIMITED`, `507 ERR_QUOTA_EXCEEDED` |
| `GET` | `/v1/log/{deviceId}` | `200` index (`from`, `limit`) | `401`, `404 ERR_DEVICE_NOT_FOUND` |
| `GET` | `/v1/log/{deviceId}/{seq}` | `200 application/octet-stream` | `401`, `404 ERR_BLOB_NOT_FOUND` |
| `DELETE` | `/v1/generation/{deviceId}/{generation}` | `204` | `401`, `404`, `409` |

`POST /v1/log/{deviceId}` takes the raw ciphertext as an `application/octet-stream` body,
with `seq`, `generation` and `prevSha256` as query parameters. Reject any other
`Content-Type` with `415`. There is no JSON upload encoding.

`prevSha256` chains entries so a client can detect a gap or a fork before trusting a
restore. The server computes and stores `sha256` of the received bytes and returns it, so
the client can verify the round trip without a redundant declared-length field.

JSON responses use the house envelope; slices are normalized to `[]` before encoding so
JSON never contains `null`.

### Size limits are mandatory, not defensive

There is **no streaming behind the auth middleware**: `ResponseWriterWrapper` buffers
status and body so the response can be signed, and implements neither `http.Flusher` nor
`http.Hijacker`. SSE, chunked upload, and WebSocket are all unavailable. Meanwhile the
closest template (uhrp) does `io.ReadAll(r.Body)` with no `MaxBytesReader`, so an 11 GB
upload is an 11 GB heap allocation.

Enforce `http.MaxBytesReader` globally and cap ciphertext at **1 MiB** (matching the
toolbox storage server's precedent), rejecting oversize with `413`.

### Persistence

Postgres, behind an interface so S3 remains a drop-in — uhrp's lack of such a seam was
flagged as a genuine gap.

```go
type BlobStore interface {
    Put(ctx context.Context, key BlobKey, data []byte) error
    Get(ctx context.Context, key BlobKey) ([]byte, error)
    DeleteGeneration(ctx context.Context, pseudonym, deviceID string, generation int) error
}
```

```sql
CREATE TABLE IF NOT EXISTS blob_log (
  pseudonym    TEXT    NOT NULL,          -- 66-char compressed hex, from auth only
  device_id    TEXT    NOT NULL,
  generation   INTEGER NOT NULL,
  seq          INTEGER NOT NULL,
  sha256       BYTEA   NOT NULL,
  prev_sha256  BYTEA,
  ciphertext   BYTEA   NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (pseudonym, device_id, generation, seq)
);
CREATE INDEX IF NOT EXISTS blob_log_head
  ON blob_log (pseudonym, device_id, generation, seq DESC);
```

Postgres gives transactional generation swaps and cheap retention queries, and keeps the
house `database/sql` pattern. Blobs are ≤1 MiB, so `bytea` is comfortable; TOAST handles
them without special handling.

### Retention

Keep the **current and previous generation** — two, so a failed compaction never leaves a
user with zero backups. Deletion of generation `N-2` happens transactionally when
generation `N` completes.

**No idle expiry.** A pseudonym that has not been written to for years belongs to exactly
the user this feature exists for: someone who lost their phone and has not yet replaced
it. There is also no way to warn a pseudonym you cannot contact. Storage cost per user is
bounded by wallet size, not by age.

### Deployment

Single instance to start. The default in-memory `SessionManager` is per-middleware-instance,
and the failure mode across replicas is verified: handshake on replica A, request on
replica B, `401 session-not-found`. No shared implementation ships with the library.

Keep the five-method `auth.SessionManager` interface
(`AddSession`/`UpdateSession`/`GetSession`/`RemoveSession`/`HasSession`) visible in config
so a Postgres-backed implementation is a drop-in when a second replica is needed.

---

## Testing

- **Client round-trip (highest value):** seed a DB with transactions and outputs, push to
  a fake server, restore into a fresh DB, assert `listOutputs`/`listActions` equality.
  This is the test that proves the feature works, and it covers a code path that has never
  executed in this app.
- **Key derivation is frozen:** assert that a fixed `primaryKey` produces a fixed
  pseudonym. A change here orphans every existing backup.
- **Shares cohort:** assert a wallet restored from backup shares derives the same
  pseudonym and decrypts blobs written by the mnemonic-restored wallet.
- **Server cross-tenant:** identity A cannot read or write identity B's blobs on any
  route. Assert on every route, not just one.
- **Server rejects oversize** with `413` before allocating.
- **Interop:** `go-bsv-middleware` already ships a dockerized Node client driving the Go
  middleware via `new AuthFetch(new CompletedProtoWallet(priv))`. Copy that harness shape
  for `test-client/`.

---

## Risks

| Risk | Mitigation |
|---|---|
| Sync path has never executed in this app | Build restore test-first; treat as greenfield |
| Derivation constants change | Freeze in a versioned constants file with a test |
| Monitor task blocks the JS thread | `InteractionManager` + rate limit; small chunks |
| First full snapshot is large on cellular | 512 KB chunks; resumable via `seq`; defer to unmetered where detectable |
| Blob log forked across two devices | `prevSha256` chain + per-device logs; restore picks one device |
| Someone adds 402 later | Documented as a privacy invariant, not a preference |
| SDK 2.4.0 upgrade destabilises the native-secp patch | Own branch, own verification pass, existing suite as the net. Blocking: there is no 2.1.9 fallback path |

---

## Open questions

- Repo name: `go-wallet-backup-server` is the proposal.
- Repository: **`github.com/bsv-blockchain/go-private-backup-cache`**.
- ~~Whether the service is free or paid~~ — **resolved: free.** See below.
- Generation-rotation threshold — 200 chunks is a guess; needs a measurement against a
  real wallet's growth rate.
- Should push be gated on unmetered connectivity? The app has `hooks/useOnline.ts` but no
  metered/unmetered signal today.
- Per-pseudonym quota value for `507 ERR_QUOTA_EXCEEDED`.
