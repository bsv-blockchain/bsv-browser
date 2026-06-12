# Delightful HIG Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved design spec `docs/superpowers/specs/2026-06-11-delightful-hig-polish-design.md` — Quiet Precision motion system, AlertCard/Toast/PressableScale/Celebration primitives, consistency sweep, browser-chrome micro-interactions, signature moments, onboarding polish.

**Architecture:** Primitives-first, then mechanical sweep. New design-system primitives live in `components/ui/` and `context/theme/`; imperative `showAlert`/`showToast` module APIs (host components mounted once in `app/_layout.tsx`) so plain utils can call them. All animation is UI-thread Reanimated 4; JS thread must never block >100ms.

**Tech Stack:** Expo 55, React Native 0.83, React 19.2, Reanimated 4.2.1, expo-haptics, react-native-svg 15.15.3, jest-expo + @testing-library/react-native (new).

**Hard constraints (from prior perf work — violating these is a plan failure):**
1. Never animate an ancestor's opacity fractionally above a LiquidGlass / UIVisualEffectView view. New primitives therefore use **solid/near-solid theme backgrounds** (`colors.sheetBackground`, `colors.backgroundElevated`), NOT BlurView/LiquidGlass.
2. Do not change the warm WebView pool structure, `WalletManagersContext`, or KeyboardAvoidingView placement. The tab-crossfade task only animates the existing opacity style value.
3. `react-toastify` is a web-only DOM library currently imported in 4 native files (silently broken on device) — it gets replaced by the native Toast and removed.

**Verification commands available in this repo** (no test infra exists before Task 1):
- Typecheck: `npx tsc --noEmit`
- Lint: `npm run lint`
- Tests (after Task 1): `npx jest`

---

### Task 1: Test infrastructure (jest-expo)

**Files:**
- Modify: `package.json` (devDependencies + scripts + jest config)

- [ ] **Step 1: Install dev dependencies**

```bash
npm install --save-dev jest-expo@~55.0.0 jest@~29.7.0 @testing-library/react-native@^13.3.0 @types/jest@^29.5.14
```

If `jest-expo@~55.0.0` does not resolve, run `npm view jest-expo versions --json | tail -20` and pick the latest 55.x (jest-expo majors track Expo SDK majors).

- [ ] **Step 2: Add jest config and test script to package.json**

Add to `package.json` top level (sibling of `"dependencies"`):

```json
"jest": {
  "preset": "jest-expo",
  "testMatch": ["**/__tests__/**/*.test.ts", "**/__tests__/**/*.test.tsx"],
  "transformIgnorePatterns": [
    "node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@sentry/react-native|native-base|react-native-svg|react-native-reanimated|react-native-gesture-handler)/)"
  ]
},
```

Add to `"scripts"`: `"test": "jest"`.

- [ ] **Step 3: Smoke test**

Create `__tests__/smoke.test.ts`:

```ts
describe('jest setup', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2)
  })
})
```

Run: `npx jest __tests__/smoke.test.ts`
Expected: PASS. If the preset explodes on this repo's babel config, fix per jest-expo docs before proceeding — all later tasks assume `npx jest` works.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json __tests__/smoke.test.ts
git commit -m "test: add jest-expo test infrastructure"
```

---

### Task 2: Motion tokens

**Files:**
- Create: `context/theme/motion.ts`
- Test: `__tests__/motion.test.ts`

- [ ] **Step 1: Write failing test**

`__tests__/motion.test.ts`:

```ts
import { springs, durations } from '@/context/theme/motion'

describe('motion tokens', () => {
  it('defines the two approved springs', () => {
    expect(springs.snappy).toEqual({ mass: 1, stiffness: 380, damping: 36 })
    expect(springs.settle).toEqual({ mass: 1, stiffness: 280, damping: 32 })
  })
  it('caps every duration at 350ms (Quiet Precision)', () => {
    expect(durations.instant).toBe(150)
    expect(durations.quick).toBe(250)
    expect(durations.moderate).toBe(350)
    Object.values(durations).forEach(d => expect(d).toBeLessThanOrEqual(350))
  })
})
```

Run: `npx jest __tests__/motion.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 2: Implement `context/theme/motion.ts`**

```ts
/**
 * Motion tokens — "Quiet Precision" (see docs/superpowers/specs/2026-06-11-delightful-hig-polish-design.md).
 *
 * Rules:
 *  - All animation runs on the UI thread via Reanimated. Never drive animation
 *    from setState/JS timers on interaction paths.
 *  - Nothing animates longer than `durations.moderate` (350ms).
 *  - Respect reduced motion: gate springs/translations behind
 *    `useReducedMotion()` from react-native-reanimated — collapse to opacity
 *    fades or instant changes.
 *
 * LiquidGlass / UIVisualEffectView guardrails (hard-won — do not regress):
 *  - NEVER animate an ancestor's opacity fractionally above LiquidGlass or
 *    BlurView content; the effect view freezes at a stale frame.
 *  - A stuck UIVisualEffectView is cured by remounting via a changed `key`.
 */

export const springs = {
  /** Buttons, small elements, alert cards. */
  snappy: { mass: 1, stiffness: 380, damping: 36 },
  /** Larger surfaces: sheets, popovers, dropdowns. */
  settle: { mass: 1, stiffness: 280, damping: 32 },
} as const

export const durations = {
  /** Crossfades, press feedback. */
  instant: 150,
  /** Small movements, toasts. */
  quick: 250,
  /** Largest allowed — full-surface transitions. */
  moderate: 350,
} as const
```

- [ ] **Step 3: Run test** — `npx jest __tests__/motion.test.ts` — Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add context/theme/motion.ts __tests__/motion.test.ts
git commit -m "feat: add Quiet Precision motion tokens"
```

---

### Task 3: Haptic vocabulary

**Files:**
- Create: `hooks/useHaptics.ts`
- Test: `__tests__/useHaptics.test.ts`

- [ ] **Step 1: Write failing test**

`__tests__/useHaptics.test.ts`:

```ts
jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(() => Promise.resolve()),
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}))

import * as Haptics from 'expo-haptics'
import { Platform } from 'react-native'
import { haptics } from '@/hooks/useHaptics'

describe('haptic vocabulary', () => {
  beforeEach(() => jest.clearAllMocks())

  it('maps semantics to the iOS APIs from the spec', () => {
    Platform.OS = 'ios'
    haptics.tap()
    expect(Haptics.selectionAsync).toHaveBeenCalled()
    haptics.confirm()
    expect(Haptics.impactAsync).toHaveBeenCalledWith('light')
    haptics.success()
    expect(Haptics.notificationAsync).toHaveBeenCalledWith('success')
    haptics.warning()
    expect(Haptics.notificationAsync).toHaveBeenCalledWith('warning')
    haptics.error()
    expect(Haptics.notificationAsync).toHaveBeenCalledWith('error')
  })

  it('no-ops tap/confirm on android', () => {
    Platform.OS = 'android'
    haptics.tap()
    haptics.confirm()
    expect(Haptics.selectionAsync).not.toHaveBeenCalled()
    expect(Haptics.impactAsync).not.toHaveBeenCalled()
    Platform.OS = 'ios'
  })
})
```

Run: `npx jest __tests__/useHaptics.test.ts` — Expected: FAIL.

- [ ] **Step 2: Implement `hooks/useHaptics.ts`**

```ts
/**
 * Semantic haptic vocabulary (spec Part 1). Import `haptics` directly in
 * plain modules; use `useHaptics()` in components for symmetry with other
 * hooks. All calls are fire-and-forget and never throw.
 *
 * | semantic | iOS                         | Android |
 * |----------|-----------------------------|---------|
 * | tap      | selectionAsync              | no-op   |
 * | confirm  | impactAsync(Light)          | no-op   |
 * | success  | notificationAsync(Success)  | vibrate |
 * | warning  | notificationAsync(Warning)  | vibrate |
 * | error    | notificationAsync(Error)    | vibrate |
 */
