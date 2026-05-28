## 1. Data Model

- [x] 1.1 Add `isDesktopMode: boolean` to the `Tab` type in `shared/types/browser.ts`
- [x] 1.2 Update `TabStore.createTab()` in `stores/TabStore.tsx` to set `isDesktopMode: false` on every new tab

## 2. Store Action

- [x] 2.1 Add `toggleDesktopMode(tabId: number)` action to `TabStore` that flips `isDesktopMode` on the matching tab and calls `saveTabs()`

## 3. WebView User Agent

- [x] 3.1 Define four UA constants at the top of `app/index.tsx` (MOBILE_UA_IOS, MOBILE_UA_ANDROID, DESKTOP_UA_IOS, DESKTOP_UA_ANDROID)
- [x] 3.2 Replace the static `userAgent` prop on `<WebView>` with a dynamic ternary based on `activeTab?.isDesktopMode ?? false`

## 4. MenuPopover UI

- [x] 4.1 Add `isDesktopMode: boolean` and `onToggleDesktopMode: () => void` props to `MenuPopoverProps` in `MenuPopover.tsx`
- [x] 4.2 Convert the `Browser` row into a split row (same structure as `Tabs | [+]`): left side taps to `onBookmarks`, right side is a desktop icon button that taps to `onToggleDesktopMode`
- [x] 4.3 Render `desktop-outline` icon when `isDesktopMode` is false, `desktop` (filled) icon when true

## 5. Wiring in app/index.tsx

- [x] 5.1 Pass `isDesktopMode={activeTab?.isDesktopMode ?? false}` to `<MenuPopover>`
- [x] 5.2 Pass `onToggleDesktopMode` handler to `<MenuPopover>` that calls `tabStore.toggleDesktopMode(activeTab.id)` then `setMenuPopoverOpen(false)`
