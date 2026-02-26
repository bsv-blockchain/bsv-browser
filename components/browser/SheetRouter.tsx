import React from 'react'
import { View } from 'react-native'
import { useTranslation } from 'react-i18next'
import { router } from 'expo-router'

import type { Tab, HistoryEntry } from '@/shared/types/browser'
import { kNEW_TAB_URL } from '@/shared/constants'
import { isValidUrl } from '@/utils/generalHelpers'
import { PermissionType, PermissionState } from '@/utils/permissionsManager'
import { spacing } from '@/context/theme/tokens'
import type { SheetContextType } from '@/context/SheetContext'

import { BrowserPage } from '@/components/browser/BrowserPage'
import { MenuSheet } from '@/components/browser/MenuSheet'
import PermissionsScreen from '@/components/browser/PermissionsScreen'
import SettingsScreen from '@/app/settings'
import TrustScreen from '@/app/trust'
import Sheet from '@/components/ui/Sheet'

type Props = {
  sheet: SheetContextType
  activeTab: Tab | null | undefined
  domainForUrl: (u: string) => string
  homepageUrl: string
  updateActiveTab: (patch: Partial<Tab>) => void
  setAddressText: (v: string) => void
  clearHistory: () => Promise<void>
  history: HistoryEntry[]
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
  clearHistory,
  history,
  removeHistoryItem,
  handlePermissionChange,
  addBookmark,
}: Props) {
  const { t } = useTranslation()
  const isNewTab = activeTab?.url === kNEW_TAB_URL

  const getSheetTitle = (): string | undefined => {
    switch (sheet.route) {
      case 'bookmarks':
        return 'Browser'
      case 'settings':
        return 'Wallet'
      case 'trust':
        return t('trust_network')
      default:
        return undefined
    }
  }

  return (
    <Sheet
      visible={sheet.isOpen && sheet.route !== 'tabs'}
      onClose={sheet.close}
      title={getSheetTitle()}
      heightPercent={sheet.route === 'menu' ? 0.65 : 0.85}
    >
      {sheet.route === 'menu' && (
        <MenuSheet
          isNewTab={isNewTab}
          onBackToHomepage={() => {
            updateActiveTab({ url: homepageUrl })
            setAddressText(homepageUrl)
          }}
          onAddBookmark={() => {
            if (activeTab && activeTab.url !== kNEW_TAB_URL && isValidUrl(activeTab.url)) {
              addBookmark(activeTab.title || t('untitled'), activeTab.url)
            }
          }}
          onGoToLogin={() => router.push('/auth/mnemonic')}
        />
      )}
      {sheet.route === 'bookmarks' && (
        <View style={{ flex: 1, padding: spacing.lg }}>
          <BrowserPage inSheet onNavigate={(url) => { updateActiveTab({ url }); sheet.close() }} clearHistory={clearHistory} history={history} removeHistoryItem={removeHistoryItem} />
        </View>
      )}
      
      {sheet.route === 'settings' && (
        <View style={{ flex: 1 }}>
          <SettingsScreen />
        </View>
      )}
      {sheet.route === 'trust' && (
        <View style={{ flex: 1 }}>
          <TrustScreen />
        </View>
      )}
    </Sheet>
  )
}