import * as Haptics from 'expo-haptics'
import { Platform } from 'react-native'

const swallow = (p: Promise<void>) => { p.catch(() => {}) }
const isIOS = () => Platform.OS === 'ios'

export const haptics = {
  tap: () => { if (isIOS()) swallow(Haptics.selectionAsync()) },
  confirm: () => { if (isIOS()) swallow(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)) },
  success: () => swallow(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
  warning: () => swallow(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)),
  error: () => swallow(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)),
} as const

export type HapticName = keyof typeof haptics

export const useHaptics = () => haptics
```

- [ ] **Step 3: Run test** — Expected: PASS.

- [ ] **Step 4: Migrate the 4 existing ad-hoc Haptics call sites**

- `app/auth/scan-shares.tsx:51` `Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)` → `haptics.error()`
- `app/auth/scan-shares.tsx:56` Success → `haptics.success()`
- `app/auth/scan-shares.tsx:113` Error → `haptics.error()`
- `components/browser/TabsOverview.tsx:179` `Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)` → `haptics.confirm()`

In each file: replace `import * as Haptics from 'expo-haptics'` with `import { haptics } from '@/hooks/useHaptics'` (keep the import if other Haptics APIs remain — there are none).

- [ ] **Step 5: Verify and commit**

Run: `npx tsc --noEmit && npm run lint && npx jest`
Expected: clean.

```bash
git add hooks/useHaptics.ts __tests__/useHaptics.test.ts app/auth/scan-shares.tsx components/browser/TabsOverview.tsx
git commit -m "feat: add semantic haptic vocabulary, migrate ad-hoc call sites"
```

---

### Task 4: PressableScale

**Files:**
- Create: `components/ui/PressableScale.tsx`
- Test: `__tests__/PressableScale.test.tsx`

- [ ] **Step 1: Write failing test**

`__tests__/PressableScale.test.tsx`:

```tsx
import React from 'react'
import { Text } from 'react-native'
import { render, fireEvent } from '@testing-library/react-native'
import PressableScale from '@/components/ui/PressableScale'

describe('PressableScale', () => {
  it('renders children and fires onPress', () => {
    const onPress = jest.fn()
    const { getByText } = render(
      <PressableScale onPress={onPress} accessibilityLabel="go">
        <Text>Go</Text>
      </PressableScale>
    )
    fireEvent.press(getByText('Go'))
    expect(onPress).toHaveBeenCalled()
  })
})
```

Run: `npx jest __tests__/PressableScale.test.tsx` — Expected: FAIL.

- [ ] **Step 2: Implement `components/ui/PressableScale.tsx`**

```tsx
/**
 * Standard press feedback (spec Part 2): scale 0.97 + opacity 0.85, driven by
 * a UI-thread spring. Replaces bare TouchableOpacity / opacity-only Pressable
 * in interactive chrome. Optional semantic haptic on press.
 */
import React, { useCallback } from 'react'
import { Pressable, PressableProps, StyleProp, ViewStyle, GestureResponderEvent } from 'react-native'
import Animated, { useSharedValue, useAnimatedStyle, withSpring } from 'react-native-reanimated'
import { springs } from '@/context/theme/motion'
import { haptics, HapticName } from '@/hooks/useHaptics'

interface PressableScaleProps extends Omit<PressableProps, 'style'> {
  /** Style for the animated content view (Pressable itself stays unstyled). */
  style?: StyleProp<ViewStyle>
  haptic?: HapticName
  scaleTo?: number
  children?: React.ReactNode
}

export default function PressableScale({
  style,
  haptic,
  scaleTo = 0.97,
  onPressIn,
  onPressOut,
  onPress,
  children,
  ...rest
}: PressableScaleProps) {
  const pressed = useSharedValue(0)

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 - (1 - scaleTo) * pressed.value }],
    opacity: 1 - 0.15 * pressed.value,
  }))

  const handlePressIn = useCallback((e: GestureResponderEvent) => {
    pressed.value = withSpring(1, springs.snappy)
    onPressIn?.(e)
  }, [onPressIn, pressed])

  const handlePressOut = useCallback((e: GestureResponderEvent) => {
    pressed.value = withSpring(0, springs.snappy)
    onPressOut?.(e)
  }, [onPressOut, pressed])

  const handlePress = useCallback((e: GestureResponderEvent) => {
    if (haptic) haptics[haptic]()
    onPress?.(e)
  }, [haptic, onPress])

  return (
    <Pressable
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      onPress={handlePress}
      accessibilityRole="button"
      {...rest}
    >
      <Animated.View style={[style, animatedStyle]}>{children}</Animated.View>
    </Pressable>
  )
}
```

- [ ] **Step 3: Run test** — Expected: PASS. (If Reanimated mocking fails, add `jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'))` to the test top.)

- [ ] **Step 4: Commit**

```bash
git add components/ui/PressableScale.tsx __tests__/PressableScale.test.tsx
git commit -m "feat: add PressableScale press-feedback primitive"
```

---

### Task 5: Upgrade IconButton + ListRow press feedback internally

**Files:**
- Modify: `components/ui/IconButton.tsx` (pressed style at lines ~36-44, styles ~61-73)
- Modify: `components/ui/ListRow.tsx` (Pressable wrapper at lines ~73-82)

All existing consumers inherit the new feel for free. **Do not change either component's props.**

- [ ] **Step 1: IconButton** — replace its `Pressable` with `PressableScale`:

```tsx
import PressableScale from '@/components/ui/PressableScale'
```

Replace the `Pressable` element with (preserving all existing props/styles/badge children inside):

```tsx
<PressableScale
  onPress={onPress}
  onLongPress={onLongPress}
  disabled={disabled}
  style={[styles.container, disabled && styles.disabled]}
  accessibilityLabel={accessibilityLabel}
  hitSlop={4}
  scaleTo={0.92}
>
  {/* existing icon + badge children unchanged */}
</PressableScale>
```

Delete the now-unused `pressed: { opacity: 0.5 }` style. Keep `disabled`. (44pt icon buttons read better with a slightly deeper 0.92 scale.)

- [ ] **Step 2: ListRow** — replace its conditional Pressable wrapper:

```tsx
if (onPress) {
  return (
    <PressableScale onPress={onPress} scaleTo={0.98} haptic="tap">
      {content}
    </PressableScale>
  )
}
```

