# HIG Polish — T14: Load Progress Bar
## Session date: 2026-06-11
## Branch: feat/hig-polish
## Commit: 4336906

## What was done

Implemented the 2px page-load progress line that appears under the address bar during page loads.

### Files created/modified
1. `components/browser/LoadProgressBar.tsx` — new component
2. `app/index.tsx` — wired loadProgress SharedValue, onLoadProgress, completion, cancel and tab-switch resets, rendered component

### Implementation notes

**Reanimated version** — 4.2.1. The percentage-string width approach (`width: \`${n}%\`` cast to `any`) works fine in Reanimated 4 inside useAnimatedStyle; the cast suppresses the TypeScript string-as-StyleProp complaint.

**colors.info** — exists verbatim in ThemeContext at line 48.

**Placement** — LoadProgressBar is mounted as a sibling of ChromeAddressBar inside the `chromeWrapper` Animated.View (key `chrome-wrapper-${glassRevision}`). The chromeWrapper has `position: 'absolute'`, `left: 0`, `right: 0`, `zIndex: 20`, no explicit `overflow`. The bar uses `position: 'absolute'`, `bottom: 0`, `left: 0`, `height: 2` — it sits at the bottom edge of the address bar container. No overflow:hidden concern — the bar is 2px tall within the wrapper bounds.

**SharedValue flow** — `loadProgress` is a single `useSharedValue(0)` in the Browser component and passed to every WebViewHost as a new prop `loadProgress: SharedValue<number>` (added to `WebViewHostProps` interface and destructured in WebViewHost).

**Progress updates** — `onLoadProgress` in WebView fires `nativeEvent.progress * 0.9`, capped at 0.9 so it never reaches 1 mid-load. Monotonically non-decreasing (checked with `if (next > loadProgress.value)`). Animated with `withTiming(next, { duration: durations.quick })`.

**Completion** — in `onLoadEnd`, when `isActive`:
- `loadProgress.value = withTiming(1, { duration: durations.instant })` — snap to full
- `loadProgress.value = withDelay(300, withTiming(0, { duration: 0 }))` — instant hide after 300ms

**Cancel/stop** — in `cancelActiveLoad`, added `loadProgress.value = 0` immediately after `tabStore.clearSwitchLoading()`. Updated useCallback deps to include `loadProgress`.

**Tab switch** — added a `useEffect(() => { loadProgress.value = 0 }, [activeTab?.id])` near the other activeTab?.id effects. Uses eslint-disable comment because `loadProgress` is a stable SharedValue (not a reactive dep) — same pattern used elsewhere in the file.

**Imports added to app/index.tsx**:
- `withDelay`, `SharedValue` added to the existing Reanimated import
- `durations` from `@/context/theme/motion`
- `LoadProgressBar` from `@/components/browser/LoadProgressBar`

### Verification results
- tsc --noEmit error count: 12 (matches pre-existing baseline exactly)
- eslint on LoadProgressBar.tsx: 0 warnings, 0 errors
- eslint on app/index.tsx: 13 warnings (all pre-existing, 0 new from this change)

### Architecture notes for next engineer
- The progress bar is intentionally outside ChromeAddressBar (the observer component) — it uses a SharedValue directly, so it runs entirely on the UI thread with zero JS re-renders
- The `loadProgress` SharedValue is owned by the Browser component, not by WebViewHost, so it survives warm-pool tab switches correctly
- All resets (cancel, tab switch) write `0` directly (no animation) for instant visual clearing
- The `withDelay(300, withTiming(0, { duration: 0 }))` pattern from Reanimated 4 works by chaining: the delay fires on the UI thread 300ms after the previous withTiming(1) completes
