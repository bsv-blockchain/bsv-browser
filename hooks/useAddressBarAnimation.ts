import { useEffect, useRef, useState } from 'react'
import { Dimensions, Keyboard, Platform, TextInput } from 'react-native'
import { Gesture } from 'react-native-gesture-handler'
import { useSharedValue, useAnimatedStyle, withSpring, withTiming, useAnimatedReaction, runOnJS, Easing } from 'react-native-reanimated'
import type { EdgeInsets } from 'react-native-safe-area-context'
import { safeBottomInset, ADDRESS_BAR_HEIGHT } from '@/shared/constants'

export function useAddressBarAnimation(
  insets: EdgeInsets,
  addressFocused: boolean,
  addressEditing: React.RefObject<boolean>,
  addressInputRef: React.RefObject<TextInput | null>,
  setAddressFocused: (v: boolean) => void,
  setAddressSuggestions: (v: any[]) => void,
  // Fires IMMEDIATELY when the right-swipe collapse gesture activates, so the
  // parent can flip its JS "collapsed" state right away (mounting the dot,
  // which then fades in via the shared collapse-progress value while the bar
  // simultaneously fades out — both on the UI thread, perfectly synchronized).
  onRequestCollapse: () => void = () => {},
  // Fires AFTER the collapse exit animation finishes (progress reached 1),
  // so the parent can unmount the bar wrapper that was kept rendered during
  // the exit. Lets the bar's fade/scale finish on the UI thread before the
  // JS-thread unmount.
  onCollapseAnimationEnd: () => void = () => {}
) {
  // Keyboard state
  const [keyboardVisible, setKeyboardVisible] = useState(false)
  const iosSoftKeyboardShown = useRef(false)
  const keyboardHeight = useSharedValue(0)

  // AddressBar position animation — start at bottom (translateY = travelDistance)
  const addressBarAtTop = useSharedValue(false)
  // React-state mirror of addressBarAtTop for prop-driven components (e.g. MenuPopover)
  const [addressBarIsAtTop, setAddressBarIsAtTop] = useState(false)

  const computeTravelDistance = (top: number, bottom: number) => {
    const screenHeight = Dimensions.get('window').height
    return screenHeight - top - safeBottomInset(bottom) - ADDRESS_BAR_HEIGHT
  }
  const initialTravelDistance = computeTravelDistance(insets.top, insets.bottom)
  const addressBarTravelDistance = useSharedValue(initialTravelDistance)
  const addressBarTranslateY = useSharedValue(initialTravelDistance)
  // Track position before focus to restore it later
  const addressBarWasAtTopBeforeFocus = useRef(false)

  // Update travel distance and position when insets change
  useEffect(() => {
    const travelDistance = computeTravelDistance(insets.top, insets.bottom)
    addressBarTravelDistance.value = travelDistance
    if (addressBarAtTop.value) {
      addressBarTranslateY.value = 0
    } else {
      addressBarTranslateY.value = travelDistance
    }
  }, [insets.bottom, insets.top])

  // Move address bar to bottom when focused, restore position when unfocused
  useEffect(() => {
    const travelDistance = addressBarTravelDistance.value
    if (addressFocused) {
      addressBarWasAtTopBeforeFocus.current = addressBarAtTop.value
      addressBarTranslateY.value = withSpring(travelDistance, {
        mass: 1,
        stiffness: 400,
        damping: 38
      })
      addressBarAtTop.value = false
    } else {
      if (addressBarWasAtTopBeforeFocus.current) {
        addressBarTranslateY.value = withSpring(0, {
          mass: 1,
          stiffness: 400,
          damping: 38
        })
        addressBarAtTop.value = true
      } else {
        addressBarTranslateY.value = withSpring(travelDistance, {
          mass: 1,
          stiffness: 400,
          damping: 38
        })
        addressBarAtTop.value = false
      }
    }
  }, [addressFocused])

  // Single-fire guard so onUpdate doesn't spam runOnJS(onRequestCollapse) every frame
  const collapseFired = useSharedValue(false)

  // Collapse animation progress (0 = bar fully visible, 1 = dot fully visible).
  // Driven on the UI thread; both the bar's exit-style and the dot's entrance-
  // style read this single shared value so the cross-fade/morph is perfectly
  // synchronized with zero per-frame JS work. The parent flips its JS
  // "collapsed" state immediately at gesture activation (via onRequestCollapse)
  // and unmounts the now-invisible bar wrapper at animation end (via
  // onCollapseAnimationEnd).
  const addressBarCollapseProgress = useSharedValue(0)

  // Reset gesture/animation state to a known-good idle position.
  // Called when expanding the address bar after a collapse so the bar always
  // returns to a sane translateY and the collapse-guard can fire again, even
  // if onFinalize didn't run (e.g. the GestureDetector unmounted mid-gesture).
  //
  // Note: this resets translateY/collapseFired/progress all back to "fully
  // visible bar" defaults. It must NOT be called mid-collapse-animation, or
  // it will fight the in-flight withTiming(progress, 1). The parent should
  // only call this on expand (or before initiating a fresh collapse cycle).
  const resetGestureState = () => {
    const travelDistance = addressBarTravelDistance.value
    if (addressBarAtTop.value) {
      addressBarTranslateY.value = withSpring(0, { mass: 1, stiffness: 400, damping: 38 })
    } else {
      addressBarTranslateY.value = withSpring(travelDistance, { mass: 1, stiffness: 400, damping: 38 })
    }
    collapseFired.value = false
    addressBarCollapseProgress.value = 0
  }

  // Vertical pan — moves bar between top and bottom.
  // failOffsetX ensures horizontal motion past 20px hands gesture off to horizontalPan.
  const verticalPan = Gesture.Pan()
    .activeOffsetY([-10, 10])
    .failOffsetX([-20, 20])
    .onUpdate(e => {
      const travelDistance = addressBarTravelDistance.value
      if (addressBarAtTop.value) {
        addressBarTranslateY.value = Math.max(0, Math.min(travelDistance, e.translationY))
      } else {
        addressBarTranslateY.value = Math.max(0, Math.min(travelDistance, travelDistance + e.translationY))
      }
    })
    .onEnd(e => {
      const travelDistance = addressBarTravelDistance.value
      const threshold = travelDistance / 3

      const shouldMoveToTop = !addressBarAtTop.value &&
        (Math.abs(e.translationY) > threshold || e.velocityY < -800)
      const shouldMoveToBottom = addressBarAtTop.value &&
        (e.translationY > threshold || e.velocityY > 800)

      if (shouldMoveToTop) {
        addressBarTranslateY.value = withSpring(0, {
          mass: 1, stiffness: 400, damping: 38, velocity: e.velocityY
        })
        addressBarAtTop.value = true
      } else if (shouldMoveToBottom) {
        addressBarTranslateY.value = withSpring(travelDistance, {
          mass: 1, stiffness: 400, damping: 38, velocity: e.velocityY
        })
        addressBarAtTop.value = false
      } else if (addressBarAtTop.value) {
        addressBarTranslateY.value = withSpring(0, { mass: 1, stiffness: 400, damping: 38 })
      } else {
        addressBarTranslateY.value = withSpring(travelDistance, { mass: 1, stiffness: 400, damping: 38 })
      }
    })

  // Horizontal pan — rightward swipe collapses the bar (only when at bottom).
  // activeOffsetX(20) requires 20px rightward before activation.
  // failOffsetY([-15,15]) hands off to verticalPan if Y moves first.
  //
  // PERF: When the threshold is hit we drive the collapse animation entirely
  // on the UI thread (withTiming on addressBarCollapseProgress). The dot's
  // entrance and the bar's exit BOTH read this single shared value, so they
  // morph together with zero per-frame JS work.
  //
  // Lifecycle:
  //   1. Threshold crossed → runOnJS(onRequestCollapse) fires IMMEDIATELY so
  //      the parent flips its JS "collapsed" state. This mounts the dot
  //      (which starts at opacity 0 because progress is still ~0) and the
  //      parent also keeps the bar wrapper mounted in a "exit animating"
  //      mode so the bar's fade-out can play.
  //   2. withTiming(progress, 1) runs on the UI thread — both styles morph.
  //   3. On finish → runOnJS(onCollapseAnimationEnd) lets the parent unmount
  //      the now-invisible bar wrapper.
  const horizontalPan = Gesture.Pan()
    .activeOffsetX(20)
    .failOffsetY([-15, 15])
    .onUpdate(e => {
      if (collapseFired.value) return
      if (addressBarAtTop.value) return
      if (e.translationX > 30) {
        collapseFired.value = true
        // Flip JS state right away so the dot mounts and can fade in alongside
        // the bar's fade out (both driven by the same shared progress).
        runOnJS(onRequestCollapse)()
        addressBarCollapseProgress.value = withTiming(
          1,
          { duration: 240, easing: Easing.out(Easing.cubic) },
          finished => {
            if (finished) {
              runOnJS(onCollapseAnimationEnd)()
            }
          }
        )
      }
    })
    .onFinalize(() => {
      // Note: do NOT reset collapseFired here — once the collapse animation
      // has started we must wait for it to finish (and the JS state to flip)
      // before allowing another collapse. resetGestureState() clears the
      // guard when the bar is later expanded.
    })

  const addressBarPanGesture = Gesture.Race(horizontalPan, verticalPan)

  // Sync addressBarAtTop SharedValue → React state for prop-driven components
  useAnimatedReaction(
    () => addressBarAtTop.value,
    (current, previous) => {
      if (current !== previous) {
        runOnJS(setAddressBarIsAtTop)(current)
      }
    }
  )

  // Animated style for AddressBar wrapper.
  //
  // While addressBarCollapseProgress animates 0 → 1 (UI thread), the bar
  // *morphs* toward the dot's anchor (bottom-right): a moderate rightward
  // translation paired with a strong scale-down + early opacity fade so the
  // bar is already invisible by the time the dot becomes fully visible.
  // This replaces the previous "slide fully offscreen, then dot pops in"
  // sequence with a cross-fade/morph driven by a single shared value.
  //
  // Numbers chosen so that:
  //   - bar opacity hits 0 at ~50% of progress (cleared before dot lands)
  //   - bar shrinks to 0.6 of its size (converges toward the 44px dot)
  //   - bar translates ~40px right (toward the dot, not fully off-screen)
  const animatedAddressBarStyle = useAnimatedStyle(() => {
    const keyboardOffset = addressBarAtTop.value ? 0 : -keyboardHeight.value
    const collapse = addressBarCollapseProgress.value
    // Fade-out completes by ~50% of progress, leaving the second half for
    // the dot's entrance to dominate visually.
    const barOpacity = Math.max(0, 1 - collapse * 2)
    return {
      opacity: barOpacity,
      transform: [
        { translateY: addressBarTranslateY.value + keyboardOffset },
        { translateX: collapse * 40 },
        { scale: 1 - collapse * 0.4 }
      ]
    }
  })

  // Animated style for the collapsed "..." dot.
  // Driven by the SAME shared value as the bar's exit so the two are
  // perfectly synchronized on the UI thread (no per-frame runOnJS).
  // The dot stays at opacity 0 until ~40% of progress, then ramps up to 1
  // by progress=1 with a small scale-from-0.7 morph that visually grows out
  // of the shrinking bar's footprint.
  const animatedCollapsedDotStyle = useAnimatedStyle(() => {
    const collapse = addressBarCollapseProgress.value
    // Dot starts appearing after the bar has faded to ~zero.
    // Map progress 0.4 → 1.0  to dot-progress 0 → 1.
    const dotProgress = Math.min(1, Math.max(0, (collapse - 0.4) / 0.6))
    return {
      opacity: dotProgress,
      transform: [
        { scale: 0.7 + dotProgress * 0.3 }
      ]
    }
  })

  // Animated style for MenuPopover wrapper.
  // progress = 0 when bar is at bottom, 1 when at top.
  // translateY slides from 0 (bottom) to insets.top (top) so that:
  //   - bottom position: { bottom: safeBottom } card bottom == bar bottom
  //   - top position:    { top: 0 }            card top    == bar top
  const animatedMenuPopoverStyle = useAnimatedStyle(() => {
    const travelDistance = addressBarTravelDistance.value
    const progress = travelDistance > 0 ? 1 - addressBarTranslateY.value / travelDistance : 0
    return {
      transform: [{ translateY: insets.top * progress }]
    }
  })

  // Keyboard show/hide listeners
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow'
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide'

    const showSub = Keyboard.addListener(showEvent, e => {
      setKeyboardVisible(true)
      if (Platform.OS === 'ios') iosSoftKeyboardShown.current = true
      keyboardHeight.value = withSpring(e.endCoordinates.height, {
        mass: 1,
        stiffness: 400,
        damping: 38
      })
    })
    const hideSub = Keyboard.addListener(hideEvent, () => {
      setKeyboardVisible(false)
      keyboardHeight.value = withSpring(0, {
        mass: 1,
        stiffness: 400,
        damping: 38
      })
      const shouldHandleHide = Platform.OS === 'ios' ? iosSoftKeyboardShown.current : true
      setTimeout(() => {
        if (shouldHandleHide && (addressEditing.current || addressInputRef.current?.isFocused())) {
          addressEditing.current = false
          setAddressFocused(false)
          setAddressSuggestions([])
          addressInputRef.current?.blur()
        }
        if (Platform.OS === 'ios') iosSoftKeyboardShown.current = false
      }, 50)
    })
    return () => {
      showSub.remove()
      hideSub.remove()
    }
  }, [])

  return {
    keyboardVisible,
    addressBarPanGesture,
    animatedAddressBarStyle,
    animatedMenuPopoverStyle,
    animatedCollapsedDotStyle,
    addressBarCollapseProgress,
    addressBarIsAtTop,
    resetGestureState
  }
}
