## ADDED Requirements

### Requirement: Amount input adapts to selected currency

The `AmountInput` component (refactored from `SatsAmountInput`) SHALL adapt its keyboard type, decimal handling, and unit label based on the user's selected currency from `WalletSettings.currency`.

#### Scenario: BSV mode input

- **WHEN** the user's currency setting is BSV (or unset/default)
- **THEN** the input SHALL use `number-pad` keyboard (integers only)
- **THEN** the input SHALL display a "satoshis" unit label
- **THEN** the value emitted via `onChangeText` SHALL be the raw satoshi integer string

#### Scenario: USD mode input

- **WHEN** the user's currency setting is USD
- **THEN** the input SHALL use `decimal-pad` keyboard
- **THEN** the input SHALL accept up to 2 decimal places
- **THEN** the input SHALL display a "USD" unit label
- **THEN** the value emitted via `onChangeText` SHALL be the satoshi equivalent (converted using the current exchange rate and rounded)

### Requirement: Amount input always emits satoshis

Regardless of the display mode, the `AmountInput` component SHALL always emit integer satoshi values as strings via its `onChangeText` callback. Callers SHALL NOT need to perform any unit conversion.

#### Scenario: USD input conversion

- **WHEN** user types "1.00" in USD mode and the exchange rate is 6,250,000 sats/USD
- **THEN** `onChangeText` SHALL be called with `"6250000"` (Math.round(1.00 \* 6250000))

#### Scenario: BSV mode passthrough

- **WHEN** user types "50000" in BSV mode
- **THEN** `onChangeText` SHALL be called with `"50000"`

### Requirement: Max button preserved

The "Send Max" button SHALL continue to work by setting the value to `SEND_MAX_VALUE`. When active, the input SHALL display "Entire wallet balance" regardless of currency mode.

#### Scenario: Max button in USD mode

- **WHEN** user taps "Max" while in USD mode
- **THEN** the input SHALL display "Entire wallet balance" (not a USD-converted max value)
- **THEN** `onChangeText` SHALL be called with `SEND_MAX_VALUE`

### Requirement: Reverse parsing utility

A `parseDisplayToSatoshis(displayValue, currency, satoshisPerUSD)` utility function SHALL be exported from `amountFormatHelpers.ts` to convert user-entered display values back to satoshi integers.

#### Scenario: Parse USD string to satoshis

- **WHEN** called with `("1.50", "USD", 6250000)`
- **THEN** SHALL return `9375000` (Math.round(1.50 \* 6250000))

#### Scenario: Parse BSV/SATS string to satoshis

- **WHEN** called with `("50000", "BSV", _)`
- **THEN** SHALL return `50000` (passthrough as integer)
