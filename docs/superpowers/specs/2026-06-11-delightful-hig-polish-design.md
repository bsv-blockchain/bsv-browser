# BSV Browser — "Good to Delightful" HIG Polish Pass

**Date:** 2026-06-11
**Status:** Approved
**Scope:** One comprehensive pass covering consistency, browser chrome, signature moments, and onboarding. iOS-first with graceful Android fallbacks.

## Goals

Take the app from functionally good to delightful per Apple's Human Interface Guidelines. The app already has a strong foundation (design tokens, LiquidGlass chrome, spring-animated Sheet system); this pass raises the floor (consistency) and the ceiling (signature moments) together.

## Decisions Made

| Decision | Choice |
|---|---|
| Focus | All four areas: consistency, signature moments, chrome, onboarding |
| Platform | iOS-first; Android gets functional fallbacks (blur → solid, haptic no-ops) |
| Motion personality | **Quiet Precision** (Apple Pay temperament): fast (≤350ms), small movements, settles instantly, one crisp haptic. Celebration reserved for exactly three moments. |
| Delivery | One comprehensive pass (single effort, not phased shipping) |
| Architecture | **Primitives-first, then sweep**: build missing design-system primitives once, then mechanically adopt across all screens |
| Alert replacement | **Glass Alert Card** (center-positioned, HIG-classic) for decisions; **Toast** for pure notices |
| Scroll-collapsing address bar | **Explicitly cut** — address bar stays fixed (owner decision, perf posture) |

## Part 1 — Motion & Haptic System (foundation)

### Motion tokens — new file `context/theme/motion.ts` (sibling to `tokens.ts`)

- `spring.snappy` — stiffness 380, damping 36, mass 1 (matches existing Sheet values; becomes the named standard)
- `spring.settle` — stiffness 280, damping 32, mass 1 — for larger surfaces (sheets, popovers)
- `duration.instant` = 150ms, `duration.quick` = 250ms, `duration.moderate` = 350ms. **Nothing slower exists.**
- All animations run UI-thread via Reanimated — zero JS-thread cost (respects the standing <100ms JS-block rule)
- `prefers-reduced-motion` honored globally via `useReducedMotion()`: springs collapse to fades, Celebration collapses to static check + haptic
- Documented guardrail: **never animate ancestor opacity fractionally over LiquidGlass** (established codebase constraint); stuck UIVisualEffectView is cured by remount-via-key

### Haptic vocabulary — new hook `hooks/useHaptics.ts`

Semantic vocabulary, not ad-hoc calls:

| Semantic | iOS mapping | Used for |
|---|---|---|
| `tap` | `selectionAsync` | segmented controls, pickers, tab select |
| `confirm` | `impactAsync(Light)` | button commits, toggle on |
| `success` | `notificationAsync(Success)` | payment sent, permission granted, backup done |
| `warning` | `notificationAsync(Warning)` | deny, destructive confirm step |
| `error` | `notificationAsync(Error)` | failed tx, invalid input |

Android: `tap`/`confirm` no-op; notification types map to vibration only where Material expects it. Target ~30 call sites (currently 2 ad-hoc sites).

## Part 2 — New Primitives

1. **`AlertCard`** (`components/ui/AlertCard.tsx`) — center-positioned glass alert card replacing all `Alert.alert` decision dialogs. Glass material matching app language, optional semantic icon (e.g. destructive warning tint), title/message, horizontal button row (HIG layout: cancel left, action right; destructive in red). Scales in with `spring.snappy` + dim backdrop; `warning` haptic on destructive present. **Promise-based API**: `await alert({title, message, buttons})` — drop-in replacement at call sites.
2. **`Toast`** (`components/ui/Toast.tsx`) — non-modal glass capsule at top, auto-dismiss 2s, slides in with `spring.snappy`. Queue of 1 (newest wins). For pure notices: "Copied", export results, transient errors. Optional semantic icon + `error`/`success` haptic.
3. **`PressableScale`** (`components/ui/PressableScale.tsx`) — standard press feedback replacing bare opacity-0.5 Pressables: scale 0.97 + opacity 0.85, spring-driven, optional `confirm` haptic prop.
4. **`Celebration`** (`components/ui/Celebration.tsx`) — drawn checkmark (SVG path draw) + success haptic, ~600ms. Used in exactly three places (see Part 5). No particles — Quiet Precision.

## Part 3 — Consistency Sweep

### Alert.alert triage (21 sites)

