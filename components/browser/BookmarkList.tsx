import React, { memo, useCallback, useRef, useState } from 'react'
import { FlatList, Image, Pressable, Text, TouchableOpacity, View, StyleSheet } from 'react-native'
import ReanimatedSwipeable, { SwipeDirection } from 'react-native-gesture-handler/ReanimatedSwipeable'
import { Ionicons } from '@expo/vector-icons'
import { observer } from 'mobx-react-lite'
import { useTranslation } from 'react-i18next'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, typography, radii } from '@/context/theme/tokens'
import bookmarkStore from '@/stores/BookmarkStore'
import { isValidUrl } from '@/utils/generalHelpers'
import type { Bookmark } from '@/shared/types/browser'

/* -------------------------------------------------------------------------- */
/*  Memoised row                                                              */
/* -------------------------------------------------------------------------- */

const BookmarkRow = memo(
  ({
    item,
    isFirst,
    isLast,
    onSelect,
    onDelete
  }: {
    item: Bookmark
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

    let faviconUrl: string
    try {
      faviconUrl = new URL(item.url).origin + '/favicon.ico'
    } catch {
      faviconUrl = `${item.url.replace(/\/$/, '')}/favicon.ico`
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
          if (direction === SwipeDirection.RIGHT) onDelete(item.url)
        }}
      >
        <Pressable style={[styles.bookmarkItem, itemStyle]} onPress={() => onSelect(item.url)}>
          <Image source={{ uri: faviconUrl }} style={[styles.favicon, { backgroundColor: colors.fillTertiary }]} />
          <View style={styles.bookmarkText}>
            <Text numberOfLines={1} style={[styles.bookmarkTitle, { color: colors.textPrimary }]}>
              {item.title || item.url}
            </Text>
            <Text numberOfLines={1} style={[styles.bookmarkUrl, { color: colors.textSecondary }]}>
              {item.url}
            </Text>
          </View>
        </Pressable>
      </ReanimatedSwipeable>
    )
  }
)

/* -------------------------------------------------------------------------- */
/*  List                                                                      */
/* -------------------------------------------------------------------------- */

interface Props {
  onSelect: (url: string) => void
  hideTitle?: boolean
}

const FOOTER = <View style={{ height: 80 }} />

const BookmarkListBase = ({ onSelect, hideTitle = false }: Props) => {
  const { t } = useTranslation()
  const { colors } = useTheme()

  // Local snapshot taken once when the component mounts (i.e. when the sheet
  // opens). All mutations (delete / clear) update this local copy directly so
  // the FlatList never receives a new data reference from the parent and
  // therefore never resets its scroll position.
  const [bookmarks, setBookmarks] = useState<Bookmark[]>(() =>
    bookmarkStore.bookmarks.filter(b => b.url && isValidUrl(b.url))
  )

  // Keep callback ref so the FlatList's renderItem never changes identity.
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect
  const stableSelect = useCallback((url: string) => onSelectRef.current(url), [])

  const handleDelete = useCallback((url: string) => {
    setBookmarks(prev => prev.filter(b => b.url !== url))
    bookmarkStore.removeBookmark(url)
  }, [])

  const handleClearAll = useCallback(() => {
    setBookmarks([])
    bookmarkStore.clearBookmarks()
  }, [])

  const renderItem = useCallback(
    ({ item, index }: { item: Bookmark; index: number }) => (
      <BookmarkRow
        item={item}
        isFirst={index === 0}
        isLast={index === bookmarks.length - 1}
        onSelect={stableSelect}
        onDelete={handleDelete}
      />
    ),
    [bookmarks.length, stableSelect, handleDelete]
  )

  const keyExtractor = useCallback((item: Bookmark) => item.url, [])

  return (
    <View style={styles.container}>
      {!hideTitle && (
        <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>{t('bookmarks') || 'Bookmarks'}</Text>
      )}
      {bookmarks.length === 0 ? (
        <View style={styles.emptyState}>
          <Ionicons name="bookmark-outline" size={40} color={colors.textTertiary} />
          <Text style={[styles.emptyText, { color: colors.textTertiary }]}>No bookmarks yet</Text>
        </View>
      ) : (
        <>
          <TouchableOpacity style={[styles.clearBtn, { backgroundColor: colors.error }]} onPress={handleClearAll}>
            <Ionicons name="trash-outline" size={18} color="#fff" />
            <Text style={styles.clearBtnText}>{t('clear_all')}</Text>
          </TouchableOpacity>
          <FlatList
            style={styles.listContainer}
            data={bookmarks}
            keyExtractor={keyExtractor}
            renderItem={renderItem}
            ListFooterComponent={FOOTER}
          />
        </>
      )}
    </View>
  )
}

export const BookmarkList = observer(BookmarkListBase)

const styles = StyleSheet.create({
  container: {
    flex: 1,
    flexDirection: 'column'
  },
  listContainer: {
    flex: 1
  },
  sectionTitle: {
    ...typography.footnote,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.md,
    paddingHorizontal: spacing.xs
  },
  bookmarkItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    gap: spacing.md
  },
  favicon: {
    width: 28,
    height: 28,
    borderRadius: radii.sm
  },
  bookmarkText: {
    flex: 1
  },
  bookmarkTitle: {
    fontSize: 15
  },
  bookmarkUrl: {
    fontSize: 12
  },
  swipeDelete: {
    justifyContent: 'center',
    alignItems: 'center',
    width: 60,
    height: 60
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
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    paddingTop: spacing.xxxl
  },
  emptyText: {
    ...typography.body
  }
})
