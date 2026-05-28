## Why

Some websites detect mobile user agents and serve a reduced mobile experience that hides features or forces a different layout. Users currently have no way to override this — the browser always sends a mobile UA string, so there is no escape hatch. Adding a per-tab "Desktop Mode" toggle lets users request the desktop version of any site on demand.

## What Changes

- Add `isDesktopMode: boolean` field to the `Tab` type in `shared/types/browser.ts`.
- Update `TabStore.createTab()` to default `isDesktopMode` to `false`.
- Derive the `userAgent` prop on `<WebView>` dynamically from the active tab's `isDesktopMode` flag (desktop Safari/Chrome UA when on, existing mobile UAs when off).
- Add a `toggleDesktopMode` action to `TabStore` that flips `isDesktopMode` on the specified tab.
- Add an `onToggleDesktopMode` callback prop to `MenuPopoverProps`.
- Add a split-button row for the Browser item: `Browser | [🖥 desktop icon]`, matching the existing Tabs | [+] split-row pattern. The desktop icon uses `desktop-outline` (off) / `desktop` filled (on) to indicate state.
- Dismiss the popover on toggle (page reloads naturally due to UA change).
- Pass `isDesktopMode` state and `onToggleDesktopMode` handler from `app/index.tsx` into `MenuPopover`.

## Capabilities

### New Capabilities

- `desktop-mode`: Per-tab desktop mode that switches the WebView user agent between mobile and desktop strings, allowing users to access the full desktop version of any website.

### Modified Capabilities

<!-- No existing specs change requirements -->

## Impact

- **`shared/types/browser.ts`**: `Tab` type gains `isDesktopMode: boolean`.
- **`stores/TabStore.tsx`**: `createTab()` sets `isDesktopMode: false`; new `toggleDesktopMode(tabId)` action added.
- **`app/index.tsx`**: `userAgent` prop derived dynamically; `onToggleDesktopMode` wired to `MenuPopover`.
- **`components/browser/MenuPopover.tsx`**: Browser row converted to a split row; new `isDesktopMode` and `onToggleDesktopMode` props added.
- No new dependencies required.
- No breaking changes to public APIs.