- **Decisions** (delete certifier, overwrite wallet, remove connection, etc.) → `AlertCard`
- **Notices** ("Copied", export results, error FYIs) → `Toast`
- **Default-browser prompt** (`components/onboarding/DefaultBrowserPrompt.tsx`) → `AlertCard` with app-icon treatment

### Modal unification

- `components/browser/PermissionModal.tsx` (camera/mic/location; currently plain fade Modal, unstyled buttons) → rebuilt on existing `Sheet` + glass: spring entrance, `warning` haptic on deny, `confirm` on allow
- Older wallet modals (`SpendingAuthorizationModal`, `BasketAccessModal`, `ProtocolAccessModal`) → visually aligned with the already-polished `PermissionSheet`: same glass material, same button hierarchy; keep `AmountDisplay`

### Press states & haptics

- Every `TouchableOpacity` / bare `Pressable` in interactive chrome → `PressableScale`. `ListRow` and `IconButton` updated internally so adopters inherit for free.
- Haptics adoption (~30 sites): tab select, toggle commits, permission grant/deny, payment confirm, QR scan success, swipe-delete commit, drag-reorder pickup/drop in `app/trust.tsx`.

### Explicitly untouched

Warm WebView pool, `WalletManagersContext` split, KeyboardAvoidingView structure, and all perf-critical paths from prior performance work.

## Part 4 — Browser Chrome Micro-interactions

### Free native wins (WebView props; verify not already set)

- `allowsBackForwardNavigationGestures` — edge-swipe navigation (biggest single "feels like Safari" item)
- `pullToRefreshEnabled` — native pull-to-refresh
- `allowsLinkPreview` — long-press link previews

### Address bar

- Focus transition: domain ↔ full-URL crossfade at `duration.instant`; suggestions dropdown springs in with `spring.settle`
- Page-load progress: 2px accent line under address bar, UI-thread Reanimated; eases to ~80% then completes on load event (never visually stalls)
- Security lock icon transitions via subtle crossfade

### Tabs

- Tab switch: 200ms opacity crossfade between pool WebViews (currently instant binary swap)
- TabsOverview: cards spring-stagger in (~20ms offsets); swipe-up-to-close keeps existing haptic; new tab zooms from the `+` button
- Tab count badge ticks with numeric roll

### Cut

- Scroll-aware address bar collapse — **out of scope by owner decision**.

## Part 5 — Signature Moments + Onboarding

### Celebration moments (exactly three)

1. **First payment ever sent** — subsequent payments get the quiet 300ms check only
2. **Wallet created** — checkmark, then identity identicon (dicebear, already a dependency) springs in
3. **Backup verified** — recovery shares printed/scanned successfully

### Permission grant (quiet by design)

Approve button morphs to checkmark; sheet auto-dismisses 400ms later; `success` haptic. Deny: `warning` haptic, plain dismiss. No celebration — permission grants are routine.

### Payments screen (`app/payments.tsx`)

- Amount input promoted to `largeTitle` with tabular numerals
- Animated currency toggle (sats ↔ fiat flip)
- Identity resolution result springs in as avatar + name card
- Send button morphs in place: idle → spinner → check (no layout jumps)

### Onboarding (presentation polish, not flow changes)

- `app/auth/mnemonic.tsx`: largeTitle hierarchy; mnemonic as numbered word-chips in a 2-column grid; copy → Toast; biometric step gets icon + one-line explanation; CTAs on `PressableScale`
- `Web3BenefitsModal`: aligned to glass/token language
- Default-browser prompt: `AlertCard` (Part 3)

## Part 6 — Constraints, Error Handling, Testing

- **Perf acceptance bar**: no JS-thread block >100ms from any new interaction; all animation UI-thread Reanimated; spot-check with existing `cwi.*` marks on device
- **Reduced motion**: all springs → fades; Celebration → static check + haptic
- **Error states**: every failure path formerly using `Alert.alert('Error', …)` → `error` haptic + Toast (transient) or AlertCard (needs action)
- **Testing**: component tests for AlertCard/Toast/useHaptics promise APIs; manual on-device pass for haptic and motion feel (simulator cannot validate haptics); every swept screen verified in dark and light mode
- **LiquidGlass guardrails** documented in `motion.ts` (no fractional ancestor opacity; remount-via-key cure)

## Implementation Order

1. Foundation: `motion.ts`, `useHaptics`, `PressableScale`
2. Primitives: `AlertCard`, `Toast`, `Celebration`
3. Consistency sweep: Alert.alert triage, modal unification, press states, haptics adoption
4. Browser chrome: native props, address bar, tabs
5. Signature moments: payments, celebrations, permission grant
6. Onboarding polish
7. Device verification pass (perf marks, haptics, dark/light)
