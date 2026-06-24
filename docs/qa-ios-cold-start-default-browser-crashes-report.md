# QA Investigation Report: iOS App Crashes on Cold Start as Default Browser (Real Devices, Not Simulator)

**Date**: 2026-06-24  
**App**: BSV Browser (React Native + Expo, WebView-based browser + self-custodial BSV Web3 wallet)  
**Symptoms**: Crashes fairly regularly on real iPhones (especially cold starts when launched via http/https URL as the default browser). Sometimes triggered simply by closing all tabs. Works reliably in Simulator. Users expect the target web page to load; instead they get instability or termination.

**Root Cause Summary**  
The dominant issue is **architectural coupling of "load the cold-started web URL" to "complete full Web3 wallet instantiation"**, combined with heavy synchronous/async work on the JS thread + native resources during launch. This works in the Simulator (fast CPU, abundant RAM, generous launch timeouts, often fresh/small DBs) but frequently kills or destabilizes the app on real iOS hardware under real-world conditions (memory pressure, slower storage, tighter launch watchdogs, existing wallet data).

The code explicitly **blocks WebView mounting for the requested URL** behind wallet bootstrap when in Web3 mode. Wallet bootstrap is expensive and runs on nearly every cold start.

---

## 1. Cold-Start + Default Browser Flow (Critical Path)

- `app/+native-intent.ts:redirectSystemPath` (initial=true): For http/https URLs, calls `setPendingInitialBrowserUrl` and forces route to `/` (avoids +not-found flash).
- `utils/externalUrlRouter.ts`: Simple dedupe window (2.5s) + pending URL storage.
- `hooks/useDeepLinking.ts:useDeepLinking` (mounted early in `_layout.tsx`):
  - Consumes pending URL.
  - Polls (up to 5s, 100ms) for `tabStore.isInitialized`.
  - Calls `tabStore.raiseLoadingForUrl(url)` then `newTab(url)` (or `updateTab` if active tab is about:blank).
  - Catches errors and falls back to `/`.
- `app/index.tsx` (Browser screen):
  - `useEffect` calls `tabStore.initializeTabs()` (loads from AsyncStorage + may `newTab`).
  - `renderMainContent()` applies the wallet gate (see below).
- `stores/TabStore.tsx`:
  - `initializeTabs` → `loadTabs` (multiGet + JSON.parse of tabs + full `tabNavigationHistories` + indexes) → possibly `newTab`.
  - `newTab(url)` for external URL: creates tab, **pre-populates history as `[kNEW_TAB_URL, url]`**, sets `activeTabId`, schedules `saveTabs` (debounced AsyncStorage multiSet with JSON.stringify of everything).
  - History logic is hybrid (custom + WebView native) with `pendingHistoryJumps`, `lastNavSig`, sentinel handling for `about:blank`/`kNEW_TAB_URL`.

Simultaneous with the above:
- `context/WalletContext.tsx:WalletContextProvider` mounts (ancestor in `_layout.tsx`).
- Auto-build `useEffect` (on `configStatus === 'configured' && !walletBuilt`) sets `walletBuilding=true` and kicks off `buildWalletFromMnemonic` (or recovered key fallback).

Result on Web3 cold-start link launch: tab/history state is created + persisted, `switchLoading` may be raised, **but the actual page does not render**.

---

## 2. Wallet Bootstrap Blocks the Requested URL (Primary Suspect)

```tsx
// app/index.tsx:2069
const walletReady = isWeb2Mode || !walletBuilding
...
if (!walletReady && !isNewTab) {
  return <View style={loaderContainer}><ActivityIndicator /></View>  // full-screen spinner
}
```

(See: `renderMainContent:2112`, warmWebTabs filter:2130 (also gated), WebViewHost never mounts for the deep-linked http tab.)

- `injectedJSBefore` still computes `buildCWIProviderScript()` (large string) unless Web2, but the host isn't rendered.
- Once wallet finishes: `walletBecameReady` effect does `webviewRef.current?.reload()` (harmless if ref not yet attached). The WebView then mounts with `source={{uri: tab.sourceUrl ?? tab.url}}`.

