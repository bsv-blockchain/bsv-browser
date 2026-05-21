# GROK_REVIEW.md — BSV Browser Functional Performance Architecture Review

**Date**: 2026-05-21  
**Reviewer**: Grok (orchestrated arena of 6 specialized mobile performance subagents)  
**Focus**: iOS + Expo + React Native 0.83 + react-native-webview (13.16) + Reanimated 4 + New Architecture  
**Goal**: "Super fast clean Web3 Browser Experience" delivering identity + micropayments (BRC, 402, CWI provider) with buttery 60 fps chrome, instant tab switching, and sub-100 ms perceived auth flows — even while live WebView pages (video, canvas, dApps) are active.

**Methodology**: Parallel read-only deep audits by domain experts (WebView/chrome, tabs, state/re-renders, wallet/crypto, native/build, lists). Cross-referenced findings, unified into prioritized roadmap. All claims backed by exact file:line from source.

---

## Executive Verdict

**The app is already unusually sophisticated for a React Native Web3 browser.**

Significant, battle-tested iOS-specific engineering exists:
- Precise safe-area coordination (`buildBrowserSafeAreaScript`, memoized `contentInset`, `lastInjectedInsets` dedup at `app/index.tsx:562-580`).
- Reanimated + RNGH UI-thread address bar collapse with explicit `@callstack/liquid-glass` / `UIVisualEffectView` bug mitigations (`glassRevision` key remounts, translate-only kebab).
- Single live `WKWebView` + logical tabs (excellent memory O(1) cost).
- Auto-approve spending threshold + in-flight 402 coalescing (real "instant" path for small mics).
- Early `react-native-quick-crypto` + Hermes polyfill for native hashes/AES.
- New Architecture fully enabled, web-browser entitlement, careful `walletReady` gating.

**However, the current architecture will not deliver "super fast clean" under real usage** (multiple tabs + live micropayments/identity proofs + history/sheets open while a dApp page is scrolling or running JS).

**Primary remaining bottlenecks** (in rough order of user-perceived impact):
1. **Bridge chatter + JS-thread crypto** — Console polyfill + CWI provider + theme observer + every `createAction`/`getPublicKey`/`signAction` (even auto-approved) executes heavy ECDSA/KeyDeriver work on the main JS thread inside `handleMessage`.
2. **Tab switching cost** — Changing `ref={activeTab.webviewRef}` + `source.uri` on the `<WebView>` (plus complex hybrid history) causes full native unmount/reload instead of instant resume.
3. **Re-render amplification** — Giant `WalletContext` god-object + 5+ providers emitting unstable plain objects every render + broad MobX reads (`bookmarkStore.bookmarks.some(...)` in root `Browser` render) + monolithic 1,800-line observer component.
4. **List + overlay jank over live WebView** — History/bookmark sheets, suggestions dropdown, and `BrowserPage` use untuned `FlatList` (no `getItemLayout`, no FlashList), unstable renderItem factories, raw `<Image>` favicons, and nested virtualization while the WKWebView underneath is active.
5. **Chrome effects tax** — Liquid glass + Reanimated 4 worklets + frequent `injectJavaScript` for safe-area + permission events compete with WebView on lower-end devices (iPhone SE).
6. **No memory discipline** — Unlimited tabs, no `memoryWarning` listener, thumbnail captures on every `onLoadEnd`.

These are classic "Web3-in-WebView on mobile" problems, amplified by the hybrid MobX + React Context design and the decision to keep the entire browser chrome + message router + wallet calls in one observer component.

**Fixing the top 4-5 items below will move the app from "works well" to "feels like a native Web3 browser"** — the stated goal.

---

## Strengths (Preserve & Build On)

- **WebView hygiene** (`app/index.tsx:1447-1672`): `automaticallyAdjustContentInsets={false}`, explicit `contentInset` + `scrollIndicatorInsets` memoized to prevent multi-second WK relayouts, `paymentInFlightUrl` guards, `InteractionManager` usage, `injectedJavaScriptBeforeContentLoaded` ordering.
- **TabStore hybrid history** (`stores/TabStore.tsx:419-526`): Sophisticated `pendingHistoryJumps` countdown + custom stack to compensate for single-WV limitations.
- **Permission & 402 flow** (`utils/webview/bsvPaymentHandler.ts`, `WalletContext` spending callbacks, `PermissionSheet`): Auto-approve + queue + ephemeral grants + caching is production-grade.
- **Animation correctness under iOS quirks**: `useAddressBarAnimation.ts` + `glassRevision` + `runOnJS` thresholds are high-quality defensive engineering.
- **Wallet init guards**: `walletBuildingRef`, `walletReady`, about:blank during bootstrap.
- **Metro crypto routing** (`metro.config.js`): Correctly shims to `react-native-quick-crypto` for SDK hash/AES paths.

