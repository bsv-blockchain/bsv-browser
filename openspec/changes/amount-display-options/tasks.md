## 1. Exchange Rate Caching

- [ ] 1.1 Rewrite `ExchangeRateContext.tsx`: remove `Services` import and `getBsvExchangeRate`/`getFiatExchangeRate` calls. Replace with direct `fetch()` to WhatsonChain API (`https://api.whatsonchain.com/v1/bsv/main/exchangerate`). Fetch once on mount (no polling timer).
- [ ] 1.2 Add three-tier fallback: on mount, load cached rate from `AsyncStorage.getItem('cached_exchange_rate')`, parse JSON `{ usdPerBsv, timestamp }`. If no cache, use hardcoded default `usdPerBsv = 16`. Then attempt live fetch and update state + cache on success.
- [ ] 1.3 Remove `eurPerUSD`, `gbpPerUSD`, `cycleFiatFormat`, `cycleSatsFormat`, `fiatFormatIndex`, `satsFormatIndex`, `isFiatPreferred` from context state. Export only `satoshisPerUSD`.

## 2. Format Helpers Cleanup

- [ ] 2.1 In `amountFormatHelpers.ts`, remove all fiat formats except USD from `satoshisOptions.fiatFormats`. Remove all sats formats except SATS and BSV from `satoshisOptions.satsFormats`. Remove Tone variants, mBSV, EUR, GBP.
- [ ] 2.2 Simplify `formatSatoshisAsFiat()`: remove `eurPerUSD` and `gbpPerUSD` parameters and all EUR/GBP branches. USD-only.
- [ ] 2.3 Add smart `formatAmount(satoshis, currency, satoshisPerUSD, abbreviate?)` export: in BSV mode, auto-selects SATS format (< 1e8) or BSV format (>= 1e8). In USD mode, delegates to `formatSatoshisAsFiat`. All locale-aware via existing `Intl` helpers.
- [ ] 2.4 Add `parseDisplayToSatoshis(displayValue, currency, satoshisPerUSD)` export: BSV mode returns `parseInt(displayValue)` (satoshi integers). USD mode returns `Math.round(parseFloat(displayValue) * satoshisPerUSD)`.
- [ ] 2.5 Add `getUnitLabel(currency, satoshis?)` export: BSV mode returns "satoshis"/"sats" for < 1e8 or "BSV" for >= 1e8. USD mode returns "USD".

## 3. AmountDisplay Simplification

- [ ] 3.1 Update `AmountDisplay.tsx`: remove references to `eurPerUSD`, `gbpPerUSD`, `fiatFormatIndex`, `satsFormatIndex`, `isFiatPreferred` from `ExchangeRateContext`. Read only `satoshisPerUSD`.
- [ ] 3.2 Replace rendering logic with `formatAmount()` utility: pass satoshis, currency setting (default "BSV"), and satoshisPerUSD. Remove all the manual format selection and `isFiatPreferred` fallback path.

## 4. Unit-Aware Amount Input

- [ ] 4.1 Refactor `SatsAmountInput.tsx` into `AmountInput`: add `useWallet()` to read `settings.currency` and `useContext(ExchangeRateContext)` to read `satoshisPerUSD`.
- [ ] 4.2 In BSV mode: `number-pad` keyboard, integer satoshis passthrough, show "satoshis" label. In USD mode: `decimal-pad` keyboard, internal `displayValue` state in dollars, convert to satoshis on each keystroke via `parseDisplayToSatoshis`, show "USD" label.
- [ ] 4.3 When `value` prop changes externally (e.g., cleared), sync internal `displayValue` accordingly for USD mode.
- [ ] 4.4 Preserve "Max" button behavior: when `SEND_MAX_VALUE` is set, show "Entire wallet balance" regardless of currency mode.
- [ ] 4.5 Rename file from `SatsAmountInput.tsx` to `AmountInput.tsx` and update all imports.

## 5. Currency Selector in Settings

- [ ] 5.1 Add a new `GroupedSection` in `wallet-config.tsx` with a "Display Currency" expandable selector (same UX pattern as the network selector).
- [ ] 5.2 Show two options: BSV (default) and USD, with checkmark on current selection. Call `updateSettings({ ...settings, currency: value })` on selection.

## 6. Replace Hardcoded Amount Formatting

- [ ] 6.1 `payments.tsx` line ~741: replace `{payment.token.amount.toLocaleString()} sats` with `<AmountDisplay>{payment.token.amount}</AmountDisplay>`.
- [ ] 6.2 `payments.tsx` line ~980: replace `` `Sent ${sats.toLocaleString()} sats successfully` `` with formatted string using `formatAmount()`.
- [ ] 6.3 `legacy-payments.tsx` line ~334: replace import success snackbar hardcoded sats with `formatAmount()`.
- [ ] 6.4 `legacy-payments.tsx` line ~466: replace send success snackbar hardcoded sats with `formatAmount()`.
- [ ] 6.5 `legacy-payments.tsx` lines ~562, ~579, ~689: replace hardcoded sats displays with `<AmountDisplay>`.
- [ ] 6.6 `PermissionSheet.tsx` line ~116: replace `` `${item.satoshis} sats` `` with `<AmountDisplay>{item.satoshis}</AmountDisplay>`.

## 7. Update i18n Labels

- [ ] 7.1 In `translations.tsx`, update the `amount_sats` key across all 8 language blocks to remove the hardcoded "(sats)" suffix. Change to `amount` with value "Amount" (or equivalent in each language).

## 8. Update AmountInput Callers

- [ ] 8.1 `payments.tsx`: update import from `SatsAmountInput` to `AmountInput`.
- [ ] 8.2 `legacy-payments.tsx`: update import from `SatsAmountInput` to `AmountInput`.
- [ ] 8.3 `local-payments.tsx`: update import from `SatsAmountInput` to `AmountInput`.

## 9. Verification

- [ ] 9.1 Run TypeScript compilation to verify no type errors.
- [ ] 9.2 Verify no remaining references to removed exports (`eurPerUSD`, `gbpPerUSD`, `cycleFiatFormat`, `cycleSatsFormat`, `SatsAmountInput`, `isFiatPreferred`).
