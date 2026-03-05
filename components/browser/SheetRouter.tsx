import React, { useCallback } from 'react'
import { View } from 'react-native'
import { useTranslation } from 'react-i18next'

import type { Tab, HistoryEntry } from '@/shared/types/browser'
import { kNEW_TAB_URL } from '@/shared/constants'
import { PermissionType, PermissionState } from '@/utils/permissionsManager'
import { spacing } from '@/context/theme/tokens'
import type { SheetContextType } from '@/context/SheetContext'

import { BrowserPage } from '@/components/browser/BrowserPage'
import { HistoryList } from '@/components/browser/HistoryList'
import { BookmarkList } from '@/components/browser/BookmarkList'
import SettingsScreen from '@/app/settings'
import WalletConfigScreen from '@/app/wallet-config'
import Sheet from '@/components/ui/Sheet'

type Props = {
  sheet: SheetContextType
  activeTab: Tab | null | undefined
  domainForUrl: (u: string) => string
  homepageUrl: string
  updateActiveTab: (patch: Partial<Tab>) => void
  setAddressText: (v: string) => void
  history: HistoryEntry[]
  clearHistory: () => Promise<void>
  removeHistoryItem: (url: string) => Promise<void>
  handlePermissionChange: (permission: PermissionType, state: PermissionState) => Promise<void>
  addBookmark: (title: string, url: string) => void
}

export function SheetRouter({
  sheet,
  activeTab,
  domainForUrl,
  homepageUrl,
  updateActiveTab,
  setAddressText,
  history,
  clearHistory,
  removeHistoryItem,
  handlePermissionChange,
  addBookmark
}: Props) {
  const { t } = useTranslation()
  const isNewTab = activeTab?.url === kNEW_TAB_URL

  const getSheetTitle = (): string | undefined => {
    switch (sheet.route) {
      case 'wallet-config':
        return t('settings')
      default:
        return undefined
    }
  }

  // Stable callbacks so memoised child components don't re-render needlessly.
  const navigateAndClose = useCallback(
    (url: string) => {
      updateActiveTab({ url })
      sheet.close()
    },
    [updateActiveTab, sheet]
  )

  const canGoBack = sheet.history.length > 0

  return (
    <Sheet
      visible={sheet.isOpen && sheet.route !== 'tabs'}
      onClose={sheet.close}
      title={getSheetTitle()}
      onBack={canGoBack ? sheet.pop : undefined}
      heightPercent={0.85}
    >
      {sheet.route === 'browser-menu' && (
        <View style={{ flex: 1, padding: spacing.lg }}>
          <BrowserPage inSheet onNavigate={navigateAndClose} history={history} removeHistoryItem={removeHistoryItem} />
        </View>
      )}

      {sheet.route === 'bookmarks' && (
        <View style={{ flex: 1, padding: spacing.lg }}>
          <BookmarkList onSelect={navigateAndClose} />
        </View>
      )}

      {sheet.route === 'history' && (
        <View style={{ flex: 1, padding: spacing.lg }}>
          <HistoryList
            history={history}
            onSelect={navigateAndClose}
            onDelete={removeHistoryItem}
            onClear={clearHistory}
          />
        </View>
      )}

      {sheet.route === 'settings' && (
        <View style={{ flex: 1 }}>
          <SettingsScreen />
        </View>
      )}

      {sheet.route === 'wallet-config' && (
        <View style={{ flex: 1 }}>
          <WalletConfigScreen />
        </View>
      )}
    </Sheet>
  )
}