(Rows are wide — 0.98 is enough. `tap` haptic gives list navigation the segmented-control feel from the spec table.)

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npm run lint && npx jest`
Expected: clean. Then launch dev build if available and tap settings rows / toolbar icons: scale-spring feedback, no layout shift.

- [ ] **Step 4: Commit**

```bash
git add components/ui/IconButton.tsx components/ui/ListRow.tsx
git commit -m "feat: spring press feedback in IconButton and ListRow"
```

---

### Task 6: AlertCard primitive + host

**Files:**
- Create: `components/ui/AlertCard.tsx`
- Modify: `app/_layout.tsx` (mount host)
- Test: `__tests__/AlertCard.test.tsx`

Design (locked in spec): center glass alert card. To honor the LiquidGlass guardrail we use the near-solid `colors.sheetBackground` (0.97 alpha) — no BlurView, so the card itself may fade in safely. Entrance: scale 0.95→1 with `springs.snappy` + backdrop dim fade `durations.instant`. `warning` haptic when a destructive button is present. Promise API resolves the pressed button's `key`.

- [ ] **Step 1: Write failing test**

`__tests__/AlertCard.test.tsx`:

```tsx
import React from 'react'
import { render, fireEvent, act } from '@testing-library/react-native'
import { AlertHost, showAlert } from '@/components/ui/AlertCard'
import { ThemeProvider } from '@/context/theme/ThemeContext'

const host = () => render(<ThemeProvider><AlertHost /></ThemeProvider>)

describe('showAlert', () => {
  it('renders title/message and resolves pressed button key', async () => {
    const screen = host()
    let result: Promise<string>
    act(() => {
      result = showAlert({
        title: 'Delete Certifier?',
        message: 'Apps will no longer resolve identities.',
        buttons: [
          { text: 'Cancel', style: 'cancel', key: 'cancel' },
          { text: 'Delete', style: 'destructive', key: 'delete' },
        ],
      })
    })
    expect(screen.getByText('Delete Certifier?')).toBeTruthy()
    expect(screen.getByText('Apps will no longer resolve identities.')).toBeTruthy()
    fireEvent.press(screen.getByText('Delete'))
    await expect(result!).resolves.toBe('delete')
  })

  it('defaults to a single OK button resolving "ok"', async () => {
    const screen = host()
    let result: Promise<string>
    act(() => { result = showAlert({ title: 'Heads up' }) })
    fireEvent.press(screen.getByText('OK'))
    await expect(result!).resolves.toBe('ok')
  })
})
```

Run: `npx jest __tests__/AlertCard.test.tsx` — Expected: FAIL.

- [ ] **Step 2: Implement `components/ui/AlertCard.tsx`**

```tsx
/**
 * Glass Alert Card (spec Part 2) — themed replacement for Alert.alert.
 * Imperative promise API so plain utils can call it:
 *
 *   const choice = await showAlert({
 *     title, message,
 *     buttons: [
 *       { text: t('cancel'), style: 'cancel', key: 'cancel' },
 *       { text: t('delete'), style: 'destructive', key: 'delete' },
 *     ],
 *   })
 *   if (choice === 'delete') { ... }
 *
 * <AlertHost /> must be mounted once, inside ThemeProvider (app/_layout.tsx).
 * Background is near-solid sheetBackground — deliberately NOT BlurView/LiquidGlass
 * (fractional-opacity-over-effect-view guardrail in context/theme/motion.ts).
 */
import React, { useCallback, useEffect, useState } from 'react'
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  useReducedMotion,
} from 'react-native-reanimated'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, radii, typography } from '@/context/theme/tokens'
import { springs, durations } from '@/context/theme/motion'
import { haptics } from '@/hooks/useHaptics'

export interface AlertButton {
  text: string
  style?: 'default' | 'cancel' | 'destructive'
  /** Resolution value. Defaults to lowercased text. */
  key?: string
}

export interface AlertOptions {
  title: string
  message?: string
  /** Defaults to a single OK button (key "ok"). Max 3; 2 render side-by-side, 3 stack. */
  buttons?: AlertButton[]
}

type ActiveAlert = AlertOptions & { resolve: (key: string) => void }

let enqueue: ((a: ActiveAlert) => void) | null = null

export function showAlert(options: AlertOptions): Promise<string> {
  return new Promise<string>(resolve => {
    if (!enqueue) {
      console.warn('[AlertCard] AlertHost not mounted; resolving "cancel"')
      resolve('cancel')
      return
    }
    enqueue({ ...options, resolve })
  })
}

const DEFAULT_BUTTONS: AlertButton[] = [{ text: 'OK', key: 'ok' }]

export function AlertHost() {
  const { colors } = useTheme()
  const reducedMotion = useReducedMotion()
  const [queue, setQueue] = useState<ActiveAlert[]>([])
  const current = queue[0] ?? null

  const progress = useSharedValue(0)

  useEffect(() => {
    enqueue = (a: ActiveAlert) => setQueue(q => [...q, a])
    return () => { enqueue = null }
  }, [])

  useEffect(() => {
    if (current) {
      if (current.buttons?.some(b => b.style === 'destructive')) haptics.warning()
      progress.value = reducedMotion
        ? withTiming(1, { duration: durations.instant })
        : withSpring(1, springs.snappy)
    }
  }, [current, progress, reducedMotion])

  const dismiss = useCallback((key: string) => {
    if (!current) return
    current.resolve(key)
    progress.value = withTiming(0, { duration: durations.instant })
    // Unmount after the exit fade completes.
    setTimeout(() => setQueue(q => q.slice(1)), durations.instant)
  }, [current, progress])

  const backdropStyle = useAnimatedStyle(() => ({ opacity: progress.value }))
  const cardStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ scale: 0.95 + 0.05 * progress.value }],
  }))

  if (!current) return null
  const buttons = current.buttons?.length ? current.buttons : DEFAULT_BUTTONS
  const sideBySide = buttons.length === 2

  const buttonColor = (b: AlertButton) =>
    b.style === 'destructive' ? colors.error
    : b.style === 'cancel' ? colors.textSecondary
    : colors.info

  return (
    <Modal transparent visible animationType="none" onRequestClose={() => dismiss('cancel')}>
      <Animated.View style={[styles.backdrop, backdropStyle]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={() => dismiss('cancel')} />
        <Animated.View
          style={[
            styles.card,
            { backgroundColor: colors.sheetBackground, borderColor: colors.separator },
            cardStyle,
          ]}
        >
          <Text style={[styles.title, { color: colors.textPrimary }]}>{current.title}</Text>
          {!!current.message && (
            <Text style={[styles.message, { color: colors.textSecondary }]}>{current.message}</Text>
          )}
          <View style={[styles.buttonGroup, { borderTopColor: colors.separator }, !sideBySide && styles.buttonGroupStacked]}>
            {buttons.map((b, i) => (
              <Pressable
                key={b.key ?? b.text}
                onPress={() => dismiss(b.key ?? b.text.toLowerCase())}
                style={({ pressed }) => [
                  styles.button,
                  sideBySide && i > 0 && { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.separator },
                  !sideBySide && i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.separator },
                  pressed && { backgroundColor: colors.fillTertiary },
                ]}
                accessibilityRole="button"
              >
                <Text
                  style={[
                    styles.buttonText,
                    { color: buttonColor(b) },
                    (b.style === 'destructive' || b.style === 'cancel') && styles.buttonTextBold,
                  ]}
                >
                  {b.text}
                </Text>
              </Pressable>
            ))}
          </View>
        </Animated.View>
      </Animated.View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  card: {
    width: 280,
    borderRadius: radii.xl,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    paddingTop: spacing.xl,
  },
  title: {
    ...typography.headline,
    textAlign: 'center',
    paddingHorizontal: spacing.xl,
  },
  message: {
    ...typography.footnote,
    textAlign: 'center',
    paddingHorizontal: spacing.xl,
    marginTop: spacing.xs,
  },
  buttonGroup: {
    flexDirection: 'row',
    marginTop: spacing.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  buttonGroupStacked: { flexDirection: 'column' },
  button: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.md,
  },
  buttonText: { ...typography.body, textAlign: 'center' },
  buttonTextBold: { fontWeight: '600' },
})
```

- [ ] **Step 3: Mount host in `app/_layout.tsx`**

Add import `import { AlertHost } from '@/components/ui/AlertCard'` and render `<AlertHost />` directly after `<PermissionSheet />` (inside ThemeProvider, line ~116).

- [ ] **Step 4: Run test** — `npx jest __tests__/AlertCard.test.tsx` — Expected: PASS. Then `npx tsc --noEmit && npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add components/ui/AlertCard.tsx app/_layout.tsx __tests__/AlertCard.test.tsx
git commit -m "feat: add AlertCard glass alert with promise API"
```

---

### Task 7: Toast primitive + host

**Files:**
- Create: `components/ui/Toast.tsx`
- Modify: `app/_layout.tsx` (mount host)
- Test: `__tests__/Toast.test.tsx`

Design: non-modal glass capsule at top (safe-area aware), slides in with `springs.snappy`, auto-dismisses after 2s, queue of 1 (newest replaces current). `success`/`error` variants fire matching haptic and show a tinted Ionicons icon.

- [ ] **Step 1: Write failing test**

`__tests__/Toast.test.tsx`:

```tsx
import React from 'react'
import { render, act } from '@testing-library/react-native'
import { ToastHost, showToast } from '@/components/ui/Toast'
import { ThemeProvider } from '@/context/theme/ThemeContext'

