import React, { useMemo } from 'react'
import {
  FlatList,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { observer } from 'mobx-react-lite'
import { useTranslation } from 'react-i18next'
import { useTheme } from '@/context/theme/ThemeContext'
import { useBrowserMode } from '@/context/BrowserModeContext'
import { spacing, radii, typography } from '@/context/theme/tokens'
import { useAppDirectory, type AppEntry } from '@/hooks/useAppDirectory'
import bookmarkStore from '@/stores/BookmarkStore'
import { isValidUrl } from '@/utils/generalHelpers'

const kNEW_TAB_URL = 'about:blank'

interface NewTabPageProps {
  onNavigate: (url: string) => void
}

const NewTabPageBase: React.FC<NewTabPageProps> = ({ onNavigate }) => {
  const { colors } = useTheme()
  const { t } = useTranslation()
  const { isWeb2Mode } = useBrowserMode()
  const { apps, loading } = useAppDirectory()
  const insets = useSafeAreaInsets()

  const bookmarks = useMemo(() => {
    return bookmarkStore.bookmarks
      .filter(b => b.url && b.url !== kNEW_TAB_URL && isValidUrl(b.url) && !b.url.includes('about:blank'))
      .slice(0, 8)
      .map(b => ({
        domain: b.url,
        appName: b.title || b.url,
        appIconImageUrl: `${b.url.replace(/\/$/, '')}/favicon.ico`,
      }))
  }, [])

  const renderAppItem = ({ item }: { item: AppEntry }) => (
    <TouchableOpacity
      style={styles.appItem}
      onPress={() => onNavigate(item.domain)}
      activeOpacity={0.6}
    >
      {item.appIconImageUrl ? (
        <Image
          source={{ uri: item.appIconImageUrl }}
          style={[styles.appIcon, { backgroundColor: colors.fillTertiary }]}
        />
      ) : (
        <View style={[styles.appIcon, styles.placeholderIcon, { backgroundColor: colors.fill }]}>
          <Text style={{ color: colors.textOnAccent, fontSize: 18, fontWeight: '600' }}>
            {item.appName.charAt(0).toUpperCase()}
          </Text>
        </View>
      )}
      <Text
        numberOfLines={2}
        style={[styles.appLabel, { color: colors.textPrimary }]}
      >
        {item.appName}
      </Text>
    </TouchableOpacity>
  )

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.backgroundSecondary }]}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + spacing.xxl }]}
    >
      {/* Favorites (from bookmarks) */}
      {bookmarks.length > 0 && (
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
            {t('bookmarks') || 'Favorites'}
          </Text>
          <FlatList
            data={bookmarks}
            renderItem={renderAppItem}
            keyExtractor={item => `fav-${item.domain}`}
            numColumns={4}
            scrollEnabled={false}
          />
        </View>
      )}

      {/* Apps from ls_apps overlay */}
      {!isWeb2Mode && apps.length > 0 && (
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
            {t('apps') || 'Apps'}
          </Text>
          <FlatList
            data={apps}
            renderItem={renderAppItem}
            keyExtractor={item => `app-${item.domain}`}
            numColumns={4}
            scrollEnabled={false}
          />
        </View>
      )}

      {/* Loading state */}
      {!isWeb2Mode && loading && apps.length === 0 && (
        <View style={styles.loadingContainer}>
          <Text style={[styles.loadingText, { color: colors.textTertiary }]}>
            Loading apps...
          </Text>
        </View>
      )}
    </ScrollView>
  )
}

export const NewTabPage = observer(NewTabPageBase)

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    paddingBottom: spacing.xxxl,
  },
  section: {
    marginBottom: spacing.xxl,
    paddingHorizontal: spacing.lg,
  },
  sectionTitle: {
    ...typography.footnote,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.md,
    paddingHorizontal: spacing.xs,
  },
  appItem: {
    width: '25%',
    alignItems: 'center',
    marginBottom: spacing.lg,
    paddingHorizontal: spacing.xs,
  },
  appIcon: {
    width: 56,
    height: 56,
    borderRadius: radii.lg,
    marginBottom: spacing.sm,
  },
  placeholderIcon: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  appLabel: {
    ...typography.caption1,
    textAlign: 'center',
  },
  loadingContainer: {
    alignItems: 'center',
    paddingVertical: spacing.xxxl,
  },
  loadingText: {
    ...typography.subhead,
  },
})
