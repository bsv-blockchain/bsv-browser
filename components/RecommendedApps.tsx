import React, { useState, useMemo, useCallback } from 'react'
import { observer } from 'mobx-react-lite'
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  Image,
  TextInput,
  Modal,
  Pressable,
  ScrollView
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import Fuse from 'fuse.js'
import { useTheme } from '@/context/theme/ThemeContext'
import { useWallet } from '@/context/WalletContext'
import { useBrowserMode } from '@/context/BrowserModeContext'
import { useTranslation } from 'react-i18next'
import bookmarkStore from '@/stores/BookmarkStore'
import tabStore from '@/stores/TabStore'

interface App {
  domain: string
  appName: string
  appIconImageUrl?: string
}

interface RecommendedAppsProps {
  setStartingUrl: (url: string) => void
  includeBookmarks?: { title: string; url: string }[]
  hideHeader?: boolean
  showOnlyBookmarks?: boolean
  limitBookmarks?: number // Limit number of bookmarks to show on homepage
  onRemoveBookmark?: (url: string) => void
  onRemoveDefaultApp?: (url: string) => void
  removedDefaultApps?: string[]
  onCloseModal?: () => void // Handler to close the modal
  // Homepage customization props
  homepageSettings?: {
    showBookmarks: boolean
    showRecentApps: boolean
    showRecommendedApps: boolean
  }
  onUpdateHomepageSettings?: (
    settings: Partial<{
      showBookmarks: boolean
      showRecentApps: boolean
      showRecommendedApps: boolean
    }>
  ) => void
}

/* -------------------------------------------------------------------------- */
/*                            DEFAULT RECOMMENDED                             */
/* -------------------------------------------------------------------------- */

const defaultApps: App[] = [
  {
    domain: 'https://todo.metanet.app',
    appName: 'My ToDo List',
    appIconImageUrl: 'https://todo.metanet.app/favicon.ico'
  },
  {
    domain: 'https://metanetacademy.com',
    appName: 'BSV Academy',
    appIconImageUrl: 'https://metanetacademy.com/favicon.ico'
  },
  {
    domain: 'https://coinflip.babbage.systems',
    appName: 'Coinflip Friend',
    appIconImageUrl: 'https://coinflip.babbage.systems/favicon.ico'
  }
]

/* -------------------------------------------------------------------------- */
/*                         RECOMMENDED APPS COMPONENT                         */
/* -------------------------------------------------------------------------- */