These show the team already understands the hard parts of WKWebView + floating glass chrome + live Web3 providers.

---

## Domain Findings (Arena Synthesis)

### 1. WebView + JS Bridge + Injections (Primary Hot Path for Web3)

- Single mounted `<WebView ref={activeTab?.webviewRef}>` (`app/index.tsx:1448`) with heavy `injectedJavaScriptBeforeContentLoaded` (CWI provider + spoof + media + permission + download scripts) + post-load polyfills.
- **CWI roundtrips** (`utils/webview/cwiProvider.ts` + `handleMessage` at index:1247): Every `window.CWI.createAction(...)` etc. = postMessage → await wallet call (crypto + storage) → `injectJavaScript` response + `dispatchEvent`. No batching.
- **Console polyfill tax** (`utils/webview/injectedPolyfills.ts:20-43`): Unconditional patch of all 5 console methods + every call posts to RN. Any library or dApp that logs (even once per render) floods the bridge.
- Theme-color `MutationObserver` + post on every change.
- Safe-area and permission sync injections on loadEnd + effects (already deduped well, but still eval cost).
- `onShouldStartLoadWithRequest` blob intercept + FileReader path.

**Impact**: Directly competes with Reanimated chrome animations and page scrolling. On a busy 402 + identity dApp page while user collapses address bar, visible jank is likely.

### 2. Tab Model & Switching

- Logical tabs only; native WKWebView destroyed on `setActiveTab` because `ref` object identity + `source` both change (`TabStore:116`, index render:1448, `renderMainContent`).
- Result: excellent RAM (1 WV always), terrible perceived switch latency (full network + parse + all injections + title + manifest + thumbnail).
- Thumbnail capture (`captureActiveThumbnail` + view-shot at 800 ms post-loadEnd + explicit on "tabs" tap) runs on main thread.
- No tab limit, no LRU eviction, no suspension.
- Per-tab history maps are in-memory only (lost on restart).

**Impact**: Users who keep 5-8 tabs (common for Web3 research) experience "open link in new tab then wait" instead of instant switch.

### 3. State Management & Re-render Storms

Provider tree depth 9+ (`app/_layout.tsx:100-142`):
- Multiple providers emit **plain object literals every render** (SheetContext:73, WalletConnectionContext:435, ThemeContext:147, Language).
- `WalletContextValue` is a ~35-field god object rebuilt on any queue change, `txStatusVersion++`, or SSE tick (`WalletContext:1328-1405`). Every `useWallet()` subscriber (Balance, modals, BrowserModeProvider itself, permission sheets, index handlers) re-renders.
- `BrowserModeProvider` reads `useWallet()` internally.
- Root `observer(Browser)` in `app/index.tsx` reads `bookmarkStore.bookmarks.some(...)` directly in render (1917) → any bookmark mutation re-renders the entire WebView + chrome tree.
- `handleNavStateChange` and `renderMainContent` defined inside render body (fresh functions).
- Minimal `React.memo` on chrome subtrees; prop drilling of whole `activeTab` objects and sheets.
- React 19 present but zero adoption of `use`, `useDeferredValue`, etc.

**MobX vs Context hybrid assessment**: MobX fine-grained reactivity helps *inside* TabStore/BookmarkStore observers. Context + god-object + unstable values + root observer wins the war and causes cascade re-renders exactly when micropayments or live balance updates occur while browsing.

### 4. Wallet / Crypto / Micropayment Latency

- `createAction`, `getPublicKey` (BRC-42 style), `createSignature` etc. execute inside the `handleMessage` await path on JS thread (even for auto-approved spends below threshold).
- `KeyDeriver` + ECDSA + storage lookups + BEEF construction happen synchronously before response injection.
- `react-native-quick-crypto` only covers hashes/AES today (excellent start via metro shim); secp signing still pure-JS in `@bsv/sdk` + toolbox.
- Permission sheet mount + Reanimated spring + `deriveActive` + AmountDisplay etc. adds 200-600 ms perceived for non-auto flows.
- No pre-warming of common protocol keys or counterparty derivations at wallet build time.

**Auto-approve + caching** (`WalletContext:452`, `bsvPaymentHandler`) is the hero feature that makes small mics feel fast today. Everything else fights the "super fast" goal.

### 5. Lists, Suggestions, Overlays While Browsing

- `HistoryList`, `BookmarkList`, `BrowserPage` horizontal bookmarks, `SuggestionsDropdown` (map, not virtualized), `HistoryPopover` (ScrollView + map) all suffer:
  - No `getItemLayout`, weak `windowSize`/`maxToRenderPerBatch`.
  - Unstable `renderItem` / `keyExtractor` (index fallbacks, length in deps).
  - Raw RN `<Image>` for favicons (constructed in render bodies) vs `expo-image`.
  - `TabsOverview` is the only well-tuned one (FlashList-level props but still plain FlatList).
