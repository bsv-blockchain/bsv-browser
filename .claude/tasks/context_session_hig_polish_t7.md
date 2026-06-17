# HIG Polish — T7: Toast Primitive + Host
## Session date: 2026-06-11
## Branch: feat/hig-polish
## Commit: 62e5563

## What was done

Implemented the native Toast notice capsule (spec Part 2) following strict TDD:

### Files created/modified
1. `__tests__/Toast.test.tsx` — new test file
2. `components/ui/Toast.tsx` — new component
3. `app/_layout.tsx` — mounted ToastHost as last child of outermost View (after Stack)

### Implementation notes

**Token verification** — all spec token names exist verbatim:
- `colors.sheetBackground`, `colors.separator`, `colors.textPrimary`, `colors.success`, `colors.error` — all in ThemeContext
- `spacing.sm/md/lg`, `radii.pill`, `typography.subhead` — all in tokens.ts
- `springs.snappy`, `durations.instant`, `durations.quick` — all in motion.ts

**Deviations from spec**

The spec test did not include a mock for `@expo/vector-icons`. Running the test revealed that `@expo/vector-icons` depends on `expo-font` which uses ESM export syntax and is not in the jest `transformIgnorePatterns`. Added `jest.mock('@expo/vector-icons', ...)` to the test header (same pattern as the expo-haptics mock). This is the correct fix — the component uses Ionicons for decorative icons only and mocking is appropriate in tests.

No changes to the component implementation were needed — only the test file needed the additional mock header.

**Layout placement** — ToastHost is mounted as the last child inside the outermost `<View style={{ flex: 1, backgroundColor }}>`, after `</Stack>`, inside ThemeProvider and WalletConnectionProvider. This gives it zIndex 10000 and positions it above all navigation content.

### Test results
- All 8 test suites pass, 18 tests total
- Toast test: 1 test, passes

### TypeScript errors
- Baseline: 12 (expected per spec)
- After Toast: 12 (no new errors introduced)

## Architecture of showToast / ToastHost

- Module-level `push` ref (null when unmounted)
- Queue of 1: newest message replaces current via `setToast`
- `nextId` counter ensures Animated.View key changes on every new toast (remounts animation)
- Auto-dismiss: 2000ms → fade out (250ms) → setState(null)
- Reduced motion: uses `withTiming(durations.instant)` instead of `withSpring(springs.snappy)`
- Position: `top: insets.top + spacing.sm` — below status bar
- `pointerEvents="none"` on outer View — never blocks touch

## Next task
T8: Celebration — see task #13
