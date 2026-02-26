import React from 'react'
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import type { HistoryEntry, Bookmark } from '@/shared/types/browser'
import { spacing, radii, typography } from '@/context/theme/tokens'

type Props = {
  suggestions: (HistoryEntry | Bookmark)[]
  colors: { backgroundElevated: string; separator: string; textPrimary: string; textSecondary: string }
  bottomOffset: number
  onSelect: (url: string) => void
}

export function SuggestionsDropdown({ suggestions, colors, bottomOffset, onSelect }: Props) {
  if (suggestions.length === 0) return null

  return (
    <View
      style={[
        styles.suggestionsWrapper,
        { bottom: bottomOffset + 60 },
      ]}
      pointerEvents="box-none"
    >
      <View style={[styles.suggestions, { backgroundColor: colors.backgroundElevated }]}>
        {suggestions.map((entry, i) => (
          <TouchableOpacity
            key={`suggestion-${i}-${entry.url}`}
            onPress={() => onSelect(entry.url)}
            style={[
              styles.suggestionItem,
              i < suggestions.length - 1 && {
                borderBottomWidth: StyleSheet.hairlineWidth,
                borderBottomColor: colors.separator,
              },
            ]}
          >
            <Text numberOfLines={1} style={[styles.suggestionTitle, { color: colors.textPrimary }]}>
              {entry.title}
            </Text>
            <Text numberOfLines={1} style={[styles.suggestionUrl, { color: colors.textSecondary }]}>
              {entry.url}
            </Text>
          </TouchableOpacity>
        ))}
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
    paddingHorizontal: spacing.md,
  },
  suggestions: {
    borderRadius: radii.lg,
    overflow: 'hidden',
  },
  suggestionItem: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  suggestionTitle: {
    ...typography.subhead,
  },
  suggestionUrl: {
    ...typography.footnote,
    marginTop: 2,
  },
})
