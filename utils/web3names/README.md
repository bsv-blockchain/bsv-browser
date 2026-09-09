# web3names

On-chain name resolution for BSV Browser: type `earthlog.web3` (or pay
`info@earthlog.web3`) and land on the name's on-chain site — with every
answer independently verified, never trusted.

## Trust model — "don't trust us, recompute us"

| Layer | What is checked | Enforced in the shipping path |
|---|---|---|
| 1. Answer | resolver signature (ODNCA-STD-001 §6), fixed-field preimage, pinned key | yes — `verifyAnswer` |
| 2. Liveness | `current.txid:vout` unspent | yes — `wocSpentSource` ('unknown' proceeds on the signed, short-lived answer) |
| 3. Content | raw tx double-SHA256 equals the signed txid | yes — `fetchVerifiedContent` |
| 4. Canonicity | merkle inclusion against the on-chain committed root (genesis at block 961546) | announced follow-up PR — kept out of this diff so no claim ships ahead of its code |

The resolver endpoint is **configuration, not trust**: any conformant
operator works, the default is `sns.ordnet.io`, and a lying or compromised
source fails checks 1–4 in this module. The published ruleset + vectors at
odnca.org/transparency let anyone re-derive the same namespace from the
chain.

## Integration (two lines in the address bar)

```ts
import { classifyAddressInput } from '@/utils/web3names'

const hit = classifyAddressInput(input)
if (hit.kind === 'web3') return navigateToWeb3(hit) // else: existing URL/search path
```

`navigateToWeb3` = `resolveName` → `verifyAnswer` → `fetchVerifiedContent`
→ render in the WebView (see WIRING.md for the full snippet). Classification
is conservative: only inputs that parse as `name.tld` with a TLD in the
recognised set are intercepted — `example.com`, search phrases, and every
normal URL pass through untouched.

## Files

- `names.ts` — address parsing/normalization (STD-001 §2; non-ASCII = exact bytes)
- `tlds.ts` — built-in TLD allowlist; resolver `/health` can confirm or retire shipped TLDs, never add
- `resolve.ts` — one-GET transport to any conformant resolver
- `verify.ts` — signature scheme, frozen conformance vector reproduced in tests
- `liveness.ts` — the unspent check over the chain data this app already uses
- `ordContent.ts` — txid-anchored raw-tx fetch + 1Sat ord envelope parsing
- `addressBar.ts` — the conservative classifier
- `adapters.ts` — CryptoDeps via @bsv/sdk (the only file with a dependency)

Zero new packages; unit suite runs on plain Node.
