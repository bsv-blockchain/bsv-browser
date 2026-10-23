# signAction checks the sequence after the broadcast and masks its error

Recorded 2026-10-14.

- Issue: bsv-blockchain/bsv-browser#163. Pull request: bsv-blockchain/bsv-browser#164; its twin on Calgooon/bsv-browser: #37.
- The lines are owned by `bsv-blockchain/ts-stack` (`packages/wallet/wallet-toolbox/src/WalletPermissionsManager.ts`), bundled here as `@bsv/wallet-toolbox-mobile`. Issue: bsv-blockchain/ts-stack#1077. Fix: bsv-blockchain/ts-stack#1078.

## The mainnet case

- Transaction `7a9b9ef40af6c307b0c662f526860a5a4f71e6050064726a6bf4ae3654488f55`, mined in block 971068 (2026-10-14 15:43:10Z).
- Input 0 nSequence `fffffffe`, set by the page through BRC-100's `spends[0].sequenceNumber` on `signAction`. The page's `createAction` passed no `sequenceNumber`, so the template held the default `ffffffff`.
- The page received `The reference parameter must be an inprocess, outgoing action that has not been signed and shared to the network.` and reported the move as failed while it had succeeded.

## The lines and the order

`@bsv/wallet-toolbox-mobile` 2.14.4 (locked on this branch), `node_modules/@bsv/wallet-toolbox-mobile/out/index.mobile.cjs`. `SigningPolicyPermissionsManager` (`@bsv/expo-wallet-toolbox`, `core/services/signingPermissionPolicy.ts:140`) extends `WalletPermissionsManager` and does not override `signAction`.

| step         | line               | what                                                                                                                                                                                                                                                                     |
| ------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| template     | `:41744`           | createAction stores the draft: `this.pendingActionTemplates.set(reference, tx)`                                                                                                                                                                                          |
| 1. broadcast | `:42026`           | `const result = await this.underlying.signAction(...)`: the wallet applies the spends (`input.sequence = spend.sequenceNumber`), signs and broadcasts                                                                                                                    |
| 2. the check | `:42033`, `:41976` | `this.assertAuthorizedSignResult(requestArgs.reference, requestArgs.spends, result)`: `(finalized.inputs[index].sequence ?? 4294967295) !== (authorized.inputs[index].sequence ?? 4294967295)` throws `Wallet finalization substituted an authorized transaction input.` |
| 3. the abort | `:42038`, `:41990` | the catch: `await this.blockAndAbortAction(requestArgs.reference); throw error;`. `blockAndAbortAction` awaits the wallet's `abortAction`                                                                                                                                |
| the mask     | `:18210`           | `abortAction` refuses a sent action: `throw new WERR_INVALID_PARAMETER("reference", "an inprocess, outgoing action that has not been signed and shared to the network.")`. That throw leaves the catch before `throw error`                                              |

The same order is on ts-stack `main` (2.14.9): `WalletPermissionsManager.ts`, `signAction` and `assertAuthorizedSignResult`.

## Refuse before the broadcast, or honour the sequence

The maintainers would want the sequence honoured (iii), with everything that can be checked from the spends alone checked before the broadcast:

1. BRC-100 defines `SignActionSpend.sequenceNumber` for the signing step, and the SDK validates it as a uint32; refusing it would break a standard field (here, a page grinding nSequence for a covenant's sighash rule).
2. The security property is that a page cannot spend an input it was not authorized to spend; nSequence never changes which outpoint an input spends.
3. The signer accepts spends only for the caller's own unsigned inputs (`completeSignedTransaction`), and signs the wallet's inputs after the spends are applied, so a spend can set the sequence of its own input and cannot add, drop or swap one.
4. The outpoint, existing-script, output, version, lockTime and txid binding is unchanged, and a sequence the caller did not set (or other than the one it set) is still refused.
5. A refusal that only the wallet's final transaction can show still comes after the send, so its error must reach the caller, never the abort's.

## The fix (ts-stack#1078)

- `authorizedSpendSequences` checks the spends against the template (canonical index in the template, hex script, uint32 sequence) and returns each spend's `sequenceNumber`. `signAction` runs it before the wallet signs and sends; the binding reuses it.
- The binding expects, per input, the sequence the caller set, else the template's.
- `blockAndAbortAction` no longer throws: the caller gets the original error, and an action the wallet will not abort stays blocked.

ts-stack tests: `src/__tests/WalletPermissionsManager.signBinding.test.ts`, RED 8 of 8 before the fix (the abort's words after one broadcast; the wallet called for spends the binding refuses), green after; the package suite 3,294 passed, 0 failed.

## The test here

`__tests__/signActionBinding.test.ts` drives the bundled `WalletPermissionsManager.signAction` with a stand-in wallet that applies the spends, broadcasts, and refuses to abort a sent action.

| test                                                            | on 2.14.4                                                     | with the fix |
| --------------------------------------------------------------- | ------------------------------------------------------------- | ------------ |
| honours the page's `spends[vin].sequenceNumber`                 | RED: rejects with `WERR_INVALID_PARAMETER`, the abort's words | green        |
| a refusal after the send reaches the page with its own words    | RED: the abort's words                                        | green        |
| a spend outside the template is refused before the wallet signs | RED: the wallet called once                                   | green        |

"With the fix" was run by applying ts-stack#1078's change to the bundled `out/index.mobile.cjs` locally; the dependency is not patched in this repo. The suite runs only when the bundled manager keeps pending templates: on Calgooon/bsv-browser `master`, which locks `@bsv/wallet-toolbox-mobile` 2.3.2 and whose `signAction` passes straight through (no binding, so no defect), it is skipped.

## What is next

No workaround here: no in-place patch of the dependency, no fork pin. When `@bsv/wallet-toolbox-mobile` publishes ts-stack#1078, #164 bumps to that release, regenerates `package-lock.json`, and the test goes green. Calgooon/bsv-browser must not bump into 2.14.4 through 2.14.9 without it.
