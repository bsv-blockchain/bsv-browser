import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, radii, typography } from '@/context/theme/tokens'

interface GroupedListSection {
  header?: string
  footer?: string
  children: React.ReactNode
}

interface GroupedListProps {
  sections: GroupedListSection[]
}

/**
 * iOS-style grouped inset list with section headers and footers.
 * Wraps children in rounded, elevated containers on the
 * secondary background.
 */
export const GroupedList: React.FC<GroupedListProps> = ({ sections }) => {
  const { colors } = useTheme()

  return (
    <View style={styles.container}>
      {sections.map((section, idx) => (
        <View key={idx} style={styles.section}>
          {section.header && (
            <Text style={[styles.header, { color: colors.textTertiary }]}>
              {section.header.toUpperCase()}
            </Text>
          )}
          <View
            style={[
              styles.group,
              {
                backgroundColor: colors.backgroundElevated,
                borderColor: colors.separator,
              }
            ]}
          >
            {section.children}
          </View>
          {section.footer && (
            <Text style={[styles.footer, { color: colors.textTertiary }]}>
              {section.footer}
            </Text>
          )}
        </View>
      ))}
    </View>
  )
}

/**
 * Standalone section for inline use without the GroupedList wrapper.
 */
export const GroupedSection: React.FC<GroupedListSection> = ({
  header,
  footer,
  children
}) => {
  const { colors } = useTheme()

  return (
    <View style={styles.section}>
      {header && (
        <Text style={[styles.header, { color: colors.textTertiary }]}>
          {header.toUpperCase()}
        </Text>
      )}
      <View
        style={[
          styles.group,
          {
            backgroundColor: colors.backgroundElevated,
            borderColor: colors.separator,
          }
        ]}
      >
        {children}
      </View>
      {footer && (
        <Text style={[styles.footer, { color: colors.textTertiary }]}>
          {footer}
        </Text>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  section: {
    marginBottom: spacing.xxl,
  },
  // Tracked small caps, matching the day headings in the activity list — a
  // section header is a label for the block under it, not a line of prose.
  header: {
    fontSize: 10.5,
    fontWeight: '700',
    letterSpacing: 1.3,
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.sm,
  },
  // A card lifted off the canvas: the border does the work in dark, the shadow
  // in light, and the radius says "object" in both.
  group: {
    borderRadius: radii.lg,
    marginHorizontal: spacing.lg,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  footer: {
    ...typography.footnote,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.sm,
  },
})
