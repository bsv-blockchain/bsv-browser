# Profiling the app

This app ships a small, always-available profiling toolchain (dev-only — all of
it compiles to near-noops in production). Use it to find what blocks the JS
thread and to prove a fix actually helped.

## 1. `perf` — span timing (`utils/perf.ts`)

Time any sync or async work:

```ts
import { perf } from '@/utils/perf'

perf.track('tab.switch', () => tabStore.setActiveTab(id))
await perf.track('wallet.createAction', () => wallet.createAction(args))

const end = perf.mark('something.manual')
// ...later, possibly in another callback...
end()
```

- Spans over 16ms (one 60fps frame) auto-log a `[perf] SLOW …` warning.
- `perf.dump()` prints a label-grouped summary (count / avg / max / total).
- `perf.reset()` clears the ring buffer — call it right before an interaction to
  isolate just that interaction's spans.
- `perf.entries()` returns the raw ring buffer if you want to build an overlay.

Already instrumented: `webview.message.parse` and per-type
`webview.message:<TYPE>` counters in the WebView bridge.

## 2. Render instrumentation

- `useRenderCount(name)` (`hooks/useRenderCount.ts`) — drop at the top of a
  component body; logs `[render] <name> #<n>` and records a `render:<name>` span.
  Wired into `Browser` and `TabsView`.
- `<PerfProfiler id="…">` (`components/PerfProfiler.tsx`) — wraps a subtree in
  React's `<Profiler>` and records each commit's `actualDuration` as a
  `commit:<id>:<phase>` span. Wired around the `Browser` screen.

A re-render storm shows up as a fast-climbing `[render]` counter and repeated
`commit:` spans for a single interaction.

## 3. why-did-you-render

Bootstrapped in `wdyr.ts`, imported first in `app/_layout.tsx`. Logs why a
component re-rendered.

Caveat: MobX `observer` components re-render via reactions, not prop changes, so
wdyr says little about them — use `useRenderCount` / `<Profiler>` for those. wdyr
is most useful for plain prop-driven children. To track one component:

```ts
MyComponent.whyDidYouRender = true
```

If the package is ever missing/incompatible, `wdyr.ts` no-ops and logs a hint
instead of breaking the build.

## 4. Logging control (`utils/logging.ts`)

Raw, ungated `console.log` flooding the bridge is a primary jank source. Controls:

```ts
import { setLoggingEnabled, setForwardWebViewLogs, devLog } from '@/utils/logging'

setLoggingEnabled(false)        // silence all app logging (do this before profiling)
setForwardWebViewLogs(false)    // stop re-logging web pages' console.* (default off)
devLog('gated message')         // drop-in for console.log that respects the switch
```

Defaults: app logging on in dev / off in prod; WebView log forwarding off.

## 5. Hermes sampling profiler (JS CPU flamegraph)

Hermes is the JS engine (Expo 53 default). Its sampling profiler produces a
`.cpuprofile` you can open in Chrome DevTools for a full JS-thread flamegraph —
the best tool for finding a multi-second synchronous blocker.

1. Run a dev/release build on a physical device (`npm run ios` / `npm run android`).
2. Open the dev menu (shake the device, or `Cmd+D` iOS sim / `Cmd+M` Android).
3. Tap **Start Sampling Profiler**, reproduce the slow interaction, then tap
   **Stop Sampling Profiler**. The profile is saved on-device and its path is
   logged.
4. Pull and convert it (Android):
   ```bash
   npx react-native profile-hermes ./profiles
   ```
   On iOS, retrieve the `.cpuprofile` from the app container / logged path.
5. Open the `.cpuprofile` in Chrome DevTools → **Performance** → load profile.
   Look for wide frames = long synchronous JS-thread work.

## Suggested workflow

1. `perf.reset()` then `setLoggingEnabled(false)`.
2. Reproduce the slow interaction.
3. `perf.dump()` and read the `[render]` counts.
4. For anything still slow, capture a Hermes sampling profile for the exact
   call stack.
5. Apply one fix, repeat, compare. Stop when interactions feel instant.
