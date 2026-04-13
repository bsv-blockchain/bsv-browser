## Why

All monetary amounts in the wallet are displayed and input as raw satoshis, with ~8 places hardcoding `.toLocaleString() + " sats"` and bypassing the existing `AmountDisplay` component. The infrastructure (`AmountDisplay`, `ExchangeRateContext`, `amountFormatHelpers`, `WalletSettings.currency`) exists but has no UI for selection, inconsistent adoption, and the input component only accepts raw satoshi integers. The `ExchangeRateContext` depends on a remote `Services` class that may not work with local storage wallets.

## What Changes

- **Two display modes: BSV (default) and USD.** BSV mode uses smart formatting: amounts < 100,000,000 satoshis display as satoshis (e.g., "50,000 satoshis"), amounts >= 100,000,000 display as BSV (e.g., "1.5 BSV"). USD mode converts using an exchange rate.
- Add a **currency selector** to wallet settings (`wallet-config.tsx`) allowing the user to choose BSV or USD, persisted via `WalletSettings.currency`.
- Refactor `SatsAmountInput` into a unit-aware **`AmountInput`** component. In BSV mode the input accepts satoshi integers. In USD mode it accepts dollar amounts with decimals and converts internally.
- **Locale-aware formatting**: all number formatting SHALL respect the device locale for decimal and grouping separators (e.g., comma vs period for decimals in Germany).
- Replace all ~8 hardcoded `.toLocaleString() + " sats"` occurrences across `payments.tsx`, `legacy-payments.tsx`, and `PermissionSheet.tsx` with the `AmountDisplay` component.
- **Simplify `ExchangeRateContext`**: remove the `Services` dependency and EUR/GBP rates. Fetch USD/BSV rate from WhatsonChain API once on context mount, cache to AsyncStorage, with hardcoded $16/BSV fallback.
- **Clean up `amountFormatHelpers`**: remove EUR, GBP, mBSV, and Tone format variants. Implement smart BSV/satoshis threshold display.
- Update i18n translation keys that hardcode "(sats)" labels.

## Capabilities

### New Capabilities

- `currency-selection-setting`: Settings UI for choosing BSV or USD display mode, persisted via `WalletSettings.currency`.
- `unit-aware-amount-input`: Amount input component that adapts to BSV (satoshi integers) or USD (dollar decimals) mode, always converting to satoshis internally.
- `exchange-rate-caching`: Fetch USD/BSV rate from WhatsonChain once on mount, persist to AsyncStorage with hardcoded $16/BSV fallback.

### Modified Capabilities

<!-- No existing specs to modify -->

## Impact

- **Components**: `SatsAmountInput` (major refactor -> `AmountInput`), `AmountDisplay` (simplify + smart threshold logic), `PermissionSheet`
- **Screens**: `wallet-config.tsx` (new setting row), `payments.tsx`, `legacy-payments.tsx`, `local-payments.tsx`, `transactions.tsx` (replace hardcoded formatting)
- **Context**: `ExchangeRateContext` (rewrite -- remove Services, add AsyncStorage caching + WhatsonChain fetch), `WalletContext` (no changes, `updateSettings` already exists)
- **Utils**: `amountFormatHelpers.ts` (remove EUR/GBP/mBSV/Tone, add smart threshold display, locale-aware)
- **i18n**: `translations.tsx` (update `amount_sats` key across all 8 languages)
- **Dependencies**: No new external dependencies required
