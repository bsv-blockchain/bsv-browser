## ADDED Requirements

### Requirement: Per-tab desktop mode state

Each browser tab SHALL independently track whether desktop mode is enabled via an `isDesktopMode` boolean field on the `Tab` type. New tabs SHALL default to `isDesktopMode: false`.

#### Scenario: New tab has desktop mode off by default

- **WHEN** a new tab is created
- **THEN** `isDesktopMode` is `false`

#### Scenario: Toggling does not affect other tabs

- **WHEN** the user enables desktop mode on tab A
- **THEN** tab B's `isDesktopMode` remains unchanged

### Requirement: Desktop user agent selection

When desktop mode is enabled for a tab, the WebView SHALL send a desktop-class user agent string for that tab's requests. When desktop mode is disabled, the WebView SHALL send a mobile user agent string.

#### Scenario: Mobile UA used by default

- **WHEN** `isDesktopMode` is `false`
- **THEN** the WebView user agent contains `Mobile` and identifies as a mobile device

#### Scenario: Desktop UA used when desktop mode is on

- **WHEN** `isDesktopMode` is `true`
- **THEN** the WebView user agent does NOT contain `Mobile` and identifies as a desktop/Mac or Linux machine

#### Scenario: UA change triggers page reload

- **WHEN** `isDesktopMode` is toggled
- **THEN** the current page reloads automatically with the new user agent

### Requirement: Desktop mode toggle in MenuPopover

The MenuPopover SHALL display the Browser row as a split row: a full-width `Browser` button on the left and a desktop-mode icon button on the right, separated by a hairline vertical divider — matching the existing `Tabs | [+]` split-row pattern.

#### Scenario: Browser button navigates to browser-menu

- **WHEN** the user taps the `Browser` label area
- **THEN** the popover dismisses and the browser-menu sheet opens (existing behaviour preserved)

#### Scenario: Desktop icon button reflects current state — off

- **WHEN** `isDesktopMode` is `false`
- **THEN** the desktop icon SHALL render as `desktop-outline` (unfilled)

#### Scenario: Desktop icon button reflects current state — on

- **WHEN** `isDesktopMode` is `true`
- **THEN** the desktop icon SHALL render as `desktop` (filled)

#### Scenario: Tapping desktop icon toggles mode and dismisses popover

- **WHEN** the user taps the desktop icon button
- **THEN** `isDesktopMode` on the active tab is toggled, and the popover is dismissed

### Requirement: Graceful fallback for legacy persisted tabs

Tabs loaded from AsyncStorage that were persisted before `isDesktopMode` was introduced SHALL default to `isDesktopMode: false` without errors or data loss.

#### Scenario: Old tab data missing isDesktopMode field

- **WHEN** a tab is loaded from storage without an `isDesktopMode` field
- **THEN** the tab behaves as if `isDesktopMode` is `false`
