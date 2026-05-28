## ADDED Requirements

### Requirement: First-touch date tracking

The system SHALL record a `firstTouchDate` in AsyncStorage on the first app launch. The value SHALL be an ISO 8601 date string. If `firstTouchDate` already exists, it SHALL NOT be overwritten.

#### Scenario: First app launch

- **WHEN** the app launches for the first time
- **AND** no `firstTouchDate` exists in AsyncStorage
- **THEN** the system SHALL store the current date/time as `firstTouchDate` in AsyncStorage

#### Scenario: Subsequent app launch

- **WHEN** the app launches and `firstTouchDate` already exists in AsyncStorage
- **THEN** the system SHALL NOT modify the stored `firstTouchDate`

### Requirement: Default browser prompt deferred by days

The default browser prompt SHALL NOT be shown until a configurable number of days have elapsed since `firstTouchDate`. The default threshold SHALL be 3 days.

#### Scenario: App launch within threshold period

- **WHEN** the app launches and fewer than 3 days have passed since `firstTouchDate`
- **THEN** the default browser prompt SHALL NOT be shown

#### Scenario: App launch after threshold period (first time)

- **WHEN** the app launches and 3 or more days have passed since `firstTouchDate`
- **AND** the default browser prompt has not been shown before
- **THEN** the default browser prompt SHALL be shown

#### Scenario: App launch after threshold period (already shown)

- **WHEN** the app launches and 3 or more days have passed since `firstTouchDate`
- **AND** the default browser prompt has already been shown (either accepted or declined)
- **THEN** the default browser prompt SHALL NOT be shown again

### Requirement: Default browser prompt behavior unchanged

The content, buttons, and actions of the default browser prompt itself SHALL remain unchanged. Only the timing of when it appears is affected by this change.

#### Scenario: User accepts default browser prompt

- **WHEN** the deferred default browser prompt is shown
- **AND** the user taps "Set as Default"
- **THEN** the system SHALL open platform-specific settings to set the default browser
- **AND** the prompt SHALL be marked as shown

#### Scenario: User declines default browser prompt

- **WHEN** the deferred default browser prompt is shown
- **AND** the user taps "Not Now"
- **THEN** the prompt SHALL be marked as shown and not appear again

### Requirement: Manual default browser prompt unaffected

The manual default browser prompt (accessible from Settings) SHALL continue to work independently of the deferred timing logic.

#### Scenario: User triggers manual prompt from settings

- **WHEN** the user manually triggers the default browser prompt from app settings
- **THEN** the prompt SHALL appear immediately regardless of `firstTouchDate` or threshold
