# Wiring web3names into BSV Browser

## 1. Address bar (components/browser/)

Where the submitted omnibox input is currently turned into a URL-or-search
decision, add the web3 branch first:

```ts
import { classifyAddressInput, refreshTlds, DEFAULT_CONFIG } from '@/utils/web3names'

const hit = classifyAddressInput(rawInput)
if (hit.kind === 'web3') {
  openWeb3Name(hit.address)
  return
}
// existing URL / search-engine logic unchanged
```

Call `refreshTlds(DEFAULT_CONFIG.resolverUrl, DEFAULT_CONFIG.tldRefreshMs)`
fire-and-forget on browser start (e.g. app/_layout.tsx) so TLD activations
arrive without an app release; the built-in snapshot covers offline starts.

## 2. Loading a web3 site

```ts
import {
  resolveName, verifyAnswer, fetchVerifiedContent, DEFAULT_CONFIG
} from '@/utils/web3names'
import { bsvSdkCryptoDeps } from '@/utils/web3names/adapters'

async function openWeb3Name (address: string) {
  const deps = bsvSdkCryptoDeps()
  const answer = await resolveName(DEFAULT_CONFIG.resolverUrl, address)
  if (!answer.ok) return showInlineError(answer.error)          // never a blocking alert
  // expectName binds the answer to the question: a valid signature over some
  // other name is still a valid signature, not an answer.
  const verdict = verifyAnswer(answer, deps, { resolverPubKey: DEFAULT_CONFIG.resolverPubKey, expectName: address })
  if (!verdict.valid) return showInlineError(`verification failed: ${verdict.reason}`)
  // content: raw tx from any source the app already uses (WOC is wired in env);
  // integrity is content-addressed — bytes must hash to the SIGNED txid.
  const content = await fetchVerifiedContent(answer.current, wocRawTxSource, deps)
  if (!content) return showInlineError('name has no on-chain site yet')
  renderInWebView(content.contentType, content.body)            // data: URI or local response
}
```

`wocRawTxSource` is one line over the existing WhatsOnChain access:
`(txid) => fetch(\`https://api.whatsonchain.com/v1/bsv/main/tx/\${txid}/hex\`).then((r) => r.text())`.

## 3. Optional hardening (both use machinery this app already ships)

- **Liveness (STD-001 level 3)** ships enforced in `openWeb3Site.ts`.
- **Canonicity (STD-004 §6)** is the announced follow-up PR: fold the
  name's proof object (`/proof/<name>` on any operator) against the root
  in the latest on-chain `sns-commit` inscription, obtained through the
  app's own SPV/BEEF path — the module and tests are ready and held back
  deliberately so the claim never ships ahead of the code.

## 4. Payments — pay to a name (suggested follow-up PR)

The exact same module resolves payment destinations: `info@earthlog.web3`
parses natively (the mailbox form is part of STD-001 §2 and of the signed
preimage), and the verified answer carries `holder_script` — the output to
pay. Suggested wiring in the send flow (payments / legacy-payments):

```ts
const hit = classifyAddressInput(recipientInput)
if (hit.kind === 'web3') {
  const answer = await resolveName(DEFAULT_CONFIG.resolverUrl, hit.address)
  if (!answer.ok) return showInlineError(answer.error)
  const verdict = verifyAnswer(answer, deps, { resolverPubKey: DEFAULT_CONFIG.resolverPubKey, expectName: hit.address })
  if (!verdict.valid) return showInlineError(`verification failed: ${verdict.reason}`)
  if (answer.fallback) showInlineNote(`mailbox unknown — payment goes to the holder of ${answer.name}`)
  return payToLockingScript(answer.holder_script) // + optional liveness check on answer.current
}
```

Kept out of this PR on purpose to keep the diff reviewable; happy to open
it as a small follow-up the moment this one lands. External wallets get the
same names through the bsvalias route — ODNCA-STD-009 (Paymail
Compatibility Profile):
`https://odnca.org/docs/ODNCA-STD-009-Paymail-Compatibility-Profile.pdf`.
