import React from 'react'
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native'
import { useThemeStyles } from '../../context/theme/useThemeStyles'

interface AppChipProps {
  label: string
  showDomain?: boolean
  size?: number
  clickable?: boolean
  onPress?: () => void
}

const AppChip: React.FC<AppChipProps> = ({ label, showDomain = false, size = 1, clickable = true, onPress }) => {
  const themeStyles = useThemeStyles()
  const displayText = showDomain ? label : label.split('/')[0]

  const ChipContainer = clickable ? TouchableOpacity : View

  return (
    <ChipContainer
      style={[styles.container, themeStyles.card, { height: 32 * size }]}
      onPress={clickable ? onPress : undefined}
    >
      <Text style={[styles.text, themeStyles.text, { fontSize: 14 * size }]} numberOfLines={1}>
        {displayText}
      </Text>
    </ChipContainer>
  )
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    borderRadius: 16,
    borderWidth: 1,
    marginVertical: 4
  },
  text: {
    fontWeight: '500'
  }
})

export default AppChip
