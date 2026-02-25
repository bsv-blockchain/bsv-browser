import React, { useMemo, useState, useEffect } from 'react'
import {
  FlatList,
  Image,
  Keyboard,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { observer } from 'mobx-react-lite'
import { useTranslation } from 'react-i18next'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, radii, typography } from '@/context/theme/tokens'
import { useLocalStorage } from '@/context/LocalStorageProvider'
import { DEFAULT_HOMEPAGE_URL } from '@/shared/constants'
import bookmarkStore from '@/stores/BookmarkStore'
import { isValidUrl } from '@/utils/generalHelpers'

const kNEW_TAB_URL = 'about:blank'

interface NewTabPageProps {
  onNavigate: (url: string) => void
  inSheet?: boolean
}

interface BookmarkItem {
  domain: string
  appName: string
  appIconImageUrl?: string
}

const NewTabPageBase: React.FC<NewTabPageProps> = ({ onNavigate, inSheet = false }) => {
  const { colors } = useTheme()
  const { t } = useTranslation()
  const insets = useSafeAreaInsets()
  const { getItem, setItem } = useLocalStorage()

  const [homepageUrl, setHomepageUrl] = useState(DEFAULT_HOMEPAGE_URL)
  const [editingHomepage, setEditingHomepage] = useState(false)

  useEffect(() => {
    ;(async () => {
      const stored = await getItem('homepageUrl')
      if (stored) setHomepageUrl(stored)
    })()
  }, [getItem])

  const saveHomepageUrl = async (url: string) => {
    const trimmed = url.trim()
    if (trimmed) {
      setHomepageUrl(trimmed)
      await setItem('homepageUrl', trimmed)
    }
    setEditingHomepage(false)
    Keyboard.dismiss()
  }

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

  const renderAppItem = ({ item }: { item: BookmarkItem }) => (
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
      contentContainerStyle={[
        styles.content,
        {
          paddingTop: inSheet ? spacing.sm : insets.top + spacing.xxl,
          paddingBottom: inSheet ? spacing.xxxl : insets.bottom + 80,
        }
      ]}
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

      {/* Homepage setting */}
      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
          Homepage
        </Text>
        {editingHomepage ? (
          <View style={styles.homepageEdit}>
            <TextInput
              style={[
                styles.homepageInput,
                {
                  backgroundColor: colors.fillTertiary,
                  borderColor: colors.separator,
                  color: colors.textPrimary,
                }
              ]}
              value={homepageUrl}
              onChangeText={setHomepageUrl}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              returnKeyType="done"
              onSubmitEditing={() => saveHomepageUrl(homepageUrl)}
              placeholder={DEFAULT_HOMEPAGE_URL}
              placeholderTextColor={colors.textTertiary}
              autoFocus
            />
            <View style={styles.homepageButtons}>
              <TouchableOpacity
                style={[styles.homepageButton, { backgroundColor: colors.identityApproval }]}
                onPress={() => saveHomepageUrl(homepageUrl)}
              >
                <Text style={[styles.homepageButtonText, { color: colors.textOnAccent }]}>Save</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.homepageButton, {
                  backgroundColor: colors.fillTertiary,
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: colors.separator,
                }]}
                onPress={() => {
                  setEditingHomepage(false)
                  ;(async () => {
                    const stored = await getItem('homepageUrl')
                    setHomepageUrl(stored || DEFAULT_HOMEPAGE_URL)
                  })()
                }}
              >
                <Text style={[styles.homepageButtonText, { color: colors.textPrimary }]}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <TouchableOpacity
            style={styles.homepageRow}
            onPress={() => setEditingHomepage(true)}
            activeOpacity={0.6}
          >
            <Ionicons name="globe-outline" size={18} color={colors.textTertiary} style={{ marginRight: spacing.sm }} />
            <Text style={[styles.homepageUrl, { color: colors.textSecondary }]} numberOfLines={1}>
              {homepageUrl}
            </Text>
            <Ionicons name="pencil-outline" size={14} color={colors.textQuaternary} style={{ marginLeft: spacing.sm }} />
          </TouchableOpacity>
        )}
      </View>
    </ScrollView>
  )
}

export const NewTabPage = observer(NewTabPageBase)

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {},
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
  homepageRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xs,
  },
  homepageUrl: {
    ...typography.footnote,
    flex: 1,
  },
  homepageEdit: {
    paddingHorizontal: spacing.xs,
  },
  homepageInput: {
    ...typography.body,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    marginBottom: spacing.sm,
  },
  homepageButtons: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  homepageButton: {
    flex: 1,
    paddingVertical: spacing.md,
    borderRadius: radii.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  homepageButtonText: {
    ...typography.headline,
  },
})