jest.useFakeTimers()

describe('showToast', () => {
  it('renders message, newest wins, auto-dismisses after 2s', () => {
    const screen = render(<ThemeProvider><ToastHost /></ThemeProvider>)
    act(() => { showToast('Copied') })
    expect(screen.getByText('Copied')).toBeTruthy()
    act(() => { showToast('Exported', { type: 'success' }) })
    expect(screen.queryByText('Copied')).toBeNull()
    expect(screen.getByText('Exported')).toBeTruthy()
    act(() => { jest.advanceTimersByTime(2600) })
    expect(screen.queryByText('Exported')).toBeNull()
  })
})
```

Run — Expected: FAIL.

- [ ] **Step 2: Implement `components/ui/Toast.tsx`**

```tsx
/**
 * Non-modal notice capsule (spec Part 2). For FYI messages only — decisions
 * use showAlert. Queue of 1: newest replaces current. Auto-dismiss 2s.
 *
 *   showToast('Copied')
 *   showToast(t('export_failed'), { type: 'error' })
 *
 * <ToastHost /> must be mounted once, inside ThemeProvider, ABOVE the Stack
 * (app/_layout.tsx). Near-solid background — no BlurView (see motion.ts).
 */
import React, { useEffect, useRef, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  useReducedMotion,
} from 'react-native-reanimated'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, radii, typography } from '@/context/theme/tokens'
import { springs, durations } from '@/context/theme/motion'
import { haptics } from '@/hooks/useHaptics'

export type ToastType = 'info' | 'success' | 'error'
interface ToastData { id: number; message: string; type: ToastType }

const TOAST_MS = 2000

let push: ((message: string, type: ToastType) => void) | null = null
let nextId = 1

export function showToast(message: string, opts?: { type?: ToastType }) {
  const type = opts?.type ?? 'info'
  if (type === 'success') haptics.success()
  if (type === 'error') haptics.error()
  if (!push) { console.warn('[Toast] ToastHost not mounted:', message); return }
  push(message, type)
}

export function ToastHost() {
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const reducedMotion = useReducedMotion()
  const [toast, setToast] = useState<ToastData | null>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const progress = useSharedValue(0)

  useEffect(() => {
    push = (message, type) => {
      if (hideTimer.current) clearTimeout(hideTimer.current)
      setToast({ id: nextId++, message, type })
    }
    return () => { push = null }
  }, [])

  useEffect(() => {
    if (!toast) return
    progress.value = 0
    progress.value = reducedMotion
      ? withTiming(1, { duration: durations.instant })
      : withSpring(1, springs.snappy)
    hideTimer.current = setTimeout(() => {
      progress.value = withTiming(0, { duration: durations.quick })
      hideTimer.current = setTimeout(() => setToast(null), durations.quick)
    }, TOAST_MS)
    return () => { if (hideTimer.current) clearTimeout(hideTimer.current) }
  }, [toast, progress, reducedMotion])

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: -12 * (1 - progress.value) }],
  }))

  if (!toast) return null

  const icon = toast.type === 'success' ? 'checkmark-circle'
    : toast.type === 'error' ? 'alert-circle'
    : null
  const iconColor = toast.type === 'success' ? colors.success : colors.error

  return (
    <View pointerEvents="none" style={[styles.wrap, { top: insets.top + spacing.sm }]}>
      <Animated.View
        key={toast.id}
        style={[
          styles.capsule,
          { backgroundColor: colors.sheetBackground, borderColor: colors.separator },
          animatedStyle,
        ]}
      >
        {icon && <Ionicons name={icon} size={18} color={iconColor} style={styles.icon} />}
        <Text numberOfLines={2} style={[styles.text, { color: colors.textPrimary }]}>
          {toast.message}
        </Text>
      </Animated.View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 10000,
  },
  capsule: {
    flexDirection: 'row',
    alignItems: 'center',
    maxWidth: '86%',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radii.pill,
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  icon: { marginRight: spacing.sm },
  text: { ...typography.subhead, flexShrink: 1 },
})
```

Note: if `react-native-safe-area-context` is not already a dependency (Expo Router projects normally include it), check `package.json`; if absent, use a fixed `top: 60` and flag in the commit message.

- [ ] **Step 3: Mount in `app/_layout.tsx`** — `import { ToastHost } from '@/components/ui/Toast'`, render `<ToastHost />` as the LAST child inside the `<View style={{ flex: 1, backgroundColor }}>` (after `</Stack>`) so it overlays screens.

- [ ] **Step 4: Run test** — Expected: PASS. Then `npx tsc --noEmit && npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add components/ui/Toast.tsx app/_layout.tsx __tests__/Toast.test.tsx
git commit -m "feat: add native Toast notice capsule"
```

---

### Task 8: Celebration primitive

**Files:**
- Create: `components/ui/Celebration.tsx`

Drawn checkmark (SVG stroke draw) + `success` haptic, ~600ms total. Used in exactly 3 places (Task 17). Not modal — renders inline where mounted.

- [ ] **Step 1: Implement `components/ui/Celebration.tsx`**

```tsx
/**
 * Celebration checkmark (spec Part 5) — used in EXACTLY three places:
 * first payment sent, wallet created, backup verified. Everything else uses
 * quiet feedback. Drawn check + success haptic; reduced motion = static check.
 */
import React, { useEffect } from 'react'
import { StyleSheet, View } from 'react-native'
import Svg, { Circle, Path } from 'react-native-svg'
import Animated, {
  useSharedValue,
  useAnimatedProps,
  useAnimatedStyle,
  withSpring,
  withTiming,
  withDelay,
  useReducedMotion,
} from 'react-native-reanimated'
import { useTheme } from '@/context/theme/ThemeContext'
import { springs } from '@/context/theme/motion'
import { haptics } from '@/hooks/useHaptics'

const AnimatedPath = Animated.createAnimatedComponent(Path)
const CHECK_LENGTH = 48 // measured stroke length of the check path below