**Why this crashes on device**:
- `buildWallet` / `buildWalletFromMnemonic` (WalletContext ~573–1010) does **a lot** on the JS thread + native:
  - `getExchangeRate()` fetch.
  - `KeyDeriver`, `WalletStorageManager`, `WalletSigner`, `Services`, multiple broadcast providers, chaintracks, etc.
  - `StorageExpoSQLite` + `migrate()`: `openDatabaseAsync` + `createTables` (many CREATE TABLE / INDEX / PRAGMA / conditional ALTERs) + possible legacy DB probe/registration.
  - `Wallet`, `createBtmsModule`, `WalletPermissionsManager`.
  - `Monitor` + `startTasks()` (ARC SSE via `RNEventSource`, many patched tasks, background work).
- This runs **concurrently** with `tabStore.loadTabs`/`persistTabs` (more JSON + AsyncStorage), Browser effects, provider setup, re-renders (MobX + contexts), and RN bridge traffic.
- `BrowserModeContext` also reacts to `walletBuilding`/`managers` and can flip `isWeb2Mode`.
- For users **with** a wallet (most crash reporters), `walletBuilding` is true on cold start. For fresh/Web2 users it resolves quickly.

GROK_REVIEW.md already flagged: "Heavy wallet build (new Wallet + multiple managers + BTMS + Monitor + SQLite migration) on cold start, gated behind providers."

Simulator hides this (fast everything). Real iPhone + default-browser launch (different activation path from Springboard) + existing data + possible backgrounded apps = pressure. iOS can terminate the process for long launch times, excessive main/JS thread work, or memory.

---

## 3. History/Tab Caches and Related Fragility

- `TabStore` eagerly persists **full** navigation histories + indexes on nearly every mutation (`saveTabs` debounced 400ms; `flushTabs` on background).
- `loadTabs` rehydrates them and recomputes `canGoBack`/`canGoForward` from history (sentinel logic for kNEW_TAB_URL at index 0).
- Deep-link `newTab` pre-creates history entries; `handleNavigationStateChange` has complex jump-dup detection.
- `closeTab` / `clearAllTabs` (called from TabsOverview "Close all tabs"): stops/clears WebViews, deletes thumbnails, splices, may synchronously call `newTab()` inside the loop when length hits 0, updates active, etc.
- `goBack`/`goForward`/`navigateToHistoryIndex` perform `injectJavaScript` using stored history URLs.

