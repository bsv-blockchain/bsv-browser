## ADDED Requirements

### Requirement: Currency selector in wallet settings

The wallet settings screen (`wallet-config.tsx`) SHALL display a currency selector that allows the user to choose one of: BSV (default) or USD.

#### Scenario: Default selection

- **WHEN** user opens wallet settings for the first time
- **THEN** "BSV" SHALL be shown as the selected display mode

#### Scenario: User selects USD

- **WHEN** user taps the currency selector and chooses "USD"
- **THEN** `WalletSettings.currency` SHALL be set to `"USD"` via `updateSettings()`
- **THEN** all amount displays across the app SHALL immediately reflect USD formatting

#### Scenario: User switches back to BSV

- **WHEN** user taps the currency selector and chooses "BSV"
- **THEN** `WalletSettings.currency` SHALL be set to `"BSV"` via `updateSettings()`
- **THEN** all amount displays across the app SHALL immediately reflect BSV/satoshis smart formatting

#### Scenario: Setting persists across app restarts

- **WHEN** user selects a display mode and restarts the app
- **THEN** the previously selected mode SHALL be restored from `WalletSettings`

### Requirement: Smart BSV display with threshold

In BSV mode, the `AmountDisplay` component SHALL automatically choose between satoshis and BSV format based on the magnitude of the value:

- Values < 100,000,000 satoshis (< 1 BSV) SHALL display as satoshis with locale-appropriate grouping (e.g., "50,000 satoshis")
- Values >= 100,000,000 satoshis (>= 1 BSV) SHALL display as BSV with up to 8 decimal places as needed (e.g., "1.5 BSV")

#### Scenario: Small amount in BSV mode

- **WHEN** displaying 50,000 satoshis in BSV mode with en-US locale
- **THEN** the display SHALL read "50,000 satoshis"

#### Scenario: Large amount in BSV mode

- **WHEN** displaying 150,000,000 satoshis in BSV mode with en-US locale
- **THEN** the display SHALL read "1.5 BSV"

#### Scenario: Exactly 1 BSV

- **WHEN** displaying 100,000,000 satoshis in BSV mode
- **THEN** the display SHALL read "1 BSV"

#### Scenario: German locale small amount

- **WHEN** displaying 1,234,567 satoshis in BSV mode with de-DE locale
- **THEN** the display SHALL read "1.234.567 satoshis" (period as group separator)

### Requirement: All amount displays respect the currency setting

Every location in the wallet that displays a monetary amount SHALL use the `AmountDisplay` component or the shared formatting utilities with the current `settings.currency` value. No amount display SHALL hardcode "sats" or any other unit label.

#### Scenario: Payments screen amounts

- **WHEN** user views the payments screen with currency set to USD
- **THEN** all payment amounts SHALL display in USD format

#### Scenario: Legacy payments screen amounts

- **WHEN** user views the legacy payments screen with currency set to BSV
- **THEN** all import totals, individual transaction amounts, and sent confirmations SHALL display using smart BSV/satoshis formatting

#### Scenario: Permission sheet amounts

- **WHEN** a spending permission is displayed with currency set to USD
- **THEN** line item amounts SHALL display in USD format

### Requirement: Dynamic i18n amount labels

Translation keys that reference amount units (e.g., `amount_sats`) SHALL NOT hardcode a specific unit. The label SHALL omit the unit suffix since the input/display components show their own unit labels.

#### Scenario: Amount input label is unit-neutral

- **WHEN** user has selected any display mode
- **THEN** the amount input label SHALL read "Amount" (not "Amount (sats)")

### Requirement: Locale-aware number formatting

All formatted amounts SHALL respect the device locale for decimal separators and grouping separators. The system SHALL detect the locale via `Intl.NumberFormat` and apply appropriate separators.

#### Scenario: US locale formatting

- **WHEN** the device locale is en-US and displaying 1,234,567 satoshis in BSV mode
- **THEN** the display SHALL use comma as group separator: "1,234,567 satoshis"

#### Scenario: German locale formatting

- **WHEN** the device locale is de-DE and displaying 1.5 BSV in BSV mode
- **THEN** the display SHALL use comma as decimal separator: "1,5 BSV"
