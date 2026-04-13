## Context

The BSV Browser wallet is a React Native (Expo) app that uses `WalletSettings.currency` to control amount display format. The `AmountDisplay` component and `amountFormatHelpers.ts` already support multiple formats, but:

1. **No settings UI** exists to let users change `currency` -- it defaults to empty string (SATS behavior).
2. **`SatsAmountInput`** only accepts integer satoshis via `number-pad` keyboard.
3. **~8 locations** bypass `AmountDisplay` with hardcoded `.toLocaleString() + " sats"`.
4. **`ExchangeRateContext`** depends on `Services` from `@bsv/wallet-toolbox-mobile` which calls remote services that may not exist for local storage wallets. It also polls every 5 minutes and maintains EUR/GBP rates we don't need.
5. **`WalletContext.getExchangeRate()`** already fetches from WhatsonChain API with a $16.75 hardcoded fallback -- this is the proven approach.
6. The format helpers carry dead weight: EUR, GBP, mBSV, and "Tone" (underscore separator) variants.

## Goals / Non-Goals

**Goals:**

- Two display modes: BSV (default) and USD, selectable in wallet settings
- Smart BSV display: < 100,000,000 sats shows as satoshis, >= 100,000,000 shows as BSV
- Locale-aware number formatting (respect device locale for decimal/group separators)
- Unit-aware amount input (satoshi integers for BSV mode, dollar decimals for USD mode)
- Every amount in the wallet respects the chosen display mode
- Reliable USD exchange rate via WhatsonChain with cached + hardcoded fallbacks

**Non-Goals:**

- Supporting EUR, GBP, or other fiat currencies (no reliable free API)
- Supporting mBSV or Tone formatting variants
- Real-time exchange rate polling (fetch once on mount is sufficient)
- Changing how satoshis are stored or transmitted -- all internal values remain integer satoshis

## Decisions

### 1. Two modes only: BSV (default) and USD

**Choice**: The user picks between "BSV" and "USD". There is no separate "satoshis" option. BSV mode uses a smart threshold: values below 1 BSV (< 100,000,000 sats) display as satoshis with locale grouping (e.g., "50,000 satoshis"), values at or above 1 BSV display as BSV with up to 8 decimal places (e.g., "1.5 BSV").

**Rationale**: Satoshis and BSV are the same unit at different scales. Merging them with automatic threshold selection gives users the most readable format without a third option. Small amounts are more intuitive as "50,000 satoshis" than "0.0005 BSV", while large amounts are more intuitive as "2.5 BSV" than "250,000,000 satoshis".

### 2. Locale-aware separators

**Choice**: Use `Intl.NumberFormat` with the device's detected locale for all number formatting. The existing `getLocaleDefault()` and `getSeparator()` helpers in `amountFormatHelpers.ts` already detect the locale. All hardcoded separator overrides (Tone variants) are removed.

**Rationale**: A user in Germany sees "1.234,56" while a US user sees "1,234.56". This is standard i18n practice. The existing locale detection code handles this; we just need to stop overriding it.

### 3. Exchange rate fetched once on context mount

**Choice**: Fetch from WhatsonChain API once during `ExchangeRateContext` mount. Cache to AsyncStorage. No polling interval.

**Rationale**: The WhatsonChain API is rate-limited (3 req/s). Fetching once per app launch is well within limits. The exchange rate doesn't need real-time accuracy for a display preference.

### 4. Three-tier fallback: live -> cached -> hardcoded

**Choice**: On mount, immediately load AsyncStorage cached rate so UI isn't blank. Then attempt live fetch. On success, update state and cache. On failure, cached or hardcoded value remains.

**Hardcoded default**: `usdPerBsv = 16` (~6,250,000 sats/USD).

### 5. Remove `Services` dependency from `ExchangeRateContext`

**Choice**: Replace `services.getBsvExchangeRate()` with direct `fetch()` to `https://api.whatsonchain.com/v1/bsv/main/exchangerate`. Remove EUR/GBP entirely.

### 6. Refactor `SatsAmountInput` in-place

**Choice**: Rename to `AmountInput`, same file path (renamed). In BSV mode: `number-pad`, integer satoshis. In USD mode: `decimal-pad`, dollar amount, converts via exchange rate. Contract preserved: `onChangeText` always emits satoshi strings.

### 7. AmountInput internal display value management

**Choice**: In USD mode, the component maintains an internal `displayValue` (what user types in dollars) separate from the `value` prop (satoshis). On each keystroke, display value converts to satoshis and emits. When `value` prop changes externally (e.g., "Max"), display value recomputes from satoshis.

In BSV mode, the value IS satoshis directly, so no conversion needed -- just pass through.

## Risks / Trade-offs

- **[Floating-point precision in USD->sats conversion]** -> Use `Math.round()` on the final satoshi value. The conversion is: `sats = Math.round(usdAmount * satoshisPerUSD)`.

- **[Stale exchange rate]** -> Rate only updates on mount. Acceptable for display; actual transactions are always in satoshis.

- **[Smart threshold edge case]** -> A value hovering around 100,000,000 sats (1 BSV) might flip between formats if it changes slightly. This is unlikely in practice and the transition is natural (99,999,999 satoshis -> 1.00000000 BSV).

- **[Toast messages are strings, not JSX]** -> Hardcoded "sats" in toast templates (e.g., `` `Sent ${sats} sats` ``) cannot use `<AmountDisplay>`. Use `formatAmount()` utility directly with current settings.
