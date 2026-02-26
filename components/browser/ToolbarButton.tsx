import React from 'react'
import { Text, TouchableOpacity, StyleSheet } from 'react-native'

interface ToolbarButtonProps {
  icon: string
  onPress: () => void
  disabled?: boolean
  color: string
}

export const ToolbarButton = ({ icon, onPress, disabled, color }: ToolbarButtonProps) => (
  <TouchableOpacity style={styles.toolbarButton} onPress={onPress} disabled={disabled}>
    <Text style={[styles.toolbarIcon, { color }, disabled && { opacity: 0.3 }]}>{icon}</Text>
  </TouchableOpacity>
)

const styles = StyleSheet.create({
  toolbarButton: { padding: 6 },
  toolbarIcon: { fontSize: 20 }
})
