import { useEffect, useRef, useState } from 'react'
import { Dimensions, Keyboard, Platform, TextInput } from 'react-native'
import { Gesture } from 'react-native-gesture-handler'
import { useSharedValue, useAnimatedStyle, withSpring } from 'react-native-reanimated'
import type { EdgeInsets } from 'react-native-safe-area-context'

export function useAddressBarAnimation(
  insets: EdgeInsets,
  addressFocused: boolean,
  addressEditing: React.RefObject<boolean>,
  addressInputRef: React.RefObject<TextInput | null>,
  setAddressFocused: (v: boolean) => void,
  setAddressSuggestions: (v: any[]) => void
) {
  // Keyboard state
  const [keyboardVisible, setKeyboardVisible] = useState(false)
  const iosSoftKeyboardShown = useRef(false)
  const keyboardHeight = useSharedValue(0)

  // AddressBar position animation — start at bottom (translateY = travelDistance)
  const addressBarAtTop = useSharedValue(false)
  const ADDRESS_BAR_HEIGHT = 60 // paddingTop(4) + pill(44) + paddingBottom(12)
  const computeTravelDistance = (top: number, bottom: number) => {
    const screenHeight = Dimensions.get('window').height
    return screenHeight - (2 * top) - 12
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
        damping: 38,
      })
      addressBarAtTop.value = false
    } else {
      if (addressBarWasAtTopBeforeFocus.current) {
        addressBarTranslateY.value = withSpring(0, {
          mass: 1,
          stiffness: 400,
          damping: 38,
        })
        addressBarAtTop.value = true
      } else {
        addressBarTranslateY.value = withSpring(travelDistance, {
          mass: 1,
          stiffness: 400,
          damping: 38,
        })
        addressBarAtTop.value = false
      }
    }
  }, [addressFocused])

  // Pan gesture for AddressBar
  const addressBarPanGesture = Gesture.Pan()
    .activeOffsetY([-10, 10])
    .failOffsetX([-25, 25])
    .onUpdate((e) => {
      const travelDistance = addressBarTravelDistance.value
      if (addressBarAtTop.value) {
        addressBarTranslateY.value = Math.max(0, Math.min(travelDistance, e.translationY))
      } else {
        addressBarTranslateY.value = Math.max(0, Math.min(travelDistance, travelDistance + e.translationY))
      }
    })
    .onEnd((e) => {
      const travelDistance = addressBarTravelDistance.value
      const threshold = travelDistance / 3
      const shouldMoveToTop = !addressBarAtTop.value && (Math.abs(e.translationY) > threshold || e.velocityY < -800)
      const shouldMoveToBottom = addressBarAtTop.value && (e.translationY > threshold || e.velocityY > 800)

      if (shouldMoveToTop) {
        addressBarTranslateY.value = withSpring(0, {
          mass: 1,
          stiffness: 400,
          damping: 38,
          velocity: e.velocityY,
        })
        addressBarAtTop.value = true
      } else if (shouldMoveToBottom) {
        addressBarTranslateY.value = withSpring(travelDistance, {
          mass: 1,
          stiffness: 400,
          damping: 38,
          velocity: e.velocityY,
        })
        addressBarAtTop.value = false
      } else if (addressBarAtTop.value) {
        addressBarTranslateY.value = withSpring(0, { mass: 1, stiffness: 400, damping: 38 })
      } else {
        addressBarTranslateY.value = withSpring(travelDistance, { mass: 1, stiffness: 400, damping: 38 })
      }
    })

  // Animated style for AddressBar wrapper
  const animatedAddressBarStyle = useAnimatedStyle(() => {
    const keyboardOffset = addressBarAtTop.value ? 0 : -keyboardHeight.value
    return {
      transform: [{ translateY: addressBarTranslateY.value + keyboardOffset }],
    }
  })

  // Animated style for MenuPopover
  const animatedMenuPopoverStyle = useAnimatedStyle(() => {
    const travelDistance = addressBarTravelDistance.value
    const menuPopoverHeight = 332

    const progress = 1 - (addressBarTranslateY.value / travelDistance)
    const menuTranslateY = -(travelDistance - addressBarTranslateY.value) + (menuPopoverHeight * progress)

    return {
      transform: [{ translateY: menuTranslateY }],
    }
  })

  // Keyboard show/hide listeners
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow'
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide'

    const showSub = Keyboard.addListener(showEvent, (e) => {
      setKeyboardVisible(true)
      if (Platform.OS === 'ios') iosSoftKeyboardShown.current = true
      keyboardHeight.value = withSpring(e.endCoordinates.height, {
        mass: 1,
        stiffness: 400,
        damping: 38,
      })
    })
    const hideSub = Keyboard.addListener(hideEvent, () => {
      setKeyboardVisible(false)
      keyboardHeight.value = withSpring(0, {
        mass: 1,
        stiffness: 400,
        damping: 38,
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
  }
}