export const RecommendedApps = observer(({
  setStartingUrl,
  includeBookmarks = [],
  hideHeader = false,
  showOnlyBookmarks = false,
  limitBookmarks,
  onRemoveBookmark,
  onRemoveDefaultApp,
  removedDefaultApps = [],
  onCloseModal,
  homepageSettings,
  onUpdateHomepageSettings
}: RecommendedAppsProps) => {
  const { colors } = useTheme()
  const { recentApps } = useWallet()
  const { isWeb2Mode } = useBrowserMode()
  const { t } = useTranslation()
  const [searchQuery, setSearchQuery] = useState('')
  const [showCustomizeModal, setShowCustomizeModal] = useState(false)
  const [bookmarkRefresh, setBookmarkRefresh] = useState(0)

  // Context menu state
  const [contextMenuVisible, setContextMenuVisible] = useState(false)
  const [selectedApp, setSelectedApp] = useState<App | null>(null)

  /* -------------------------- helper functions -------------------------- */
  const isBookmark = useCallback(
    (app: App) => {
      // Check if it's in the actual bookmarks list
      return includeBookmarks.some(bookmark => bookmark.url === app.domain)
    },
    [includeBookmarks]
  )

  const isDefaultApp = useCallback((app: App) => {
    // Check if it's one of the default apps
    return defaultApps.some(defaultApp => defaultApp.domain === app.domain)
  }, [])

  const handleLongPress = useCallback(
    (app: App) => {
      // Allow removal of bookmarks OR default apps
      if ((isBookmark(app) || isDefaultApp(app)) && (onRemoveBookmark || onRemoveDefaultApp)) {
        setSelectedApp(app)
        setContextMenuVisible(true)
      }
    },
    [isBookmark, isDefaultApp, onRemoveBookmark, onRemoveDefaultApp]
  )

  const handleDeleteBookmark = useCallback(() => {
    if (selectedApp) {
      if (isBookmark(selectedApp) && onRemoveBookmark) {
        onRemoveBookmark(selectedApp.domain)
      } else if (isDefaultApp(selectedApp) && onRemoveDefaultApp) {
        onRemoveDefaultApp(selectedApp.domain)
      }
    }
    setContextMenuVisible(false)
    setSelectedApp(null)
  }, [selectedApp, isBookmark, isDefaultApp, onRemoveBookmark, onRemoveDefaultApp])

  const closeContextMenu = useCallback(() => {
    setContextMenuVisible(false)
    setSelectedApp(null)
  }, [])

  const handleAddBookmark = useCallback(() => {
    const activeTab = tabStore.activeTab
    if (activeTab && activeTab.url && activeTab.url !== 'about:blank' && !activeTab.url.includes('metanet://')) {
      const title = activeTab.title || activeTab.url
      bookmarkStore.addBookmark(title, activeTab.url)
      setBookmarkRefresh(prev => prev + 1)
      if (onCloseModal) {
        setTimeout(() => {
          onCloseModal()
        }, 100)
      }
    }
  }, [onCloseModal])

  /* -------------------------- prepare separate data sources -------------------------- */
  const filteredDefaultApps = useMemo(() => {
    if (showOnlyBookmarks) return []
    // Use homepage settings to determine if recommended apps should be shown
    if (homepageSettings && !homepageSettings.showRecommendedApps) return []
    // In web2 mode, don't show any default web3 apps
    if (isWeb2Mode) return []
    return defaultApps.filter(app => !removedDefaultApps.includes(app.domain))
  }, [removedDefaultApps, showOnlyBookmarks, homepageSettings, isWeb2Mode])

  const processedRecentApps = useMemo(() => {
    if (showOnlyBookmarks) return []
    // Use homepage settings to determine if recent apps should be shown
    if (homepageSettings && !homepageSettings.showRecentApps) return []
    // In web2 mode, don't show recent web3 apps
    if (isWeb2Mode) return []
    return recentApps.map(a => ({ ...a, appIconImageUrl: a.appIconImageUrl }))
  }, [recentApps, showOnlyBookmarks, homepageSettings, isWeb2Mode])

  const processedBookmarks = useMemo(() => {
    // Always use bookmarks directly from the store to ensure reactivity
    // This ensures the component updates when bookmarks are added/removed
    const storeBookmarks = bookmarkStore.bookmarks || []
    console.log('Processing bookmarks, count:', storeBookmarks.length)
    const bookmarks = storeBookmarks.map(bm => ({
      domain: bm.url,
      appName: bm.title || bm.url,
      appIconImageUrl: `${bm.url.replace(/\/$/, '')}/favicon.ico`
    }))

    // If we're not showing only bookmarks and we have a limit, slice the array
    if (!showOnlyBookmarks && limitBookmarks) {
      return bookmarks.slice(0, limitBookmarks)
    }

    return bookmarks
  }, [bookmarkStore.bookmarks, showOnlyBookmarks, limitBookmarks, bookmarkRefresh])

  // Combined for search functionality
  const allApps = useMemo(() => {
    const sources = [...filteredDefaultApps, ...processedRecentApps, ...processedBookmarks]
    return sources.reduce<App[]>((acc, cur) => {
      if (!acc.find(a => a.domain === cur.domain)) acc.push(cur)
      return acc
    }, [])
  }, [filteredDefaultApps, processedRecentApps, processedBookmarks])

  /* ---------------------------- fuzzy searching ---------------------------- */
  const fuse = useMemo(() => {
    return new Fuse(allApps, {
      keys: ['appName', 'domain'],
      threshold: 0.4,
      includeScore: true
    })
  }, [allApps])

  const visibleApps = useMemo(() => {
    if (!searchQuery.trim()) return null // Return null when not searching
    return fuse.search(searchQuery).map(r => r.item)
  }, [allApps, fuse, searchQuery])

  const searchResults = visibleApps

  /* ------------------------------- render functions ---------------------------------- */
  const renderAppItem = ({ item }: { item: App }) => (
    <TouchableOpacity
      style={componentStyles.appItem}
      onPress={() => setStartingUrl(item.domain)}
      onLongPress={() => handleLongPress(item)}
      delayLongPress={800}
    >
      {item.appIconImageUrl ? (
        <Image
          source={{ uri: item.appIconImageUrl }}
          style={componentStyles.appIcon}
          defaultSource={{ uri: item.domain + '/favicon.ico' }}
        />
      ) : (
        <View style={[componentStyles.placeholderIcon, { backgroundColor: colors.primary }]}>
          <Text style={{ color: colors.background, fontSize: 16 }}>{item.appName.charAt(0)}</Text>
        </View>
      )}
      <Text style={[componentStyles.appTitle, { color: colors.textPrimary }]}>{item.appName}</Text>
    </TouchableOpacity>
  )

  const renderSection = (title: string, data: App[], key: string) => {
    if (data.length === 0) return null

    return (
      <View key={key} style={componentStyles.section}>
        <Text style={[componentStyles.sectionTitle, { color: colors.textPrimary }]}>{title}</Text>
        <FlatList
          data={data}
          renderItem={renderAppItem}
          keyExtractor={item => `${key}-${item.domain}`}
          numColumns={3}
          showsVerticalScrollIndicator={false}
          scrollEnabled={false}
        />
      </View>
    )
  }

  return (
    <View style={[componentStyles.container, { backgroundColor: colors.paperBackground }]}>

      {/* Removed Add Bookmark button from top - now at bottom */}

      {showOnlyBookmarks && (
        <View style={componentStyles.searchContainer}>
          <TextInput
            style={[
              componentStyles.searchInput,
              {
                color: colors.textPrimary,
                backgroundColor: colors.inputBackground || colors.background,
                borderColor: colors.inputBorder
              }
            ]}
            placeholder={t('search_bookmarks')}
            placeholderTextColor={colors.textSecondary}
            value={searchQuery}
            onChangeText={setSearchQuery}
          />
        </View>
      )}

      <ScrollView showsVerticalScrollIndicator={false} style={{ flex: 1 }}>
        {searchResults ? (
          // Show search results
          <View style={componentStyles.section}>
            <Text style={[componentStyles.sectionTitle, { color: colors.textPrimary }]}>
              {t('search_results')} ({searchResults.length})
            </Text>
            <FlatList
              data={searchResults}
              renderItem={renderAppItem}
              keyExtractor={item => `search-${item.domain}`}
              numColumns={3}
              showsVerticalScrollIndicator={false}
              scrollEnabled={false}
            />
          </View>
        ) : (
          // Show separated sections
          <>
            {showOnlyBookmarks ? (
              // Only show bookmarks without section title (tab already shows "Bookmarks")
              <View style={componentStyles.section}>
                <FlatList
                  data={processedBookmarks}
                  renderItem={renderAppItem}
                  keyExtractor={item => `bookmarks-${item.domain}`}
                  numColumns={3}
                  showsVerticalScrollIndicator={false}
                  scrollEnabled={false}
                />
              </View>
            ) : (
              // Show all sections based on homepage settings
              <>
                {homepageSettings?.showBookmarks !== false &&
                  renderSection(
                    limitBookmarks ? t('recent_bookmarks') : t('bookmarks'),
                    processedBookmarks,
                    'bookmarks'
                  )}
                {homepageSettings?.showRecentApps !== false &&
                  renderSection(t('recent'), processedRecentApps, 'recent')}
                {homepageSettings?.showRecommendedApps !== false &&
                  renderSection(t('recommended'), filteredDefaultApps, 'default')}

                {/* Web2 mode message */}
                {/* {isWeb2Mode && (
                  <View style={[componentStyles.section, { paddingVertical: 20 }]}>
                    <View style={[componentStyles.web2Message, { backgroundColor: colors.inputBackground, borderColor: colors.inputBorder }]}>
                      <Ionicons name="rocket-outline" size={24} color={colors.primary} style={{ marginBottom: 8 }} />
                      <Text style={[componentStyles.web2MessageTitle, { color: colors.textPrimary }]}>
                        {t('unlock_web3_features')}
                      </Text>
                      <Text style={[componentStyles.web2MessageText, { color: colors.textSecondary }]}>
                        {t('get_web3_identity_to_access_apps')}
                      </Text>
                    </View>
                  </View>
                )} */}
              </>
            )}
          </>
        )}

        {/* Customize Homepage Button at the bottom */}
        {!showOnlyBookmarks && onUpdateHomepageSettings && (
          <View style={componentStyles.customizeSection}>
            <TouchableOpacity
              onPress={() => setShowCustomizeModal(true)}
              style={[
                componentStyles.customizeButtonBottom,
                { backgroundColor: colors.inputBackground, borderColor: colors.inputBorder }
              ]}
            >
              <Ionicons name="options-outline" size={20} color={colors.textSecondary} />
              <Text style={[componentStyles.customizeButtonText, { color: colors.textSecondary }]}>
                {t('customize_homepage')}
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>

      {/* Add Bookmark Button - Only show in bookmark modal */}
      {showOnlyBookmarks && (
        <View style={componentStyles.addBookmarkSection}>
          <TouchableOpacity
            style={[componentStyles.addBookmarkButton, { backgroundColor: colors.primary }]}
            onPress={handleAddBookmark}
            activeOpacity={0.7}
          >
            <Ionicons name="bookmark-outline" size={20} color={colors.background} />
            <Text style={[componentStyles.addBookmarkText, { color: colors.background }]}>{t('add_bookmark')}</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Customize Homepage Modal */}
      {showCustomizeModal && homepageSettings && onUpdateHomepageSettings && (
        <Modal
          transparent
          visible={showCustomizeModal}
          onRequestClose={() => setShowCustomizeModal(false)}
          animationType="fade"
        >
          <Pressable style={componentStyles.contextMenuBackdrop} onPress={() => setShowCustomizeModal(false)}>
            <View style={[componentStyles.customizeModal, { backgroundColor: colors.background }]}>
              <View style={[componentStyles.contextMenuHeader, { borderBottomColor: colors.inputBorder }]}>
                <Text style={[componentStyles.contextMenuTitle, { color: colors.textPrimary }]}>
                  {t('customize_homepage')}
                </Text>
                <Text style={[componentStyles.contextMenuUrl, { color: colors.textSecondary }]}>
                  {t('customize_homepage_description')}
                </Text>
              </View>

              <View style={componentStyles.customizeOptions}>
                <TouchableOpacity
                  style={componentStyles.customizeOption}
                  onPress={() => onUpdateHomepageSettings({ showBookmarks: !homepageSettings.showBookmarks })}
                  activeOpacity={0.7}
                >
                  <Ionicons
                    name={homepageSettings.showBookmarks ? 'checkbox' : 'square-outline'}
                    size={22}
                    color={homepageSettings.showBookmarks ? colors.primary : colors.textSecondary}
                  />
                  <Text style={[componentStyles.customizeOptionText, { color: colors.textPrimary }]}>
                    {t('recent_bookmarks')}
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={componentStyles.customizeOption}
                  onPress={() => onUpdateHomepageSettings({ showRecentApps: !homepageSettings.showRecentApps })}
                  activeOpacity={0.7}
                >
                  <Ionicons
                    name={homepageSettings.showRecentApps ? 'checkbox' : 'square-outline'}
                    size={22}
                    color={homepageSettings.showRecentApps ? colors.primary : colors.textSecondary}
                  />
                  <Text style={[componentStyles.customizeOptionText, { color: colors.textPrimary }]}>
                    {t('recent')}
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={componentStyles.customizeOption}
                  onPress={() =>
                    onUpdateHomepageSettings({ showRecommendedApps: !homepageSettings.showRecommendedApps })
                  }
                  activeOpacity={0.7}
                >
                  <Ionicons
                    name={homepageSettings.showRecommendedApps ? 'checkbox' : 'square-outline'}
                    size={22}
                    color={homepageSettings.showRecommendedApps ? colors.primary : colors.textSecondary}
                  />
                  <Text style={[componentStyles.customizeOptionText, { color: colors.textPrimary }]}>
                    {t('recommended')}
                  </Text>
                </TouchableOpacity>
              </View>

              <View style={componentStyles.customizeActions}>
                <TouchableOpacity
                  style={[componentStyles.customizeActionButton, { backgroundColor: colors.inputBackground }]}
                  onPress={() => {
                    if (onUpdateHomepageSettings) {
                      onUpdateHomepageSettings({
                        showBookmarks: true,
                        showRecentApps: true,
                        showRecommendedApps: true
                      })
                    }
                  }}
                  activeOpacity={0.7}
                >
                  <Ionicons name="refresh-outline" size={18} color={colors.textSecondary} />
                  <Text style={[componentStyles.customizeActionText, { color: colors.textSecondary }]}>
                    {t('reset')}
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[componentStyles.customizeActionButton, { backgroundColor: colors.primary }]}
                  onPress={() => setShowCustomizeModal(false)}
                  activeOpacity={0.7}
                >
                  <Ionicons name="checkmark-outline" size={18} color={colors.background} />
                  <Text style={[componentStyles.customizeActionText, { color: colors.background }]}>{t('done')}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </Pressable>
        </Modal>
      )}

      {/* Context Menu Modal */}
      {selectedApp && (
        <Modal transparent visible={contextMenuVisible} onRequestClose={closeContextMenu} animationType="fade">
          <Pressable style={componentStyles.contextMenuBackdrop} onPress={closeContextMenu}>
            <View style={[componentStyles.contextMenu, { backgroundColor: colors.background }]}>
              <View style={[componentStyles.contextMenuHeader, { borderBottomColor: colors.inputBorder }]}>
                <Text style={[componentStyles.contextMenuTitle, { color: colors.textPrimary }]}>
                  {selectedApp.appName}
                </Text>
                <Text style={[componentStyles.contextMenuUrl, { color: colors.textSecondary }]}>
                  {selectedApp.domain}
                </Text>
              </View>

              <TouchableOpacity
                style={[componentStyles.contextMenuItem, { borderBottomColor: colors.inputBorder }]}
                onPress={handleDeleteBookmark}
                activeOpacity={0.7}
              >
                <Ionicons name="trash-outline" size={22} color="#FF3B30" style={componentStyles.contextMenuIcon} />
                <Text style={[componentStyles.contextMenuText, { color: '#FF3B30' }]}>
                  {selectedApp && isBookmark(selectedApp) ? t('delete_bookmark') : t('hide_app')}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[componentStyles.contextMenuItem, { borderBottomWidth: 0 }]}
                onPress={closeContextMenu}
                activeOpacity={0.7}
              >
                <Ionicons
                  name="close-outline"
                  size={22}
                  color={colors.textSecondary}
                  style={componentStyles.contextMenuIcon}
                />
                <Text style={[componentStyles.contextMenuText, { color: colors.textSecondary }]}>{t('cancel')}</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Modal>
      )}
    </View>
  )
})

/* -------------------------------------------------------------------------- */
/*                                    CSS                                     */
/* -------------------------------------------------------------------------- */

const componentStyles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 8,
    borderRadius: 12
  },
  headerContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16
  },
  mainTitle: {
    fontSize: 20,
    fontWeight: '700',
    flex: 1
  },
  customizeButton: {
    padding: 8,
    borderRadius: 8,
    marginLeft: 8
  },
  searchContainer: { marginBottom: 16 },
  searchInput: {
    height: 40,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    fontSize: 14
  },
  section: {
    marginBottom: 24
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 12
  },
  appItem: {
    alignItems: 'center',
    marginBottom: 16,
    width: '30%',
    marginHorizontal: '1.5%'
  },
  appIcon: {
    width: 50,
    height: 50,
    borderRadius: 10,
    marginBottom: 8,
    alignItems: 'center'
  },
  placeholderIcon: {
    width: 50,
    height: 50,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 8
  },
  appTitle: {
    fontSize: 12,
    textAlign: 'center',
    flexWrap: 'wrap',
    lineHeight: 16
  },
  // Context Menu Styles
  contextMenuBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 1)',
    justifyContent: 'center',
    alignItems: 'center'
  },
  contextMenu: {
    borderRadius: 12,
    minWidth: 250,
    maxWidth: 300,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 4
    },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8
  },
  contextMenuHeader: {
    padding: 16,
    borderBottomWidth: StyleSheet.hairlineWidth
  },
  contextMenuTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4
  },
  contextMenuUrl: {
    fontSize: 12,
    opacity: 0.7
  },
  contextMenuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: StyleSheet.hairlineWidth
  },
  contextMenuIcon: {
    marginRight: 12
  },
  contextMenuText: {
    fontSize: 16,
    flex: 1
  },
  // Customize Modal Styles
  customizeModal: {
    borderRadius: 12,
    minWidth: 300,
    maxWidth: 350,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 4
    },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8
  },
  customizeOptions: {
    paddingVertical: 8
  },
  customizeOption: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(0,0,0,0.1)'
  },
  customizeOptionText: {
    fontSize: 16,
    marginLeft: 12,
    flex: 1
  },
  customizeActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: 16,
    gap: 12
  },
  customizeActionButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 12,
    borderRadius: 8,
    gap: 6
  },
  customizeActionText: {
    fontSize: 14,
    fontWeight: '600'
  },
  customizeSection: {
    marginTop: 32,
    marginBottom: 16
  },
  customizeButtonBottom: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    gap: 8
  },
  customizeButtonText: {
    fontSize: 16,
    fontWeight: '600'
  },
  bookmarkLimitControls: {
    flexDirection: 'row',
    gap: 8
  },
  limitButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(0,0,0,1)',
    justifyContent: 'center',
    alignItems: 'center'
  },
  addBookmarkSection: {
    padding: 16,
    paddingBottom: 36,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(0,0,0,0.1)'
  },
  addBookmarkButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
    borderRadius: 8,
    gap: 8
  },
  addBookmarkText: {
    fontSize: 16,
    fontWeight: '600'
  }
})
