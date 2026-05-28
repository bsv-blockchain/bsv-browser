## 1. Parameterize ensureAuth and update prompt text

- [x] 1.1 Change `ensureAuth()` signature to `ensureAuth(promptMessage: string)` in `LocalStorageProvider.tsx`
- [x] 1.2 Update all existing `ensureAuth()` call sites in read/delete operations to pass `"Unlock your wallet"`

## 2. Add biometric auth to write operations

- [x] 2.1 Add `ensureAuth("Use biometric access to protect your wallet")` call to `setMnemonic` before SecureStore write
- [x] 2.2 Add `ensureAuth("Use biometric access to protect your wallet")` call to `setPassword` before SecureStore write
- [x] 2.3 Add `ensureAuth("Use biometric access to protect your wallet")` call to `setRecoveredKey` before SecureStore write
- [x] 2.4 Change return type of `setMnemonic`, `setPassword`, `setRecoveredKey` from `Promise<void>` to `Promise<boolean>` and update the `LocalStorageContextType` interface accordingly

## 3. Short-circuit reads when no wallet keys exist

- [x] 3.1 Add `hasWalletKeys` AsyncStorage flag — set to `'true'` after any successful `set*` operation in `LocalStorageProvider.tsx`
- [x] 3.2 Clear `hasWalletKeys` flag after delete operations when no secure items remain
- [x] 3.3 Add early return in `getMnemonic`, `getPassword`, `getRecoveredKey` that checks `hasWalletKeys` flag and returns `null` without calling `ensureAuth()` if flag is not set

## 4. Handle biometric denial on wallet creation

- [x] 4.1 Update `mnemonic.tsx` to check the boolean return from `setMnemonic()` and show an alert with explanation and "Try Again" / "Cancel" options when biometric is denied
- [x] 4.2 Update any other callers of `setRecoveredKey()` (e.g., `scan-shares.tsx`) to handle the `false` return similarly

## 5. First-touch date tracking

- [x] 5.1 Add `firstTouchDate` recording logic — on app mount in `_layout.tsx` (or `LocalStorageProvider`), check AsyncStorage for `firstTouchDate`; if absent, store `new Date().toISOString()`

## 6. Defer default browser prompt

- [x] 6.1 Update `DefaultBrowserPrompt.tsx` to read `firstTouchDate` from AsyncStorage and compare against a configurable threshold constant (default 3 days)
- [x] 6.2 Only show the prompt if the threshold has been crossed AND `hasShownDefaultBrowserPrompt` is not set; otherwise do nothing

## 7. Verification

- [x] 7.1 Test first launch flow: no biometric prompt, no default browser prompt, app opens in web2 mode
- [x] 7.2 Test wallet creation flow: biometric prompts with "Use biometric access to protect your wallet", denial shows retry dialog
- [x] 7.3 Test returning user flow: biometric prompts with "Unlock your wallet" on app launch
- [x] 7.4 Test default browser prompt appears after 3+ days (can test by manipulating `firstTouchDate` in AsyncStorage)
