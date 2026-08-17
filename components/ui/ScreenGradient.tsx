/**
 * A shallow vertical gradient painted behind a screen's content.
 *
 * The whole effect is one step of value between the top of the screen and the
 * rest of it — enough that the balance block reads as sitting in its own light,
 * not enough to be seen as a gradient. Below `height` the view is a flat `to`
 * fill, so the transition is invisible no matter how far the list scrolls.
 *
 * Drawn with react-native-svg rather than stacked translucent Views: stacking
 * bands this close in value produces visible steps on OLED panels.
 */
import React, { useId } from 'react'
import { StyleSheet, View } from 'react-native'
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg'

interface Props {
  /** Colour at the very top of the screen. */
  from: string
  /** Colour everything below `height` is filled with. */
  to: string
  /** How far down the gradient finishes resolving into `to`. */
  height?: number
}

export default function ScreenGradient({ from, to, height = 320 }: Props) {
  // Gradient ids share a document on some renderers, so a fixed id would let two
  // gradients on one screen pick up each other's stops.
  const id = `screen-gradient-${useId()}`
  return (
    <View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { backgroundColor: to }]}
      accessible={false}
      importantForAccessibility="no-hide-descendants"
    >
      <Svg width="100%" height={height}>
        <Defs>
          <LinearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={from} />
            <Stop offset="1" stopColor={to} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${id})`} />
      </Svg>
    </View>
  )
}