- Opening any of these over a live WebView (the primary UX) causes layout, image decode, and gesture handler allocation contention on the main thread.

### 6. Native / Launch / Effects / Memory

- No `memoryWarning` listener, no tab cap → OOM risk on iPhone SE with 8+ tabs + heavy pages.
- Large splash asset, no explicit `SplashScreen.hideAsync` after critical path.
- Heavy wallet build (new Wallet + multiple managers + BTMS + Monitor + SQLite migration) on cold start, gated behind providers.
- Liquid glass + Reanimated 4 + bridge traffic = high main-thread + compositing cost.
- No pre-warmed hidden WKWebView.
- New Arch + Hermes + nitro are modern and correct.

---

## Prioritized Recommendation Roadmap

### P0 — Immediate, High-Impact, Low-Risk (Do These First)

| # | Recommendation | Files | Rationale & Expected Win | Effort |
|---|----------------|-------|---------------------------|--------|
| 1 | **Silence/rate-limit console + theme-color bridges** in production. Make console patch dev-only or sampled (1/10). | `utils/webview/injectedPolyfills.ts:20-43` | Eliminates the single largest source of constant bridge spam from real pages + libs. Immediate 60 fps consistency gain on any dApp. | Low |
| 2 | **Stabilize all provider values with `useMemo`** (Sheet, WalletConnection, Theme, Language, etc.). | `context/SheetContext.tsx:73`, `WalletConnectionContext.tsx:435`, `theme/ThemeContext.tsx:147`, etc. | Stops gratuitous subtree re-renders on every provider render. Foundational. | Low |
| 3 | **Stop broad MobX reads in root render**. Replace `bookmarkStore.bookmarks.some(...)` (index:1917) with a tiny dedicated `observer` subcomponent or `@computed`. | `app/index.tsx:1917` (MenuPopover isBookmarked) | Prevents *every* bookmark mutation from re-rendering the entire WebView + chrome. | Low |
| 4 | **Add hard `MAX_TABS = 6-8` + LRU eviction** in `newTab`/`closeTab`. Auto-close oldest inactive on overflow + toast. | `stores/TabStore.tsx:69` | Prevents unbounded metadata + thumbnail memory. Critical for low-end iOS stability. | Low |
| 5 | **Add `AppState` + `memoryWarning` listener** that purges background tabs, clears WV caches, thumbnails. | `context/WalletContext.tsx` or new hook + TabStore | Defensive iOS hygiene. Reacts before OOM kills the app. | Low |
| 6 | **Move thumbnail capture behind `InteractionManager.runAfterInteractions`** and make conditional (only on explicit tabs open or background, not every loadEnd). Lower res/quality. | `app/index.tsx:1646`, `utils/thumbnailService.ts`, `TabsOverview.tsx:1933` | Removes main-thread rasterization spikes during normal browsing. | Low |

### P1 — Structural Changes for "Super Fast" Feel (Next Sprint)

| # | Recommendation | Files | Rationale & Expected Win | Effort |
|---|----------------|-------|---------------------------|--------|
| 7 | **Decouple WebView ref ownership from Tab objects**. Keep a single stable `webviewRef` owned by the Browser component. On tab switch: imperatively `injectJavaScript('location.href=...')` or `stopLoading + load` into the *same* native instance + update logical Tab state/history. Never change the `ref` prop or `source` in a way that remounts. | `app/index.tsx:1448` (render), `stores/TabStore.tsx:54-67` (createTab refs), `setActiveTab`/`handleNav...` | Transforms tab switching from "full reload" to "fast navigation". Achieves real-browser instant resume while keeping memory low. This is the single biggest UX lever for the "clean fast" goal. | Medium-High (careful history invariants) |
| 8 | **Split WalletContext** (or introduce selector hooks): core managers vs. permission queues vs. `txStatusVersion` broadcast. Or at minimum a `useWalletManagers()` lightweight hook. | `context/WalletContext.tsx:84-1405` (the giant memo + 35 deps) | Shrinks blast radius of every SSE tick or queue enqueue. Directly reduces re-renders during live micropayments. | Medium |
| 9 | **Migrate HistoryList + BookmarkList to FlashList** (`@shopify/flash-list`) + implement `getItemLayout` (fixed row height) + `windowSize={3-5}` + `maxToRenderPerBatch={5}`. Stabilize renderItem factories (remove `length` from deps, memo rows). | `components/browser/HistoryList.tsx`, `BookmarkList.tsx` | Eliminates jank when opening history/bookmarks/suggestions over a live page — the most common "while browsing" action. | Medium |
| 10 | **Offload or defer CWI/crypto work**. Route hot `createAction`/`signAction` paths through `InteractionManager.runAfterInteractions` or a serial queue. Extend quick-crypto usage (or add small Nitro module) for secp256k1 sign/derive where possible. Pre-warm common protocol keys at wallet build time. | `app/index.tsx:1247` (handleMessage await), `WalletContext` build, `utils/webview/cwiProvider.ts`, `bsvPaymentHandler.ts` | Keeps JS thread free for chrome animations during micropay/identity ops. Moves "super fast" from "auto-approve only" to general case. | High (requires measurement first) |
| 11 | **Stabilize Browser chrome subtree**: `useCallback` all handlers passed to WebView (`handleNavStateChange` etc.), extract `<WebView>` + container into its own `React.memo` (primitive props only), memo AddressBar / SheetRouter / popovers with custom comparators. | `app/index.tsx:1276`, `1401` (renderMainContent), `1807` (AddressBar), `2001` (SheetRouter) | Prevents the monolithic observer from re-evaluating everything on every tiny state tick. | Medium |
| 12 | **Convert SuggestionsDropdown + HistoryPopover inner lists** to small tuned FlatList/FlashList + memo items. Debounce address text → Fuse. | `components/browser/SuggestionsDropdown.tsx`, `HistoryPopover.tsx` | Removes map + layout work during address bar focus (very hot path). | Low-Medium |

