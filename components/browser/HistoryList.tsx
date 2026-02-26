import React from 'react'
import { FlatList, Pressable, Text, TouchableOpacity, View, StyleSheet } from 'react-native'
import { Swipeable } from 'react-native-gesture-handler'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from '@/context/theme/ThemeContext'

export interface HistoryEntry {
  title: string
  url: string
  timestamp: number
}

interface Props {
  history: HistoryEntry[]
  onSelect: (url: string) => void
  onDelete: (url: string) => void
  onClear: () => void
}

export const HistoryList = ({ history, onSelect, onDelete, onClear }: Props) => {
  const { colors } = useTheme()

  const renderItem = ({ item }: { item: HistoryEntry }) => (
    <Swipeable
      overshootRight={false}
      renderRightActions={() => (
        <View style={[styles.swipeDelete, { backgroundColor: colors.error }]}>
          <Ionicons name="trash-outline" size={20} color="#fff" />
        </View>
      )}
      onSwipeableRightOpen={() => onDelete(item.url)}
    >
      <Pressable style={styles.historyItem} onPress={() => onSelect(item.url)}>
        <Text numberOfLines={1} style={{ color: colors.textPrimary, fontSize: 15 }}>
          {item.title}
        </Text>
        <Text numberOfLines={1} style={{ color: colors.textSecondary, fontSize: 12 }}>
          {item.url}
        </Text>
      </Pressable>
    </Swipeable>
  )

  return (
    <View style={styles.container}>
      <TouchableOpacity style={[styles.clearBtn, { backgroundColor: colors.error }]} onPress={onClear}>
        <Ionicons name="trash-outline" size={18} color="#fff" />
        <Text style={styles.clearBtnText}>Clear History</Text>
      </TouchableOpacity>
      <FlatList
        data={history}
        keyExtractor={i => i.url + i.timestamp}
        renderItem={renderItem}
        ListFooterComponent={<View style={{ height: 80 }} />}
        scrollEnabled={true}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    height: '58%'
  },
  historyItem: { padding: 12 },
  clearBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 8,
    marginBottom: 12,
    gap: 8
  },
  clearBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600'
  },
  swipeDelete: {
    justifyContent: 'center',
    alignItems: 'center',
    width: 60,
    marginVertical: 10,
    borderRadius: 10
  },
  swipeDeleteText: { color: '#fff', fontSize: 24 }
})
