## ADDED Requirements

### Requirement: Biometric auth on secure write operations

The system SHALL call biometric authentication before writing wallet keys to SecureStore. The prompt message SHALL be "Use biometric access to protect your wallet".

#### Scenario: User creates a wallet and stores mnemonic

- **WHEN** `setMnemonic()` is called with a mnemonic string
- **THEN** the system SHALL call `ensureAuth("Use biometric access to protect your wallet")` before writing to SecureStore
- **AND** the mnemonic SHALL only be written if biometric authentication succeeds

#### Scenario: User stores a password

- **WHEN** `setPassword()` is called with a password string
- **THEN** the system SHALL call `ensureAuth("Use biometric access to protect your wallet")` before writing to SecureStore
- **AND** the password SHALL only be written if biometric authentication succeeds

#### Scenario: User stores a recovered key

- **WHEN** `setRecoveredKey()` is called with a WIF string
- **THEN** the system SHALL call `ensureAuth("Use biometric access to protect your wallet")` before writing to SecureStore
- **AND** the recovered key SHALL only be written if biometric authentication succeeds

### Requirement: Write operations return success/failure

The `setMnemonic`, `setPassword`, and `setRecoveredKey` functions SHALL return `Promise<boolean>` indicating whether the operation succeeded (biometric auth passed and SecureStore write completed).

#### Scenario: Biometric auth succeeds on write

- **WHEN** a `set*` operation is called and the user approves biometric auth
- **THEN** the function SHALL return `true`

#### Scenario: Biometric auth denied on write

- **WHEN** a `set*` operation is called and the user denies biometric auth
- **THEN** the function SHALL return `false`
- **AND** nothing SHALL be written to SecureStore

### Requirement: Contextual biometric prompt text

The `ensureAuth` function SHALL accept a `promptMessage` parameter that is passed to the native biometric authentication dialog.

#### Scenario: Write operation prompt text

- **WHEN** biometric auth is triggered by a write operation
- **THEN** the native prompt SHALL display "Use biometric access to protect your wallet"

#### Scenario: Read operation prompt text

- **WHEN** biometric auth is triggered by a read or delete operation
- **THEN** the native prompt SHALL display "Unlock your wallet"

### Requirement: No biometric prompt when no wallet keys exist

The system SHALL maintain a `hasWalletKeys` flag in AsyncStorage. Read operations (`getMnemonic`, `getPassword`, `getRecoveredKey`) SHALL check this flag before calling `ensureAuth()`. If the flag is not set, the read operation SHALL return `null` without triggering biometric auth.

#### Scenario: First app launch with no wallet

- **WHEN** the app launches for the first time and no wallet has been created
- **AND** the auto-build effect calls `getMnemonic()`
- **THEN** `getMnemonic()` SHALL return `null` without displaying a biometric prompt

#### Scenario: App launch after wallet creation

- **WHEN** the app launches and `hasWalletKeys` is `'true'` in AsyncStorage
- **AND** the auto-build effect calls `getMnemonic()`
- **THEN** `getMnemonic()` SHALL call `ensureAuth("Unlock your wallet")` and proceed normally

#### Scenario: hasWalletKeys flag set on successful write

- **WHEN** a `set*` operation completes successfully (biometric auth passed, SecureStore write succeeded)
- **THEN** the system SHALL set `hasWalletKeys` to `'true'` in AsyncStorage

#### Scenario: hasWalletKeys flag cleared on delete

- **WHEN** all secure items are deleted (mnemonic, password, and recovered key)
- **THEN** the system SHALL remove the `hasWalletKeys` flag from AsyncStorage

### Requirement: Graceful biometric denial on wallet creation

When biometric authentication is denied during wallet creation, the calling screen SHALL display an explanation and provide a retry option.

#### Scenario: User denies biometric during wallet creation

- **WHEN** the user is on the mnemonic screen and creates/imports a wallet
- **AND** `setMnemonic()` returns `false` (biometric denied)
- **THEN** the screen SHALL display an alert explaining that biometric access is required to protect wallet keys
- **AND** the alert SHALL include a "Try Again" button that re-invokes the store operation
- **AND** the alert SHALL include a "Cancel" button that returns to the previous state without creating the wallet
