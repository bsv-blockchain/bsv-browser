import React from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTranslation } from 'react-i18next'

import { useBrowserMode } from '@/context/BrowserModeContext'
import { useSheet } from '@/context/SheetContext'
import { ListRow } from '@/components/ui/ListRow'
import { GroupedSection } from '@/components/ui/GroupedList'
import Balance from '@/components/wallet/Balance'
import { spacing } from '@/context/theme/tokens'

interface MenuSheetProps {
  isNewTab: boolean
  onBackToHomepage: () => void
  onAddBookmark: () => void
  onGoToLogin: () => void
}

export const MenuSheet: React.FC<MenuSheetProps> = ({
  isNewTab,
  onBackToHomepage,
  onAddBookmark,
  onGoToLogin,
}) => {
  const { t } = useTranslation()
  const { isWeb2Mode } = useBrowserMode()
  const { push, close } = useSheet()
  const insets = useSafeAreaInsets()

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ paddingBottom: insets.bottom + 20 }}
    >
      {/* Balance (web3 only) */}
      {!isWeb2Mode && (
        <View style={styles.balanceContainer}>
          <Balance />
        </View>
      )}

      {/* Web3 features */}
      {!isWeb2Mode && (
        <GroupedSection>
          <ListRow
            label={t('identity')}
            icon="person-circle-outline"
            onPress={() => push('identity')}
          />
          <ListRow
            label={t('trust_network')}
            icon="shield-checkmark-outline"
            onPress={() => push('trust')}
          />
          <ListRow
            label={t('settings')}
            icon="settings-outline"
            onPress={() => push('settings')}
          />
          {!isNewTab && (
            <ListRow
              label={t('permissions')}
              icon="lock-closed-outline"
              onPress={() => push('permissions')}
              isLast
            />
          )}
          {isNewTab && (
            <ListRow
              label={t('settings')}
              icon="settings-outline"
              onPress={() => push('settings')}
              isLast
            />
          )}
        </GroupedSection>
      )}

      {/* Browsing actions */}
      <GroupedSection>
        {!isNewTab && (
          <ListRow
            label={t('add_bookmark')}
            icon="bookmark-outline"
            onPress={() => { onAddBookmark(); close() }}
            showChevron={false}
          />
        )}
        <ListRow
          label={t('back_to_homepage')}
          icon="apps-outline"
          onPress={() => { onBackToHomepage(); close() }}
          showChevron={false}
          isLast
        />
      </GroupedSection>

      {/* Web2 login prompt */}
      {isWeb2Mode && (
        <GroupedSection>
          <ListRow
            label={t('unlock_web3_features') || 'Unlock Web3 features'}
            icon="log-in-outline"
            iconColor="#34C759"
            onPress={() => { onGoToLogin(); close() }}
            showChevron={false}
            isLast
          />
        </GroupedSection>
      )}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  balanceContainer: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
  },
})
