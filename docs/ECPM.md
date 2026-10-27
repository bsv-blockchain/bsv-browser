# Wallet-native point masking (BRC-229)

The wallet registers `@bsv/ecpm-permission-module` **0.1.3** under `ecpm`.
Applications use the existing BRC-100 `getPublicKey` call; no new bridge method,
private-key export, storage migration, or native dependency is introduced.

```ts
const masked = await wallet.getPublicKey({
  protocolID: [2, `p ecpm apply ${pointHex} mental poker deal`],
  keyID: 'deck mask', counterparty: 'self'
})
const original = await wallet.getPublicKey({
  protocolID: [2, `p ecpm remove ${masked.publicKey} mental poker deal`],
  keyID: 'deck mask', counterparty: 'self'
})
```

The point must be a canonical lowercase compressed secp256k1 point. Only
`getPublicKey` is permitted in this namespace. Ordinary key requests retain
their existing meaning. A full 273-byte logical protocol is supported.

## Consent and lifecycle

Security levels 1/2 and every privileged call require trusted wallet consent.
As specified by the module, a five-minute grant covers **all key IDs**, points
and both operations for one originator, logical protocol, security level and
key universe. Level 2 also binds the counterparty; level 1 covers all
counterparties. Privileged grants additionally bind the displayed reason.
Level 0 ordinary ECPM uses BRC-43 public derivation and requires no prompt.
`seekPermission: false` never opens a prompt and fails without an applicable
grant. Denial, closing the dialog/back navigation, a missing prompt host and
the two-minute prompt deadline fail closed. Up to 64 pending prompts are allowed.

Grants are memory-only. Wallet rebuild, profile/network replacement, logout
and provider teardown dispose them and reject old in-flight results. A late
privileged-key unlock cannot return an old wallet's result. Privileged ECPM
uses the host's existing PrivilegedKeyManager password/retrieval and retention
policy, after ECPM consent. The checked adapter uses the pinned Toolbox's
internal `getPrivilegedKey` method because ProtoWallet has no arbitrary-point
scalar operation; incompatible or unavailable hosts fail closed. This
capability and the transient deriver stay entirely inside trusted host code.
Re-run the privileged contract test on Toolbox upgrades.

## Verification

`npm run test:ecpm` exercises the actual published permission manager, module,
SDK cryptography and binary BRC-100 transport with synthetic keys and no network
or funds. It compares point multiplication with an independent scalar oracle,
checks inverse removal, full-length protocols, scope/expiry, denial,
unsupported methods, invalid points, ordinary key compatibility, privileged
retrieval, stale approval/build/unlock rejection and absence of UI. CI runs
this test on pull requests. Native device acceptance and signed release
qualification remain part of the normal release workflow; headless transport
and bundle checks do not claim device execution.

## BSV Browser shared package

The host wrapper supplies ECPM through a narrow `permissionModuleHost` factory
in the existing source-controlled `@bsv/expo-wallet-toolbox@0.21.0` patch.
BTMS and Mandala registrations remain present. The patch disposes host modules
on rebuild, profile/network changes, logout and unmount, and rejects stale
builds before constructing them. `patch-package --error-on-fail` is a CI gate;
port these hooks or remove the patch only when a shared-package release
supplies equivalent host integration and lifecycle behavior.
