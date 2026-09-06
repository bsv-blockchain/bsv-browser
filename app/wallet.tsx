import { Ionicons } from '@expo/vector-icons'
import { router } from 'expo-router'
import { useTranslation } from 'react-i18next'
import { TouchableOpacity, StyleSheet } from 'react-native'
import { useTheme } from '@bsv/expo-wallet-toolbox'
import { WalletHomeScreen } from '@bsv/expo-wallet-toolbox/ui'

/**
 * The wallet is a sub-screen here, not the app's home. `/` is the Browser, so
 * this is the one thing the library cannot supply: a way back out to it.
 * WalletHomeScreen leaves that slot empty by default, because most host apps
 * (BSV Wallet included) have nothing to return to.
 */
export default function Wallet() {
  const { colors } = useTheme()
  const { t } = useTranslation()

  return (
    <WalletHomeScreen
      topLeft={
        <TouchableOpacity
          onPress={() => router.replace('/')}
          style={[styles.back, { backgroundColor: colors.surfaceRaised, borderColor: colors.surfaceRaisedBorder }]}
          accessibilityRole="button"
          accessibilityLabel={t('back_to_browser')}
        >
          <Ionicons name="chevron-back" size={22} color={colors.textPrimary} />
        </TouchableOpacity>
      }
    />
  )
}

const styles = StyleSheet.create({
  back: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center'
  }
})
