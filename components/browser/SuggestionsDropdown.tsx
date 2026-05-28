import React, { memo, useCallback, useMemo, useRef } from 'react'
import { FlatList, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import type { HistoryEntry, Bookmark } from '@/shared/types/browser'
import { spacing, radii, typography } from '@/context/theme/tokens'

type Suggestion = HistoryEntry | Bookmark

type RowColors = { textPrimary: string; textSecondary: string; separator: string }

type Props = {
  suggestions: Suggestion[]
  colors: { backgroundElevated: string; separator: string; textPrimary: string; textSecondary: string }
  bottomOffset: number
  onSelect: (url: string) => void
}

// Fixed row height — enables FlatList.getItemLayout, which skips per-item measurement
// passes and lets the list synchronously land scroll positions. Matches the actual
// rendered height of `suggestionItem` below (padding 8+8 + title line ~17 + url line ~14
// + 2px gap ≈ 49). The padding constant is intentional and tracked here to keep the
// row layout deterministic.
const ROW_HEIGHT = 49

const SuggestionRow = memo(
  ({
    item,
    showSeparator,
    rowColors,
    onSelect
  }: {
    item: Suggestion
    showSeparator: boolean
    rowColors: RowColors
    onSelect: (url: string) => void
  }) => (
    <TouchableOpacity
      onPress={() => onSelect(item.url)}
      style={[
        styles.suggestionItem,
        showSeparator && {
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: rowColors.separator
        }
      ]}
    >
      <Text numberOfLines={1} style={[styles.suggestionTitle, { color: rowColors.textPrimary }]}>
        {item.title}
      </Text>
      <Text numberOfLines={1} style={[styles.suggestionUrl, { color: rowColors.textSecondary }]}>
        {item.url}
      </Text>
    </TouchableOpacity>
  )
)

export function SuggestionsDropdown({ suggestions, colors, bottomOffset, onSelect }: Props) {
  // Stable onSelect ref so renderItem identity doesn't change when parent re-renders.
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect
  const stableSelect = useCallback((url: string) => onSelectRef.current(url), [])

  const rowColors = useMemo<RowColors>(
    () => ({
      textPrimary: colors.textPrimary,
      textSecondary: colors.textSecondary,
      separator: colors.separator
    }),
    [colors.textPrimary, colors.textSecondary, colors.separator]
  )

  const lastIndex = suggestions.length - 1
  const renderItem = useCallback(
    ({ item, index }: { item: Suggestion; index: number }) => (
      <SuggestionRow item={item} showSeparator={index < lastIndex} rowColors={rowColors} onSelect={stableSelect} />
    ),
    [lastIndex, rowColors, stableSelect]
  )

  const keyExtractor = useCallback((item: Suggestion, index: number) => `${index}-${item.url}`, [])

  const getItemLayout = useCallback(
    (_: unknown, index: number) => ({ length: ROW_HEIGHT, offset: ROW_HEIGHT * index, index }),
    []
  )

  if (suggestions.length === 0) return null

  return (
    <View style={[styles.suggestionsWrapper, { bottom: bottomOffset + 60 }]} pointerEvents="box-none">
      <View style={[styles.suggestions, { backgroundColor: colors.backgroundElevated }]}>
        <FlatList
          data={suggestions}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          getItemLayout={getItemLayout}
          keyboardShouldPersistTaps="handled"
          initialNumToRender={6}
          maxToRenderPerBatch={6}
          windowSize={3}
          removeClippedSubviews
        />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  suggestionsWrapper: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 19,
    paddingHorizontal: spacing.md
  },
  suggestions: {
    borderRadius: radii.lg,
    overflow: 'hidden',
    maxHeight: ROW_HEIGHT * 6
  },
  suggestionItem: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    height: ROW_HEIGHT
  },
  suggestionTitle: {
    ...typography.subhead
  },
  suggestionUrl: {
    ...typography.footnote,
    marginTop: 2
  }
})