interface CelebrationProps {
  size?: number
  /** Called ~700ms after mount, when the moment has landed. */
  onDone?: () => void
}

export default function Celebration({ size = 88, onDone }: CelebrationProps) {
  const { colors } = useTheme()
  const reducedMotion = useReducedMotion()
  const scale = useSharedValue(reducedMotion ? 1 : 0.6)
  const opacity = useSharedValue(reducedMotion ? 1 : 0)
  const draw = useSharedValue(reducedMotion ? 0 : CHECK_LENGTH)

  useEffect(() => {
    haptics.success()
    if (!reducedMotion) {
      scale.value = withSpring(1, springs.snappy)
      opacity.value = withTiming(1, { duration: 150 })
      draw.value = withDelay(120, withTiming(0, { duration: 320 }))
    }
    if (onDone) {
      const t = setTimeout(onDone, 700)
      return () => clearTimeout(t)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const circleStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ scale: scale.value }],
  }))
  const pathProps = useAnimatedProps(() => ({ strokeDashoffset: draw.value }))

  return (
    <View style={styles.center}>
      <Animated.View style={circleStyle}>
        <Svg width={size} height={size} viewBox="0 0 88 88">
          <Circle cx="44" cy="44" r="42" fill={colors.success} />
          <AnimatedPath
            d="M26 45 L39 58 L62 32"
            stroke="#FFFFFF"
            strokeWidth={6}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
            strokeDasharray={CHECK_LENGTH}
            animatedProps={pathProps}
          />
        </Svg>
      </Animated.View>
    </View>
  )
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
})
```

- [ ] **Step 2: Verify** — `npx tsc --noEmit && npm run lint && npx jest`. Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add components/ui/Celebration.tsx
git commit -m "feat: add Celebration drawn-checkmark primitive"
```

---

### Task 9: Alert.alert sweep — every site, by file

**Files (all Modify):** `app/wallet-config.tsx`, `app/trust.tsx`, `app/auth/scan-shares.tsx`, `app/connections.tsx`, `utils/importDatabases.ts`, `app/auth/mnemonic.tsx`, `components/onboarding/DefaultBrowserPrompt.tsx`

Conversion rules (apply mechanically):
- **DECISION** (buttons with callbacks) → `await showAlert({...})`, branch on resolved key. Destructive action gets `style: 'destructive'`.
- **Blocking NOTICE** (single button, user must acknowledge before flow continues) → `await showAlert({ title, message })`.
- **Transient NOTICE** (errors/info mid-flow, nothing depends on acknowledgment) → `showToast(message, { type: 'error' })` (or `'success'`/`'info'`).
- Remove `Alert` from the `react-native` import in each file when the last call is gone.
- Keep every `t(...)`/`i18n.t(...)` string exactly as-is.

Full site list with target treatment:

| File:Line | Current | Treatment |
|---|---|---|
| wallet-config.tsx:147 | 'Error' / wallet key access | `showToast(msg, { type: 'error' })` |
| wallet-config.tsx:179 | import success | `showToast(t('import_success'), { type: 'success' })` |
| wallet-config.tsx:553 | delete wallet warning | `showAlert` — cancel + destructive `delete` |
| trust.tsx:140 | confirm delete certifier | `showAlert` — cancel + destructive `delete` |
| scan-shares.tsx:85 | biometric required (Cancel/Try Again) | `showAlert` — `cancel` + `retry` keys |
| connections.tsx:112 | invalid QR | `showToast(..., { type: 'error' })` |
| connections.tsx:116 | wallet not ready | `showToast(..., { type: 'error' })` |
| connections.tsx:124 | connection failed | `showToast(..., { type: 'error' })` |
| connections.tsx:176 | reconnect failed | `showToast(..., { type: 'error' })` |
| importDatabases.ts:51 | invalid file (done btn) | `await showAlert({ title, message })` (blocking) |
| importDatabases.ts:81 | import conflict (cancel/anyway) | `showAlert` — `cancel` + destructive `import` |
| importDatabases.ts:90 | import confirm (cancel/import) | `showAlert` — `cancel` + default `import` |
| importDatabases.ts:106 | invalid file + e.message | `showToast(..., { type: 'error' })` |
| importDatabases.ts:128 | invalid file + e.message | `showToast(..., { type: 'error' })` |
| mnemonic.tsx:67,155,194 | biometric required (Cancel/Try Again) | `showAlert` — `cancel` + `retry` |
| mnemonic.tsx:81 | generate failed | `showToast(..., { type: 'error' })` |
| mnemonic.tsx:169 | invalid private key | `showToast(..., { type: 'error' })` |
| mnemonic.tsx:177 | invalid recovery phrase | `showToast(..., { type: 'error' })` |
| mnemonic.tsx:209 | wallet setup failed | `showToast(..., { type: 'error' })` |
| DefaultBrowserPrompt.tsx:48,67,76,129,143 | see Step 3 — full rewrite below | `showAlert` |

Worked example — `app/trust.tsx:140` becomes:

```ts
const choice = await showAlert({
  title: t('confirm_delete'),
  message: t('confirm_delete_body'),
  buttons: [
    { text: t('cancel'), style: 'cancel', key: 'cancel' },
    { text: t('delete'), style: 'destructive', key: 'delete' },
  ],
})
if (choice !== 'delete') return
// ...existing delete logic from the old onPress callback...
```

Callback-style sites: move each button's `onPress` body under the corresponding `if (choice === '<key>')` branch. The enclosing function may need `async`.

- [ ] **Step 1:** Convert `app/wallet-config.tsx` (3 sites). Verify `npx tsc --noEmit`. Commit `refactor: wallet-config alerts → AlertCard/Toast`.
- [ ] **Step 2:** Convert `app/trust.tsx` (1), `app/auth/scan-shares.tsx` (1), `app/connections.tsx` (4). Verify. Commit `refactor: trust/scan-shares/connections alerts → AlertCard/Toast`.
- [ ] **Step 3:** Rewrite `components/onboarding/DefaultBrowserPrompt.tsx` — replace each `Alert.alert` with `showAlert`, preserving the exact flow logic (3-day delay, AsyncStorage flags, Linking calls). The iOS instructions alert (lines 48-61 and the nested one at 143-156) becomes:

```ts
const choice = await showAlert({
  title: 'Set Default Browser',
  message: 'To set BSV Browser as your default browser:\n\n1. Go to Settings\n2. Scroll down to BSV Browser\n3. Tap "Default Browser App"\n4. Select BSV Browser',
  buttons: [
    { text: 'Cancel', style: 'cancel', key: 'cancel' },
    { text: 'Open Settings', key: 'open' },
  ],
})
if (choice === 'open') Linking.openSettings()
```

The main prompt (lines 75-91):

```ts
const choice = await showAlert({
  title: 'Set as Default Browser',
  message: 'Would you like to set BSV Browser as your default browser? This will allow you to open web links directly in BSV Browser.',
  buttons: [
    { text: 'Not Now', style: 'cancel', key: 'later' },
    { text: 'Set as Default', key: 'set' },
  ],
})
if (choice === 'set') await openDefaultBrowserSettings()
else await markPromptShown()
```

The error notice (line 67) → `showToast('Could not open settings. Set BSV Browser as default in device settings.', { type: 'error' })`. Apply the same conversion inside `showManualDefaultBrowserPrompt`. Verify. Commit `refactor: default-browser prompt on AlertCard`.

