import React, { memo, useCallback, useRef, useState } from 'react'
import { FlatList, Pressable, Text, TouchableOpacity, View, StyleSheet } from 'react-native'
import ReanimatedSwipeable, { SwipeDirection } from 'react-native-gesture-handler/ReanimatedSwipeable'
import { Ionicons } from '@expo/vector-icons'
import { useTranslation } from 'react-i18next'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, typography, radii } from '@/context/theme/tokens'

export interface HistoryEntry {
  title: string
  url: string
  timestamp: number
}

interface Props {
  history: HistoryEntry[]
  onSelect: (url: string) => void
  onDelete: (url: string) => void
  onClear?: () => void
  hideTitle?: boolean
}

/* -------------------------------------------------------------------------- */
/*  Memoised row — prevents FlatList from re-laying-out every cell on render  */
/* -------------------------------------------------------------------------- */

const HistoryRow = memo(
  ({
    item,
    isFirst,
    isLast,
    onSelect,
    onDelete
  }: {
    item: HistoryEntry
    isFirst: boolean
    isLast: boolean
    onSelect: (url: string) => void
    onDelete: (url: string) => void
  }) => {
    const { colors } = useTheme()

    const itemStyle: any = { backgroundColor: colors.backgroundElevated }
    const deleteStyle: any = {}
    if (isFirst) {
      itemStyle.borderTopLeftRadius = radii.md
      itemStyle.borderTopRightRadius = radii.md
      deleteStyle.borderTopRightRadius = radii.md
    }
    if (isLast) {
      itemStyle.borderBottomLeftRadius = radii.md
      itemStyle.borderBottomRightRadius = radii.md
      deleteStyle.borderBottomRightRadius = radii.md
    }

    return (
      <ReanimatedSwipeable
        overshootRight={false}
        renderRightActions={() => (
          <View style={[styles.swipeDelete, deleteStyle, { backgroundColor: colors.error }]}>
            <Ionicons name="trash-outline" size={20} color="#fff" />
          </View>
        )}
        onSwipeableOpen={direction => {
          if (direction === SwipeDirection.LEFT) onDelete(item.url)
        }}
      >
        <Pressable style={[styles.historyItem, itemStyle]} onPress={() => onSelect(item.url)}>
          <Text numberOfLines={1} style={{ color: colors.textPrimary, fontSize: 15 }}>
            {item.title}
          </Text>
          <Text numberOfLines={1} style={{ color: colors.textSecondary, fontSize: 12 }}>
            {item.url}
          </Text>
        </Pressable>
      </ReanimatedSwipeable>
    )
  }
)

/* -------------------------------------------------------------------------- */
/*  List                                                                      */
/* -------------------------------------------------------------------------- */

const FOOTER = <View style={{ height: 80 }} />

const HistoryListInner = ({ history, onSelect, onDelete, onClear, hideTitle = false }: Props) => {
  const { t } = useTranslation()
  const { colors } = useTheme()

  // Local snapshot taken once when the component mounts (i.e. when the sheet
  // opens). All mutations (delete / clear) update this local copy directly so
  // the FlatList never receives a new data reference from the parent and
  // therefore never resets its scroll position.  The next time the sheet opens
  // the component remounts and picks up the latest history from props.
  const [items, setItems] = useState<HistoryEntry[]>(history)

  // Keep callback refs so the FlatList's renderItem never changes identity.
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect
  const onDeleteRef = useRef(onDelete)
  onDeleteRef.current = onDelete

  const stableSelect = useCallback((url: string) => onSelectRef.current(url), [])
  const stableDelete = useCallback((url: string) => onDeleteRef.current(url), [])

  const handleDelete = useCallback(
    (url: string) => {
      setItems(prev => prev.filter(i => i.url !== url))
      stableDelete(url)
    },
    [stableDelete]
  )

  const handleClear = useCallback(() => {
    setItems([])
    onClear?.()
  }, [onClear])

  const renderItem = useCallback(
    ({ item, index }: { item: HistoryEntry; index: number }) => (
      <HistoryRow
        item={item}
        isFirst={index === 0}
        isLast={index === items.length - 1}
        onSelect={stableSelect}
        onDelete={handleDelete}
      />
    ),
    [items.length, stableSelect, handleDelete]
  )

  const keyExtractor = useCallback((i: HistoryEntry) => i.url + i.timestamp, [])

  return (
    <View style={styles.container}>
      {!hideTitle && <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>{t('history')}</Text>}
      {onClear && items.length > 0 && (
        <TouchableOpacity style={[styles.clearBtn, { backgroundColor: colors.error }]} onPress={handleClear}>
          <Ionicons name="trash-outline" size={18} color="#fff" />
          <Text style={styles.clearBtnText}>{t('clear_all')}</Text>
        </TouchableOpacity>
      )}
      <FlatList
        style={styles.listContainer}
        contentContainerStyle={styles.listContent}
        data={items}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        ListFooterComponent={FOOTER}
      />
    </View>
  )
}

export const HistoryList = memo(HistoryListInner)

const styles = StyleSheet.create({
  container: {
    flex: 1,
    flexDirection: 'column'
  },
  listContainer: {
    flex: 1
  },
  listContent: {},
  sectionTitle: {
    ...typography.footnote,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.md,
    paddingHorizontal: spacing.xs
  },
  historyItem: {
    padding: 12
  },
  clearBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 8,
    marginBottom: spacing.md,
    marginHorizontal: spacing.xs,
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
    height: 60
  }
})
