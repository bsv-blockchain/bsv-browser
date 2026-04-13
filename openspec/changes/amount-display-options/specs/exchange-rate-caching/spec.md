## ADDED Requirements

### Requirement: Fetch exchange rate from WhatsonChain on mount

The `ExchangeRateContext` SHALL fetch the USD/BSV exchange rate from `https://api.whatsonchain.com/v1/bsv/main/exchangerate` once when the context mounts. It SHALL NOT poll on a timer.

#### Scenario: Successful fetch on mount

- **WHEN** the `ExchangeRateContext` mounts and the WhatsonChain API is reachable
- **THEN** the context SHALL fetch the exchange rate and update `satoshisPerUSD` accordingly
- **THEN** the fetched rate SHALL be cached to AsyncStorage

#### Scenario: API unreachable on mount

- **WHEN** the `ExchangeRateContext` mounts and the WhatsonChain API is unreachable
- **THEN** the context SHALL fall back to the cached AsyncStorage rate if available
- **THEN** if no cached rate exists, the context SHALL use the hardcoded default ($16/BSV)

### Requirement: Three-tier fallback chain

The exchange rate SHALL be resolved using the following priority: (1) live WhatsonChain API fetch, (2) AsyncStorage cached rate, (3) hardcoded default of $16/BSV (~6,250,000 sats/USD).

#### Scenario: First launch with no network

- **WHEN** the app launches for the first time with no network connectivity
- **THEN** `satoshisPerUSD` SHALL be set to `6250000` (100,000,000 / 16)
- **THEN** USD amounts SHALL display using this default rate

#### Scenario: Subsequent launch with no network

- **WHEN** the app launches without network but has a previously cached rate
- **THEN** `satoshisPerUSD` SHALL be set to the cached value

### Requirement: Cache exchange rate to AsyncStorage

After each successful fetch from WhatsonChain, the context SHALL write the rate and timestamp to AsyncStorage under the key `cached_exchange_rate` as a JSON string with `{ usdPerBsv, timestamp }` fields.

#### Scenario: Cache write after successful fetch

- **WHEN** a live rate of $15.16/BSV is fetched successfully
- **THEN** AsyncStorage SHALL contain `{ "usdPerBsv": 15.16, "timestamp": <ISO string> }` under key `cached_exchange_rate`

#### Scenario: Cache read on mount

- **WHEN** the context mounts and AsyncStorage contains a cached rate
- **THEN** the cached rate SHALL be loaded into state immediately (before the live fetch attempt)

### Requirement: Remove Services dependency and EUR/GBP rates

The `ExchangeRateContext` SHALL NOT depend on the `Services` class from `@bsv/wallet-toolbox-mobile`. It SHALL NOT maintain `eurPerUSD` or `gbpPerUSD` state. Only USD SHALL be supported as a fiat currency.

#### Scenario: No EUR/GBP in context state

- **WHEN** any component reads the `ExchangeRateContext`
- **THEN** only `satoshisPerUSD` SHALL be available as an exchange rate

### Requirement: Remove unused format cycling

The `ExchangeRateContext` SHALL NOT expose `cycleFiatFormat`, `cycleSatsFormat`, `fiatFormatIndex`, or `satsFormatIndex`. Display format is controlled entirely by `WalletSettings.currency`.

#### Scenario: No format cycling in context

- **WHEN** any component reads the `ExchangeRateContext`
- **THEN** there SHALL be no `cycleFiatFormat`, `cycleSatsFormat`, `fiatFormatIndex`, or `satsFormatIndex` properties
