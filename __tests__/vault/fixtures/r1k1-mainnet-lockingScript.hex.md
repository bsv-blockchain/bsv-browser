# R1-K1 mainnet locking-script fixture

Provenance for a real, mined mainnet R1-K1 vault output, used to prove the
pinned template (`services/vault/templateCodec.ts`, `services/vault/r1k1.ts`)
still reproduces byte-identical output — not merely a plausible one.

- txid: `6c947ae3825b7a7ea1c61a27b64b39c5b8b424d460677addb896285222982697`
- vout: `0`
- source: project owner's device database (public on-chain data; no secrets)

## What is committed here

Not the 959,632-byte script itself. Storing 1.9 MB of hex in git to test a
compressor whose entire purpose is avoiding 1.9 MB would be self-defeating.
Instead, this fixture commits the 40 bytes that vary between vault outputs
(the R1 commitment and the k1PublicKeyHash actually mined on-chain for this
output) plus SHA-256 digests of the full script and of its scriptCode. Both
are recorded below and, as the actual source of truth the tests import,
in `r1k1MainnetFixture.ts`.

| field | value |
| --- | --- |
| length | 959632 |
| commitment (offsets 17..36) | `93d0d2a2a0e1f6411498d53c4fd9db0e543171b1` |
| k1PublicKeyHash (offsets 959609..959628) | `4c63d12b6237ddd07db2e8a08c984d7667b487d0` |
| SHA-256 of the full locking script | `f5f78dcf291c5a115a609c1040117e2d09fd7e1cdc2d4911c633b338545f3db8` |
| scriptCode = lockingScript.subarray(60), length 959572 | |
| SHA-256 of scriptCode | `aeb8d8544f5bc218543de986cd974e7e387e3f455cb53a7c7460b466c2db6de9` |

The preimage behind the commitment (the r1PublicKey/salt pair that hash160's
to `93d0d2a2a0e1f6411498d53c4fd9db0e543171b1`) is not held anywhere and is not
needed: the fixture proves the template reproduces this exact, already-mined
commitment/k1PublicKeyHash pair byte-for-byte, not that this key material can
be re-derived.

## How the fixture is used

`r1k1MainnetFixture.ts` exports the constants above plus
`buildMainnetFixtureScript()`, which rebuilds the full 959,632-byte script
from the CURRENT `@bsv/templates` `R1K1Wallet` using the commitment and
k1PublicKeyHash above — via `R1K1Wallet().lock(commitment, k1PublicKeyHash)`
directly, not `buildVaultLockingScript`, since this fixture holds the
commitment itself rather than the r1PublicKey/salt preimage
`buildVaultLockingScript` would hash to derive it.

`__tests__/vault/r1k1MainnetFixture.test.ts` asserts the rebuilt script's
SHA-256 equals the digest recorded above, and that the digest is stable
across two independent builds.

If `@bsv/templates` ever changes the R1K1 locking-script layout, the rebuilt
bytes will differ from what is actually mined and this digest comparison
fails — loudly, in CI — instead of the compressed-fixture round trip silently
reconstructing the wrong bytes for a real, already-mined mainnet vault
output.
