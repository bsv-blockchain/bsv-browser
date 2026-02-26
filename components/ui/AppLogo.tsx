import React, { useEffect, useRef } from 'react'
import { View, StyleSheet, Animated, Easing } from 'react-native'
import { useTheme } from '@/context/theme/ThemeContext'

interface AppLogoProps {
  size?: number
  color?: string
  rotate?: boolean
}

const AppLogo: React.FC<AppLogoProps> = ({ size = 150, color = '#2196F3', rotate = true }) => {
  // Get theme colors if no specific color is provided
  const { colors } = useTheme()
  const logoColor = color || colors.primary

  // Animation for rotation
  const rotateAnim = useRef(new Animated.Value(0)).current

  useEffect(() => {
    if (rotate) {
      Animated.loop(
        Animated.timing(rotateAnim, {
          toValue: 1,
          duration: 10000,
          easing: Easing.linear,
          useNativeDriver: true
        })
      ).start()
    }

    return () => {
      rotateAnim.stopAnimation()
    }
  }, [rotate, rotateAnim])

  // Calculate positions for 8 vertices on a circle
  const centerX = size / 2
  const centerY = size / 2
  const radius = size * 0.4
  const dot = size * (8 / 150)
  const vertices = []

  // Create 8 vertices positioned in a circle
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * 2 * Math.PI
    vertices.push({
      x: centerX + radius * Math.cos(angle),
      y: centerY + radius * Math.sin(angle)
    })
  }

  // Create connections between vertices with a specific pattern
  const connections = []
  for (let i = 0; i < vertices.length; i++) {
    // Determine how many connections this vertex should have
    // Every second vertex will connect to 6 others instead of 7
    const skipVertexIndex = i % 2 === 0 ? (i + 4) % 8 : -1 // Skip the opposite vertex for even-indexed vertices

    for (let j = 0; j < vertices.length; j++) {
      // Don't connect vertex to itself and apply the skipping pattern
      if (i !== j && j !== skipVertexIndex) {
        // Avoid duplicate connections (only add if i < j)
        if (i < j) {
          connections.push({
            startX: vertices[i].x,
            startY: vertices[i].y,
            endX: vertices[j].x,
            endY: vertices[j].y
          })
        }
      }
    }
  }

  const spin = rotateAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg']
  })

  return (
    <Animated.View
      style={[
        styles.container,
        {
          width: size,
          height: size,
          transform: rotate ? [{ rotate: spin }] : []
        }
      ]}
    >
      {/* No background circle */}

      {/* Connections between vertices */}
      {connections.map((connection, index) => {
        // Calculate line properties
        const dx = connection.endX - connection.startX
        const dy = connection.endY - connection.startY
        const length = Math.sqrt(dx * dx + dy * dy)
        const angle = Math.atan2(dy, dx) * (180 / Math.PI)

        return (
          <View
            key={`line-${index}`}
            style={[
              styles.line,
              {
                width: length,
                left: connection.startX,
                top: connection.startY,
                transform: [{ rotate: `${angle}deg` }],
                backgroundColor: logoColor,
                opacity: 0.6
              }
            ]}
          />
        )
      })}

      {/* Vertices (circles) */}
      {vertices.map((vertex, index) => (
        <View
          key={`vertex-${index}`}
          style={[
            styles.vertex,
            {
              width: dot,
              height: dot,
              borderRadius: dot / 2,
              left: vertex.x - dot / 2,
              top: vertex.y - dot / 2,
              backgroundColor: logoColor
            }
          ]}
        />
      ))}

      {/* No center dot */}
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  container: {
    position: 'relative'
  },
  backgroundCircle: {
    position: 'absolute',
    backgroundColor: 'transparent'
  },
  line: {
    position: 'absolute',
    height: 1,
    transformOrigin: 'left'
  },
  vertex: {
    position: 'absolute'
  },
  centerDot: {
    position: 'absolute',
    width: 16,
    height: 16,
    borderRadius: 8
  }
})

export default AppLogo