**Risks on cold start + close-all**:
- Races between deep-link waiter (`isInitialized` polling), `initializeTabs`, `newTab(url)` from link, homepage-navigation effects (skipped for http tabs but still present), and wallet flip.
- After "close all", a fresh tab + possible homepage logic runs while a pending deep-link URL was expected.
- Restored tabs + incoming deep link can create extra tabs (if active URL doesn't match).
- Large history blobs or many tabs increase JSON + memory cost on every launch/restore.
- `clearAllTabs` + `saveTabs` calls can overlap.

No obvious unhandled throw in the hot paths (lots of try/catch + `.catch` on saves), but state can become surprising (wrong `canGoBack`, lingering `switchLoading`, activeTab pointing at unexpected content).

---

## 4. Unsafe JavaScript Injection (Secondary but Real Crash Vector)

TabStore (lines ~388, 390, 462, 524, 526):

```ts
tab.webviewRef.current.injectJavaScript(`window.location.href = "${url}";`)
```

**No escaping**. 

- Cold-start URLs (or subsequent redirects stored in history) containing `"`, backticks, newlines, or certain unicode produce invalid JS when injected.
- `injectJavaScript` of a syntax error in the WebView context commonly triggers `onContentProcessDidTerminate` (iOS) or renderer crash/exit (Android).
- Recovery exists (`recoverTerminatedProcess` in WebViewHost:219) — it sets loading false, clears switch, and does a delayed `reload` for the active tab. But repeated or early failures during launch can look like a crash or leave the app in a broken state.
- Safer pattern used elsewhere (`JSON.stringify` in index.tsx:1365).

This would be more visible with arbitrary links (exactly the default-browser use case) and on real devices (different WebKit process management).

---

## 5. Other Contributing / Amplifying Factors

- **WebView / memory pressure awareness exists** (`utils/deviceTier.ts`, `WARM_POOL_SIZE`, `MAX_TABS`, `useSharedProcessPool={false on iOS}`, `useMemoryHygiene`, thumbnail capture + cache purging on memory warning/background, `purgeInactiveTabResources`). Comments explicitly mention SE-class devices + "multi-GB footprints and process termination." Cold-start still creates at least one web-page WebView (once wallet gate passes) + warm pool.
- Early `ready` gate + `!tabStore.isInitialized` full-screen spinner in Browser (2059).
- `injectedJSBefore` + CWI + polyfills + permission script are large and computed in memos.
- Network calls during build (exchange rate + later monitor/SSE).
- `ErrorBoundary` at root catches render errors and shows a fallback UI, but native terminations / JS context death / launch watchdog kills are invisible to it.
- No special fast-path or deferred loading for external URL launches.

---

## 6. Why "Works in Simulator, Crashes on Real Phone"?

- Simulator: higher effective RAM/CPU, fast local FS, no other apps, lenient timeouts, often starts with smaller/empty wallet DBs.
- Real device cold start via URL intent: different launch metrics, possible memory pressure, slower flash for SQLite open/migrate + large history JSON, real network for exchange rate, WebKit is stricter about processes on actual hardware.
- "Closing all tabs" reproduces similar churn (mass close + newTab + save + possible re-init effects) without the external URL but under the same heavy init regime.

---

## Evidence Locations (Key Files/Lines)

- Wallet blocking gate + render: `app/index.tsx:2069` (`walletReady`), `2112` (spinner), `2130` (warm tabs), `1953` (reload on ready), `683` (initializeTabs), `1729` (CWI injection).
- Deep link / cold URL: `app/+native-intent.ts:14`, `utils/externalUrlRouter.ts:32`, `hooks/useDeepLinking.ts:25` (wait + newTab), `29` (raiseLoadingForUrl).
- Tab/history: `stores/TabStore.tsx:86` (initialize), `126` (newTab + history pre-pop), `756` (persistTabs), `766` (loadTabs), `340`/`420`/`490` (goBack/forward/index + unsafe inject), `695` (clearAllTabs).
- Wallet build: `context/WalletContext.tsx:1107` (auto-build effect), `924` (buildFromMnemonic), `573` (buildWallet — exchange rate, storage, Monitor, etc.), `710` (migrate).
- Unsafe injects: TabStore (see above); contrast `app/index.tsx:1365`.
- Device reality: `utils/deviceTier.ts:58` (process termination comments), `app/index.tsx:425` (onContentProcessDidTerminate).
- Known prior callout: `GROK_REVIEW.md:112`.

---

## Recommended Next Steps (for Engineering)

1. **Decouple URL load from wallet readiness for external/deep-link cases.** Always mount the target WebView for a cold-started http URL (or any explicit navigation). Load the page immediately (Web2-like). Queue or degrade CWI calls until wallet is ready; reload the WebView (or re-inject) once `wallet` is available. This directly addresses "we should be focused on loading the web URL".
2. **Make wallet bootstrap lazier / lighter on cold path.** Defer Monitor start, cache exchange rate, consider backgrounding non-essential service setup, or split build work.
3. **Fix unsafe URL interpolation everywhere.** Use `JSON.stringify(url)` (or a proper escaper) for all `injectJavaScript` location changes. Add a helper.
4. **Reduce launch contention.** Consider `InteractionManager.runAfterInteractions` for some tab-persist / thumbnail / history work. Ensure deep-link path doesn't force extra `saveTabs` immediately.
5. **Add launch + deep-link telemetry / timing marks** (already using some `perf` utils). Measure "external URL intent → first WebView paint" with wallet present.
6. **Harden history/restore + clear-all.** Snapshot tabIds safely; make clearAllTabs more atomic; add defensive checks.
7. **Crash hardening.** Consider a lightweight "URL loader only" mode or a dedicated error boundary + recovery around the first external load. Instrument native crashes / terminations if possible (e.g. via existing logging).
8. **Test matrix**: Real low/mid-tier iPhones (SE-class), cold starts via Messages/Safari links, with large existing wallet DBs, after "close all tabs", with/without network.

This investigation was performed by reading the cold-start URL paths, TabStore history logic, WalletContext bootstrap, Browser render gating, WebView injection sites, device tier logic, and related effects/hooks in parallel. The behavior matches the reported symptoms exactly.
