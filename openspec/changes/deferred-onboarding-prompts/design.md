## Context

The app currently fires two disruptive prompts on first launch:

1. **Biometric auth** ("Decrypt wallet keys") -- triggered by the auto-build effect in `WalletContext.tsx:1216-1240` which calls `getMnemonic()` -> `ensureAuth()` even when SecureStore is empty. The user has no wallet, no context for why biometrics are needed, and the prompt text references "wallet keys" they don't have.

2. **Default browser** -- a `setTimeout(…, 2000)` in `DefaultBrowserPrompt.tsx:102-104` shows an alert 2 seconds after first mount. No relationship to user intent.

Both prompts violate Apple's HIG guidance: permission requests should be tied to user-initiated actions so the user understands and is likely to accept.

### Current architecture

- `LocalStorageProvider.tsx` owns all secure storage and biometric auth via `ensureAuth()`.
- `ensureAuth()` has a hardcoded prompt string, a session-scoped `authenticatedRef` latch (one Face ID per app session), and a deduplication mechanism via `authInProgress`.
- Write operations (`setMnemonic`, `setPassword`, `setRecoveredKey`) do NOT call `ensureAuth()`.
- Read/delete operations DO call `ensureAuth()`.
- `DefaultBrowserPrompt` is a renderless component mounted in `_layout.tsx` that fires once ever, gated by an AsyncStorage boolean.

## Goals / Non-Goals

**Goals:**

- Biometric prompt never fires unless the user has wallet keys stored or is actively storing them
- Biometric prompt text reflects the action context: "protect" on writes, "unlock" on reads
- Default browser prompt fires only after the user has used the app for several days
- Biometric denial during wallet creation is handled gracefully with explanation and retry
- A `firstTouchDate` is recorded in AsyncStorage on first launch for scheduling deferred prompts

**Non-Goals:**

- Changing the wallet creation flow itself (screens, mnemonic generation, etc.)
- Changing the SecureStore accessibility level or keychain configuration
- Adding a full onboarding wizard or tutorial
- Changing the `NSFaceIDUsageDescription` in app.json (though it could be improved separately)
- Re-prompting for default browser if the user previously declined

## Decisions

### 1. Parameterize `ensureAuth()` with a prompt string

**Decision**: `ensureAuth(promptMessage: string)` accepts the prompt text from callers.

**Rationale**: Different operations have different user-facing contexts. "Use biometric access to protect your wallet" (write) vs "Unlock your wallet" (read/delete) sets the right expectation. A single hardcoded string can't serve both.

**Alternative considered**: Two separate auth functions (`ensureAuthForWrite`/`ensureAuthForRead`). Rejected -- unnecessary duplication; a parameter is simpler and the session latch means only the first call in a session actually shows the prompt.

### 2. Add `ensureAuth()` to write operations

**Decision**: `setMnemonic`, `setPassword`, and `setRecoveredKey` will call `ensureAuth("Use biometric access to protect your wallet")` before writing to SecureStore.

**Rationale**: This is the ideal moment for biometric auth -- the user just created or imported a wallet and understands they're securing something valuable. The prompt frames it as their action ("Use biometric access to protect...") not the app's demand.

### 3. Track `hasWalletKeys` flag in AsyncStorage to gate read-path biometrics

**Decision**: Maintain a non-secure `hasWalletKeys` boolean in AsyncStorage. Set it to `'true'` after any successful `set*` operation. Clear it after all `delete*` operations. Check it in `get*` operations before calling `ensureAuth()`.

**Rationale**: We cannot check SecureStore for key existence without potentially triggering system-level keychain auth on some devices. A non-secure flag lets us cheaply short-circuit the `get*` -> `ensureAuth()` path when we know nothing is stored. This eliminates the phantom biometric prompt on first launch.

**Alternative considered**: Calling `SecureStore.getItemAsync()` without `ensureAuth()` to check existence. Rejected -- on some iOS configurations, any SecureStore access can trigger keychain UI. The AsyncStorage flag is zero-risk.

**Security note**: The `hasWalletKeys` flag reveals only that keys exist, not their content. This is not sensitive -- an attacker with device access can already observe app behavior.

### 4. First-touch date in AsyncStorage

**Decision**: On app mount, check for `firstTouchDate` in AsyncStorage. If absent, store `new Date().toISOString()`. This is the only data point needed for deferred prompts.

**Rationale**: Minimal data, maximum utility. We don't need launch counts, session durations, or any other telemetry. Just one date to answer "has this user been around long enough to understand the app?"

### 5. Default browser prompt after N days

**Decision**: `DefaultBrowserPrompt` reads `firstTouchDate` and compares against a threshold (configurable constant, default 3 days). If fewer days have passed, it does nothing. The existing `hasShownDefaultBrowserPrompt` flag is preserved to ensure the prompt only fires once.

**Rationale**: 3 days provides several sessions of use without being so long the user forgets about the app. The prompt will fire on the first app launch after the threshold is crossed.

**Alternative considered**: Counting app launches instead of days. Rejected -- a user might launch 20 times in day one and still not be ready. Calendar time better reflects "settling in."

### 6. Biometric denial handling on write path

**Decision**: When `ensureAuth()` returns `false` during a `set*` operation, the calling code (e.g., `mnemonic.tsx`) should show an alert explaining that biometric access is required to protect wallet keys, with a "Try Again" option that re-invokes the operation.

**Rationale**: Silent failure after a user just went through wallet creation is a terrible experience. The user needs to understand that biometrics is required for the wallet to function, and they need a way to retry without starting over.

**Implementation note**: The `set*` functions should return a boolean indicating success/failure so callers can react. Currently they return `Promise<void>`.

## Risks / Trade-offs

- **[Risk] `hasWalletKeys` flag gets out of sync with SecureStore** -> Mitigation: Set the flag _after_ successful SecureStore write, clear it _after_ successful delete. If the app crashes between SecureStore write and flag set, the flag will be false but keys exist -- next launch will skip biometric (no prompt) but `getMnemonic()` will return null (no keys found), which is the same behavior as today without keys. On the next wallet creation, the flag gets set correctly. The worst case is a missed biometric prompt on one launch, not data loss.

- **[Risk] User denies biometric on wallet creation and gets stuck** -> Mitigation: Show explanation with retry. If they persistently deny, they simply can't create a wallet -- the app continues working as a web2 browser. This is better than the current state where denial on first launch breaks wallet initialization on all subsequent launches.

- **[Risk] 3-day default browser delay means some users never see the prompt** -> This is acceptable. Users who abandon the app within 3 days were unlikely to set it as default anyway. The prompt reaching engaged users at the right time is more valuable than reaching all users at the wrong time.
