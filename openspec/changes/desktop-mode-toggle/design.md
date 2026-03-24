## Context

The browser currently sends a static, hardcoded mobile user agent string for every tab on both iOS and Android. The `userAgent` prop on the single `<WebView>` instance in `app/index.tsx` is a plain string literal. There is no per-tab concept of rendering mode. Websites that detect mobile UAs (e.g., `google.com`, `twitter.com`) serve a reduced mobile experience regardless of user preference.

The `Tab` type in `shared/types/browser.ts` already carries per-tab navigation state (`canGoBack`, `canGoForward`, `isLoading`). MobX observes mutations on each tab object. The `WebView` re-renders when its `userAgent` prop value changes, which triggers a full page reload automatically — no explicit `.reload()` call needed.

## Goals / Non-Goals

**Goals:**

- Per-tab desktop mode toggle (each tab independently switchable).
- Single desktop-mode icon button in the MenuPopover `Browser` split row.
- Clear visual state — filled vs. outline icon indicates current mode.
- Page reloads automatically when UA switches (leveraging WebView's prop-change behaviour).
- Icon state is visible to the user in the popover before and after toggle.

**Non-Goals:**

- Persisting desktop mode across app restarts (not required for v1; tabs are already persisted but `isDesktopMode` will reset to `false` on restart).
- Separate desktop UA strings per website or domain-level preferences.
- Android-specific `setSupportMultipleWindows` / `requestDesktopSite` native bridge calls (UA swap is sufficient for the common case).
- Animated transition between mobile and desktop layouts.

## Decisions

### D1: Store `isDesktopMode` on the `Tab` object (not in a separate context/store)

Each tab already owns its navigation state. Adding `isDesktopMode: boolean` directly to `Tab` keeps all per-tab state in one place and avoids a new context or store-level map. MobX's `makeAutoObservable` already wraps the tabs array and its nested objects, so mutations propagate to observers automatically.

_Alternative considered_: A `Map<tabId, boolean>` on `TabStore` — rejected because it splits related state and requires extra lookup indirection.

### D2: Derive `userAgent` dynamically in `app/index.tsx`

Replace the static UA string with a short ternary:

```ts
userAgent={
  activeTab?.isDesktopMode
    ? (Platform.OS === 'ios' ? DESKTOP_UA_IOS : DESKTOP_UA_ANDROID)
    : (Platform.OS === 'ios' ? MOBILE_UA_IOS  : MOBILE_UA_ANDROID)
}
```

Constants are defined at the top of `index.tsx` (or a shared file). When `isDesktopMode` flips, MobX triggers a re-render; the `userAgent` value changes; the WebView reloads automatically.

_Alternative considered_: Calling `webviewRef.current.reload()` after a state update — rejected because it adds ordering complexity and the prop-change reload is guaranteed by React Native WebView's implementation.

### D3: Browser row becomes a split row (`Browser | desktop icon`)

The existing `Tabs | [+]` split-row pattern is reused exactly. The `Browser` touchable occupies `flex: 1` (navigates to browser-menu sheet on press); the desktop icon button sits right of a hairline divider. This is purely additive to the existing layout.

Icon logic:

- `desktop-outline` when `isDesktopMode === false` (off)
- `desktop` (filled) when `isDesktopMode === true` (on)

### D4: Dismiss popover on toggle

Because the page reloads immediately after the UA changes, keeping the popover open would leave it floating over a loading page. Dismissing provides a clean transition. The user sees the reload as implicit confirmation that the mode changed.

### D5: `isDesktopMode` defaults to `false` and is NOT persisted

`TabStore.createTab()` sets `isDesktopMode: false`. `saveTabs()` already serialises the tabs array to AsyncStorage; since `isDesktopMode` will be in the `Tab` object, it will be persisted automatically. On restore, it will read back the correct value.

## Risks / Trade-offs

- **UA spoofing is not a guarantee**: Some sites use screen-width or touch-event heuristics in addition to the UA. Switching the UA will help most sites but not all. → Acceptable for v1; the feature is a best-effort enhancement.
- **Page reload on toggle**: The user loses scroll position and any unsaved form state. → This is the same behaviour as Safari's "Request Desktop Site" and is expected.
- **`isDesktopMode` added to `Tab` type**: Any existing persisted tabs loaded from AsyncStorage will not have this field. `isDesktopMode` must be read with `?? false` fallback wherever it is accessed to handle legacy serialised data gracefully.

## Migration Plan

No migration required. The `Tab` type change is additive; old persisted data without `isDesktopMode` will default to `false` via the `?? false` fallback. No database migrations or feature flags needed.

## Open Questions

None — all decisions above are resolved.
