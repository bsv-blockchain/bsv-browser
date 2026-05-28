## Why

The app currently prompts users with biometric authentication ("Decrypt wallet keys") and a "Set as Default Browser" dialog immediately on first launch. This violates Apple's guidance to only request permissions in the context of an action the user is actively taking. Users who don't yet understand the app are likely to deny these prompts, leaving the wallet unable to initialize (biometric denial) or wasting the one-shot default browser prompt (low acceptance rate). The biometric prompt also fires on first launch when there are no wallet keys stored at all, making it nonsensical.

## What Changes

- **Biometric prompt on write path**: Add `ensureAuth()` to `setMnemonic`, `setPassword`, and `setRecoveredKey` so the biometric prompt fires when the user creates a wallet -- a moment they understand and accept the need for secure storage. Prompt text: "Use biometric access to protect your wallet".
- **Biometric prompt on read path**: Change the existing prompt text from "Decrypt wallet keys" to "Unlock your wallet". Short-circuit `getMnemonic`/`getRecoveredKey`/`getPassword` to skip biometric auth when no keys are stored (avoid phantom prompt on first launch).
- **Biometric denial handling**: When biometric auth is denied on the write path (wallet creation), show an explanation and allow retry rather than silently failing.
- **First-touch date tracking**: Record a `firstTouchDate` timestamp in AsyncStorage on first app launch. No other user data is stored -- just the date.
- **Deferred default browser prompt**: Replace the current 2-second-after-first-launch prompt with a prompt that only fires after a configurable number of days (e.g., 3-5 days) have passed since `firstTouchDate`.
- **Parameterized auth prompt**: Make `ensureAuth()` accept a prompt string parameter so callers can provide context-appropriate messaging.

## Capabilities

### New Capabilities

- `deferred-biometric-auth`: Biometric authentication is deferred until contextually appropriate -- write operations prompt with protection framing, read operations prompt with unlock framing, and no prompt fires when no secure data exists.
- `deferred-default-browser`: Default browser prompt is delayed until the user has used the app for a configurable number of days, tracked via a first-touch date stored in AsyncStorage.

### Modified Capabilities

## Impact

- `context/LocalStorageProvider.tsx`: Core changes to `ensureAuth()` (parameterized prompt), all `set*` functions (add auth), all `get*` functions (short-circuit when empty), tracking flags in AsyncStorage.
- `components/onboarding/DefaultBrowserPrompt.tsx`: Replace immediate prompt with date-based delay logic.
- `app/_layout.tsx`: May need to wire first-touch date recording on mount.
- `app/auth/mnemonic.tsx`: Handle biometric denial during wallet creation (explain + retry).
- `context/WalletContext.tsx`: Wallet auto-build path may need adjustment to avoid prompting when no keys exist.
