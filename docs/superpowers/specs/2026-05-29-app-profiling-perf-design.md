# App Profiling Toolchain + Performance Fixes

**Date:** 2026-05-29
**Status:** Approved (approach confirmed via two clarifying rounds: full profiling toolchain + LRU warm-WebView pool)

## Problem

Every interaction in the app stalls the UI for seconds; new tabs are worst. The
JS thread (which handles all touch/gesture response in React Native) is being
blocked by constant background churn. Systematic investigation identified the
root causes below before any profiling was added — profiling exists to confirm
them and prove each fix.

## Root-cause evidence

1. **Log flood over the bridge.** ~114 raw `console.log` sites across
   `app/browser.tsx` (42), `context/WalletContext.tsx` (59),
   `stores/TabStore.tsx` (13). Raw `console.log` bypasses the
   `utils/logging.config` gate entirely (only `logWithTimestamp` is gated, and
   `app/browser` is set to `true` there anyway). Worse: the WebView `CONSOLE`
   message handler (`app/browser.tsx:1069`) re-logs **every** web page's
   `console.*` onto the RN JS thread. A chatty page = bridge flood = multi-second
   jank. This is the "background process" the user senses.

2. **`saveTabs()` on every navigation event.** `JSON.stringify(all tabs)` +
   `AsyncStorage.setItem` fires on each WebView navigation state change
   (multiple per page load) — `stores/TabStore.tsx:290`.

3. **Monolithic `observer(Browser)`.** A single 2000+ line observer component
   (`app/browser.tsx:2168`) fully re-renders on any observed change.
   `switchLoading` toggles twice per switch; `url`/`title`/`isLoading` mutate on
   every nav event → whole tree + all inline styles/handlers rebuilt each time.

4. **Single shared WebView, source swaps per switch.** One `<WebView>` whose
   `source.uri` changes on tab switch (`app/browser.tsx:1759`) → full page
   **reload** every switch, no warm tabs. Explains "new tabs especially bad" and
   why the loading-overlay band-aid (commit 813a789) was added.

Engine: Hermes (Expo 53 default, no `jsEngine` override). Entry:
`expo-router/entry`.

## Part A — Profiling toolchain (build first, keep permanently)

All dev-only / `__DEV__`-gated, zero cost in production builds.

1. **`utils/perf.ts`** — thin module over `performance.now()` (already used in
   `utils/logging.ts`). API: `perf.track(label, fn)` (sync + async),
   `perf.mark(name)`, `perf.measure(name, startMark)`. Keeps a ring buffer of
   the last N measures and warns when a tracked span exceeds a threshold.

2. **Render instrumentation** — `useRenderCount(name)` hook plus React's
   built-in `<Profiler>` wrapping `Browser` and `TabsView`, logging commit
   durations over ~16ms.

3. **why-did-you-render** — dev-only `wdyr.ts`, guarded (`__DEV__`) import at the
   top of `app/_layout.tsx`, configured to track the `observer` components and
   surface re-render storms.

4. **Hermes sampling profiler** — document the Dev-Menu start/stop →
   `.cpuprofile` → Chrome DevTools flamegraph workflow in
   `docs/profiling.md`. Add a dev-only toggle button if the API allows.

5. **Logging control** — central log-level / global flag. Route raw
   `console.log` in the hot files through the gate, and stop WebView
   page-console forwarding unless the flag is on. (Both a profiling-noise
   reducer and the first real fix.)

## Part B — Performance fixes (each measured before/after via Part A)

6. **Kill the log flood** — gate the raw logs in the three hot files + the
   WebView `CONSOLE` handler. Expected biggest single win.

7. **Debounce `saveTabs()`** — trailing 500ms–1s; skip transient `isLoading`
   mutations. Stops per-nav-event serialize + AsyncStorage churn.

8. **Warm WebView LRU pool (N=4).** TabStore tracks tab recency. Render the warm
   tabs' WebViews mounted (active visible; inactive hidden via absolute +
   `opacity:0` + `pointerEvents:none`). Cold tabs render a placeholder and
   remount their WebView on activation. Removes reload-on-switch for recent
   tabs; the loading overlay is kept only for cold-tab activation.

9. **Split the monolithic observer** — extract the WebView host into a memoized
   `observer` child that reads only the active tab, so per-nav-event mutations
   stop re-rendering the 2000-line tree.

## Sequencing

Part A (1–5) → capture baseline → 6 → 7 → 8 → 9, re-measuring after each.
Evidence-driven: stop when interaction latency is acceptable.

## Out of scope

- Native-side (Swift/Kotlin) profiling.
- Refactors unrelated to the interaction-latency hot path.

## Success criteria

- Tab switch and new-tab interactions feel instant (no multi-second JS-thread
  block); confirmed by `perf.track` spans and Profiler commit durations.
- Switching between warm tabs preserves page state (no reload).
- Profiling instrumentation is reusable and off in production.