### P2 — Polish & Long-Term

- **Native Expo Module for safe-area / force relayout** (revive or create `modules/browser-safe-area`) instead of JS injection + `injectJavaScript` on every bar animation. Avoids bridge + DOM event spam.
- **Pre-warm hidden WKWebView** at app start for ~0 ms first contentful paint on cold tab.
- **Migrate remaining `<Image>` to `expo-image`** (favicons, avatars) with `cachePolicy="memory-disk"`.
- **Adopt React 19 primitives**: `use` for leaf context reads, `useDeferredValue` for suggestions/history lists.
- **Hermes v1 + ccache** in prod EAS profiles (after measuring build time).
- **Device-tier degradation** via `expo-device`: disable liquid glass / reduce spring stiffness / cap tabs harder on SE / older devices.
- **Persist per-tab `tabNavigationHistories`** so back/forward survives restart.
- **Measure everything**: Add lightweight `performance.mark` / console.time around CWI entry→response, tab switch, sheet open, address collapse. Profile in Xcode Instruments (Time Profiler + WebKit + Metal) on real hardware during concurrent micropay + gesture.

---

## Suggested Phased Plan (Unanimous Arena Consensus)

**Phase 0 (1-2 days, unblock)**: P0 items 1-6. Immediate wins, zero architectural risk. Run before/after React Profiler + Instruments on "open history while heavy page + random bookmark add".

**Phase 1 (core "fast" experience, 1-2 sprints)**: P1 items 7 (stable WebView content swap), 8 (Wallet split), 9 (FlashList), 11 (chrome memo). These attack the three biggest user-visible stalls: tab switch, re-renders during payments, overlays over pages.

**Phase 2 (perception polish)**: Crypto offload (10), native module, pre-warm WV, React 19, measurement harness.

**Validation gate before each phase**: Define 3-4 objective scenarios:
1. 8 tabs, switch between 3 while one has a 402 micropay dApp running → no jank, <250 ms perceived switch.
2. Address bar focus + type while page scrolls → instant suggestions, no dropped frames.
3. Auto + manual small 402 spend while chrome animating → sub-100 ms feel for auto, <300 ms sheet for manual.
4. Cold start to first paint + first CWI call → competitive with Safari + Web3 extension feel.

Use React DevTools Profiler + Flipper + Xcode Instruments + a simple timing overlay in dev.

---

## Closing

The BSV Browser team has already done the hard, unglamorous iOS WebView + floating glass + safe-area + Web3 provider integration work that most teams get wrong. The remaining gaps are classic and solvable: reduce bridge traffic, stabilize the single WebView instance, contain re-render scope (especially Wallet + root observer), virtualize lists properly, and keep the JS thread free for crypto during user gestures.

Executing the P0 + P1 roadmap above will deliver on the "super fast clean Web3 Browser Experience" promise.

All specific locations, rationales, and cross-agent consensus are documented above with file:line precision.

**Next step for implementers**: Pick P0 #1-3 + P1 #7 as the first concrete slice. They are mutually reinforcing and directly attack the "while a Web3 page is live, everything else must feel instant" requirement.

---

*Report generated via agent-orchestrated arena (6 parallel domain experts) + unification. All analysis read-only; no files were modified during investigation.*