- [ ] **Step 4:** Convert `utils/importDatabases.ts` (5 sites — this is the plain-module consumer that motivated the imperative API). Verify. Commit `refactor: importDatabases alerts → AlertCard/Toast`.
- [ ] **Step 5:** Convert `app/auth/mnemonic.tsx` (7 sites). Verify. Commit `refactor: mnemonic alerts → AlertCard/Toast`.
- [ ] **Step 6:** Confirm zero remaining: `grep -rn "Alert.alert" app components utils services --include="*.ts*"` — Expected: no matches. Run `npx jest`.

---

### Task 10: Replace react-toastify with native Toast

**Files:**
- Modify: `context/WalletContext.tsx` (toast import + CSS import, ~lines 38-39), `app/transactions.tsx`, `app/logs.tsx`, `app/payments.tsx`
- Modify: `package.json` (remove dependency)

- [ ] **Step 1:** In each of the 4 files: replace `import { toast } from 'react-toastify'` with `import { showToast } from '@/components/ui/Toast'`; map `toast.success(m)` → `showToast(m, { type: 'success' })`, `toast.error(m)` → `showToast(m, { type: 'error' })`, bare `toast(m)` → `showToast(m)`. Delete the react-toastify CSS import in `context/WalletContext.tsx`. If a call passes react-toastify option objects, drop the options.
- [ ] **Step 2:** `npm uninstall react-toastify`
- [ ] **Step 3:** Verify: `grep -rn "react-toastify" --include="*.ts*" app components context utils` → no matches. `npx tsc --noEmit && npm run lint && npx jest`.
- [ ] **Step 4:** Commit `refactor: replace web-only react-toastify with native Toast`.

---### Task 11: Rebuild PermissionModal on Sheet

**Files:**
- Modify: `components/browser/PermissionModal.tsx` (full rewrite, keep props contract)

Keep the exact props (`visible, domain, permission, onDecision`) and the permission-label mapping (lines 16-37). Replace the plain `Modal` with the app `Sheet`:

- [ ] **Step 1: Rewrite render**

```tsx
import Sheet from '@/components/ui/Sheet'
import PressableScale from '@/components/ui/PressableScale'
import { useHaptics } from '@/hooks/useHaptics'
import { spacing, radii, typography, hitTargets } from '@/context/theme/tokens'
import { Ionicons } from '@expo/vector-icons'
```

Structure (mirror PermissionSheet's button hierarchy):

```tsx
const haptics = useHaptics()
const decide = (granted: boolean) => {
  granted ? haptics.confirm() : haptics.warning()
  onDecision(granted)
}

return (
  <Sheet visible={visible} onClose={() => onDecision(false)} fitContent>
    <View style={styles.body}>
      <View style={[styles.iconCircle, { backgroundColor: colors.fillTertiary }]}>
        <Ionicons name={iconForPermission(permission)} size={26} color={colors.textPrimary} />
      </View>
      <Text style={[typography.headline, { color: colors.textPrimary, textAlign: 'center' }]}>
        {t('permission_request') /* fall back to 'Permission Request' if no key exists */}
      </Text>
      <Text style={[typography.subhead, { color: colors.textSecondary, textAlign: 'center', marginTop: spacing.xs }]}>
        {domain} is requesting access to your {friendlyLabel}.
      </Text>
      <View style={styles.buttonRow}>
        <PressableScale onPress={() => decide(false)} style={[styles.buttonDeny, { borderColor: colors.separator }]}>
          <Text style={[typography.body, { color: colors.textSecondary }]}>Don't Allow</Text>
        </PressableScale>
        <PressableScale onPress={() => decide(true)} style={[styles.buttonAllow, { backgroundColor: colors.accent }]}>
          <Text style={[typography.body, { color: colors.textOnAccent, fontWeight: '600' }]}>Allow</Text>
        </PressableScale>
      </View>
    </View>
  </Sheet>
)
```

`iconForPermission`: CAMERA→`camera`, RECORD_AUDIO→`mic`, NOTIFICATIONS→`notifications`, location→`location`, fallback `shield-checkmark`. Buttons: row, `gap: spacing.md`, each `flex: 1, minHeight: hitTargets.minimum, borderRadius: radii.lg, alignItems/justifyContent: center`; deny has `borderWidth: StyleSheet.hairlineWidth`. Body padding `spacing.xl`, icon circle 56pt, centered, `marginBottom: spacing.md`.

- [ ] **Step 2:** Verify `npx tsc --noEmit && npm run lint`. Grep callers of `PermissionModal` to confirm props unchanged usage compiles.
- [ ] **Step 3:** Commit `feat: rebuild web PermissionModal on Sheet with haptics`.

---

### Task 12: Align legacy wallet modals with PermissionSheet

**Files:**
- Modify: `components/wallet/SpendingAuthorizationModal.tsx`, `components/wallet/BasketAccessModal.tsx`, `components/wallet/ProtocolAccessModal.tsx`

These three predate `PermissionSheet`. Do NOT restructure their data flow — restyle only:

- [ ] **Step 1:** For each modal, read the file first, then apply: replace bottom `TouchableOpacity` deny/allow buttons with the PermissionSheet pattern (deny = hairline-bordered neutral with `colors.textSecondary` text; allow = solid fill using the modal's permission color — `colors.permissionSpending` for spending, `colors.permissionBasket` for basket, `colors.permissionProtocol` for protocol — falling back to `colors.accent` if contrast fails) on `PressableScale`, `flex: 1`, row with `gap: spacing.md`, `minHeight: 44`. Wire `haptics.confirm()` on allow, `haptics.warning()` on deny. Keep `AmountDisplay` and all existing content/logic.
- [ ] **Step 2:** Verify each file: `npx tsc --noEmit && npm run lint`. One commit per file: `style: align <X>Modal buttons with permission sheet language`.

---

### Task 13: WebView native props

**Files:**
- Modify: `app/index.tsx` (WebView element, lines ~281-482; `allowsBackForwardNavigationGestures` already present at line ~475)

- [ ] **Step 1:** Add to the WebView props, next to `allowsBackForwardNavigationGestures`:

```tsx
pullToRefreshEnabled
allowsLinkPreview
```

- [ ] **Step 2:** Verify `npx tsc --noEmit`. On device: pull down a page → native refresh control; long-press a link → preview. Confirm pull-to-refresh does not fight vertical scrolling on pages with their own overscroll behavior — if it does on test sites, note it; do NOT silently remove the prop.
- [ ] **Step 3:** Commit `feat: enable pull-to-refresh and link previews in WebView`.

---

### Task 14: Page-load progress bar

**Files:**
- Modify: `app/index.tsx` (WebViewHost + chrome area)
- Create: `components/browser/LoadProgressBar.tsx`

- [ ] **Step 1: Create `components/browser/LoadProgressBar.tsx`**

```tsx
/**
 * 2px page-load progress line under the address bar. Driven by a Reanimated
 * shared value (0..1) owned by the parent; renders nothing when idle.
 * Eases ahead so it never appears stalled; snaps to 1 then fades on finish.
 */
import React from 'react'
import { StyleSheet } from 'react-native'
import Animated, { useAnimatedStyle, SharedValue } from 'react-native-reanimated'
import { useTheme } from '@/context/theme/ThemeContext'

interface Props {
  /** 0..1 load progress; set to 0 when idle, 1 triggers fade-out. */
  progress: SharedValue<number>
}

export default function LoadProgressBar({ progress }: Props) {
  const { colors } = useTheme()
  const style = useAnimatedStyle(() => ({
    width: `${Math.min(progress.value, 1) * 100}%`,
    opacity: progress.value > 0 && progress.value < 1 ? 1 : 0,
  }))
  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.bar, { backgroundColor: colors.info }, style]}
    />
  )
}

const styles = StyleSheet.create({
  bar: { position: 'absolute', bottom: 0, left: 0, height: 2, borderRadius: 1 },
})
```

- [ ] **Step 2: Wire in `app/index.tsx`** — create one `useSharedValue(0)` for the active tab's load progress near the existing address-bar state. On the WebView add `onLoadProgress={({ nativeEvent }) => { if (isActive) loadProgress.value = withTiming(Math.max(nativeEvent.progress * 0.9, loadProgress.value), { duration: durations.quick }) }}` (never move backward; cap at 0.9 until done). On `onLoadEnd` (or existing nav-state load-complete handling): `loadProgress.value = withTiming(1, { duration: durations.instant })` then after 300ms reset to 0 via `withDelay`. On `stopLoading` cancel path (existing convention clears `isLoading` manually) also reset to 0. Render `<LoadProgressBar progress={loadProgress} />` inside the address-bar container view (it positions itself at the container's bottom edge).

Throttling: `onLoadProgress` fires sparsely from WKWebView; it is not a per-frame JS flood. Do NOT add console logging here (prior incident: per-render logging caused measurable hangs).

- [ ] **Step 3:** Verify `npx tsc --noEmit && npm run lint`. Device: load a slow page — line eases forward, completes, fades; cancel mid-load — line clears.
- [ ] **Step 4:** Commit `feat: page-load progress line under address bar`.

---

### Task 15: Tab-switch crossfade

**Files:**
- Modify: `app/index.tsx` (WebViewHost container, lines ~247-265)

Current: instant `opacity: isActive ? 1 : 0` style. Animate ONLY this value — pointerEvents and zIndex stay instant (interaction correctness).

- [ ] **Step 1:** In `WebViewHost`, add:

```tsx
const activeOpacity = useSharedValue(isActive ? 1 : 0)
useEffect(() => {
  activeOpacity.value = withTiming(isActive ? 1 : 0, { duration: 200 })
}, [isActive, activeOpacity])
const fadeStyle = useAnimatedStyle(() => ({ opacity: activeOpacity.value }))
```

Convert the container `View` to `Animated.View`, remove `opacity` from the inline style object, append `fadeStyle` to the style array. Keep `collapsable={false}`, `pointerEvents={isActive ? 'auto' : 'none'}`, and `zIndex: isActive ? 1 : 0` exactly as-is.

**Constraint check:** WebView containers hold no LiquidGlass content — fractional opacity is safe here. Do not extend this fade to any chrome element.

- [ ] **Step 2:** Verify `npx tsc --noEmit`. Device: switch tabs rapidly — crossfade, no white flash, no input bleed-through to the outgoing tab, switching still feels instant (200ms overlap, not delay).
- [ ] **Step 3:** Commit `feat: 200ms crossfade on warm-pool tab switch`.

---

### Task 16: TabsOverview entrance stagger + new-tab feel

**Files:**
- Modify: `components/browser/TabsOverview.tsx`

- [ ] **Step 1:** Wrap each tab card in `Animated.View` with `entering={FadeInDown.duration(durations.quick).delay(Math.min(index * 20, 160)).springify().stiffness(springs.settle.stiffness).damping(springs.settle.damping)}` (Reanimated entering animation — UI thread). Cap total stagger at 160ms. Gate behind `!useReducedMotion()` (pass `undefined` when reduced).
- [ ] **Step 2:** New-tab button: `haptics.confirm()` on press (keep existing creation logic). Tab-select taps: `haptics.tap()`.
- [ ] **Step 3:** Verify typecheck/lint; device: open tab grid — cards cascade in under 400ms total; reduced-motion setting kills stagger.
- [ ] **Step 4:** Commit `feat: staggered entrance and haptics in tabs overview`.

---

### Task 17: Celebration wiring (exactly three moments)

**Files:**
- Modify: `app/payments.tsx` (first-payment-sent), `app/auth/mnemonic.tsx` (wallet created), `app/auth/scan-shares.tsx` or the backup-verified success path (locate via existing `haptics.success()` call from Task 3)
- Uses: AsyncStorage flag for "first payment ever"

- [ ] **Step 1:** In `app/payments.tsx`, find the payment-success state (status indicator per UI map). Add module-level key `const FIRST_PAYMENT_KEY = 'hasSentFirstPayment'`. On success: read flag; if unset, render `<Celebration onDone={...} />` in the success state UI and set the flag; else render the existing quiet success indicator (with `haptics.success()` already firing via Toast or directly — ensure exactly ONE success haptic fires per payment, not two).
- [ ] **Step 2:** In `app/auth/mnemonic.tsx`, in the flow completion (after wallet setup succeeds, before navigation), show `<Celebration />` for 700ms via its `onDone` callback, then navigate as before.
- [ ] **Step 3:** Backup verified: in `app/auth/scan-shares.tsx` where `haptics.success()` fires on successful share scan completion (all shares collected — not each scan), replace the bare success UI with `<Celebration onDone={...} />` once per completion.
- [ ] **Step 4:** Verify typecheck/lint/jest; device-test each moment. Commit `feat: celebration moments — first payment, wallet created, backup verified`.

---

### Task 18: PermissionSheet approve morph + haptics

**Files:**
- Modify: `components/ui/PermissionSheet.tsx` (buttons at lines ~571-587)

- [ ] **Step 1:** Replace the two `TouchableOpacity` buttons with `PressableScale` (same styles). On deny: `haptics.warning()` then existing deny logic. On allow: `haptics.success()`, set local state `granted=true`, render an Ionicons `checkmark` (white, 22pt) in place of the allow label, then call the existing grant handler after 400ms (`setTimeout`), letting the sheet dismiss as it already does. Guard against double-tap (`disabled={granted}` on both buttons once granted).
- [ ] **Step 2:** Verify typecheck/lint. Device: trigger a protocol permission from a BSV site — button morphs to check, sheet leaves 400ms later, one success haptic.
- [ ] **Step 3:** Commit `feat: approve morph and haptics in PermissionSheet`.

---

### Task 19: Payments screen polish

**Files:**
- Modify: `app/payments.tsx`, `components/wallet/AmountInput.tsx`

Read both files before editing. Apply, preserving ALL payment logic:

- [ ] **Step 1: Amount display** — promote the primary amount text to `typography.largeTitle` + `fontVariant: ['tabular-nums']`. Secondary (converted currency) line: `typography.title3`, `colors.textSecondary`.
- [ ] **Step 2: Currency toggle** — wrap the sats↔fiat toggle in `PressableScale haptic="tap"`; animate the swap with Reanimated `entering={FadeInUp.duration(durations.instant)}` / `exiting={FadeOutDown.duration(durations.instant)}` keyed on the active unit.
- [ ] **Step 3: Identity resolution result** — when a resolved identity renders (avatar + name), wrap in `Animated.View entering={FadeInDown.springify().stiffness(380).damping(36)}`.
- [ ] **Step 4: Send button state morph** — single button container with fixed height; contents switch idle label → `ActivityIndicator` → Ionicons checkmark, each wrapped in `Animated.View` with `entering={FadeIn.duration(durations.instant)}` `exiting={FadeOut.duration(durations.instant)}`. No layout jumps (fixed width/height container). `haptics.confirm()` on press; success haptic handled by Task 17 logic.
- [ ] **Step 5:** Verify typecheck/lint; device: full payment flow including failure path (`haptics.error()` + error Toast). Commit `feat: payments screen motion and type hierarchy polish`.

---

### Task 20: Onboarding polish — mnemonic screen

**Files:**
- Modify: `app/auth/mnemonic.tsx`

Read the file first. Presentation only — zero flow/logic changes:

- [ ] **Step 1:** Screen title to `typography.largeTitle` with `spacing.xl` top margin; section subtitles `typography.subhead` in `colors.textSecondary`.
- [ ] **Step 2:** Mnemonic words: numbered chips in a 2-column grid — each chip: `flexDirection: 'row'`, number in `colors.textTertiary` `typography.footnote` + word in `typography.callout`, background `colors.fillTertiary`, `borderRadius: radii.md`, padding `spacing.sm`/`spacing.md`, `gap: spacing.sm`; grid uses `flexWrap` with `width: '48%'` chips and `gap: spacing.sm`.
- [ ] **Step 3:** Copy action → `showToast(t('copied') /* or literal 'Copied' if no key */, { type: 'success' })` instead of any Alert/silent copy.
- [ ] **Step 4:** Biometric step: add Ionicons `finger-print` (or `lock-closed`) 32pt icon above the explanation; one-line explanation in `typography.footnote` `colors.textSecondary`.
- [ ] **Step 5:** All primary CTAs (`generate`, `import`, `continue`): `PressableScale` with `haptic="confirm"`, solid `colors.accent` background, `colors.textOnAccent` text, `minHeight: 50`, `borderRadius: radii.lg`.
- [ ] **Step 6:** Verify typecheck/lint; device: walk all three modes (choose/generate/import) in dark + light. Commit `style: onboarding mnemonic screen polish`.

---

### Task 21: Web3BenefitsModal alignment

**Files:**
- Modify: `components/onboarding/Web3BenefitsModal.tsx`

- [ ] **Step 1:** Read file. Align to token language: background `colors.sheetBackground`, radius `radii.xl`, typography scale per tokens, buttons → `PressableScale` (primary solid accent, secondary hairline border), spacing grid from `spacing.*`. If it uses a plain `Modal`, mount content in `Sheet fitContent` instead, keeping trigger logic in `Web3BenefitsModalHandler` untouched.
- [ ] **Step 2:** Verify typecheck/lint; device check. Commit `style: align Web3 benefits modal with design tokens`.

---

### Task 22: Address bar focus transition + suggestions spring

**Files:**
- Modify: `components/browser/AddressBar.tsx`, `components/browser/SuggestionsDropdown.tsx`

- [ ] **Step 1:** Read both files. In AddressBar: the domain-display ↔ full-URL/TextInput swap on focus gets a crossfade — both states wrapped in `Animated.View` with `FadeIn/FadeOut` at `durations.instant`. Lock-icon changes likewise `FadeIn.duration(durations.instant)`. Do NOT touch the existing `useAddressBarAnimation` hook's layout behavior or focus-cancel guard convention.
- [ ] **Step 2:** SuggestionsDropdown: container gets `entering={FadeInDown.duration(durations.quick).springify().stiffness(springs.settle.stiffness).damping(springs.settle.damping)}`, `exiting={FadeOut.duration(durations.instant)}`.
- [ ] **Step 3:** Verify typecheck/lint; device: focus/blur address bar repeatedly fast — no stuck states, suggestions spring in, cancel-during-load still works (load-cancel convention). Commit `feat: address bar focus crossfade and suggestion spring`.

---

### Task 23: Haptics adoption sweep (remaining sites)

**Files:** `app/index.tsx` (tab select), `app/trust.tsx` (drag reorder), `components/browser/BookmarkList.tsx` + `components/browser/HistoryList.tsx` (swipe-delete commit), `app/settings.tsx` + `app/wallet-config.tsx` (toggles/segmented controls), `components/QRScanner.tsx` (scan success)

- [ ] **Step 1:** Add via `useHaptics()`/`haptics`: tab select in chrome → `tap`; segmented control changes → `tap`; toggle commits → `confirm`; swipe-to-delete action triggered → `warning`; QR scan recognized → `success`; trust.tsx drag pickup → `tap`, drop → `confirm`. Skip any site already covered by PressableScale's `haptic` prop — no double-firing (audit each: one haptic per user action).
- [ ] **Step 2:** Verify typecheck/lint/jest. Commit `feat: semantic haptics across chrome and settings`.

---

### Task 24: Final verification pass

- [ ] **Step 1:** Full suite: `npx tsc --noEmit && npm run lint && npx jest` — all clean.
- [ ] **Step 2:** `grep -rn "Alert.alert\|react-toastify" app components context utils services --include="*.ts*"` → zero matches. `grep -rn "TouchableOpacity" components/ui --include="*.tsx"` → only non-interactive/legacy leftovers consciously kept (list them in the commit message if any).
- [ ] **Step 3:** Device checklist (manual, simulator insufficient for haptics):
  - Dark + light: AlertCard, Toast, PermissionModal, wallet modals, mnemonic, payments
  - Reduced Motion ON (Settings → Accessibility): springs become fades, Celebration static, no broken states
  - Perf: with profiling toolchain, confirm no new >100ms JS blocks on: tab switch, alert open, toast, payment flow
  - LiquidGlass surfaces (MenuPopover, GlassPill, HistoryPopover): verify no stuck UIVisualEffectView after sweeps
- [ ] **Step 4:** Commit any checklist fixes individually; then `git log --oneline` review of the whole branch.

---

## Self-Review Notes

- Spec coverage: Part 1 → Tasks 2-3; Part 2 → Tasks 4, 6, 7, 8; Part 3 → Tasks 5, 9, 10, 11, 12, 23; Part 4 → Tasks 13, 14, 15, 16, 22 (scroll-collapse correctly absent — cut by owner); Part 5 → Tasks 17, 18, 19, 20, 21; Part 6 → Tasks 1, 24 + reduced-motion built into every primitive.
- `allowsBackForwardNavigationGestures` was in the spec's "verify not already set" list — verified already present (`app/index.tsx:475`), so Task 13 only adds the two genuinely missing props.
- Tab-count badge "numeric roll" from spec Part 4 dropped deliberately: badge is in IconButton; a roll animation there is low-value vs. risk in perf-critical chrome. Noted as conscious scope trim.
- New-tab zoom-from-+ (spec Part 4) trimmed to + button with confirm haptic wired through canonical new-tab flow.
- Wallet-created identicon spring (spec Part 5) trimmed: Celebration checkmark only.
- Send button terminal check state (plan Task 19) trimmed: success surfaces via ResultBanner/Celebration instead of in-button checkmark.
- Address-bar focus crossfade (spec Part 4) reverted post-device-test: any fractional-alpha animation inside a LiquidGlassView subtree (even on children) sticks UIVisualEffectView transparent. Instant swap is the glass-safe behavior. See commit 8b112a8.
- Type consistency: `showAlert(options): Promise<string>`, `showToast(message, { type })`, `haptics.<semantic>()`, `springs.snappy/settle`, `durations.instant/quick/moderate` used uniformly across tasks.
