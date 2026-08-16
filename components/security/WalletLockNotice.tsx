/**
 * The states the app previously had no way to show.
 *
 * Before the envelope, a failed key read was indistinguishable from having no
 * wallet: the build silently bailed and the user landed in the browser as if
 * they were new. Now that the OS genuinely holds the key, three outcomes need
 * to be visible and told apart:
 *
 *  - `lost`        the OS destroyed the key (biometrics re-enrolled, screen
 *                  lock removed, app reinstalled). Unrecoverable on-device.
 *  - `cancelled`   the user dismissed the sheet. Nothing was touched; retry.
 *  - `unavailable` biometric lockout or no usable hardware.
 *
 * Nothing here wipes anything on its own. Restoring is an explicit, confirmed
 * act, because the alternative — auto-wiping on a read failure — would destroy
 * a wallet over a transient prompt error.
 */
import React, { useCallback } from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { router } from 'expo-router'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, radii, typography } from '@/context/theme/tokens'
import PressableScale from '@/components/ui/PressableScale'
import { showAlert } from '@/components/ui/AlertCard'
import { useLocalStorage } from '@/context/LocalStorageProvider'
import i18n from '@/context/i18n/translations'

const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, o) as string

export default function WalletLockNotice() {
  const { colors } = useTheme()
  const { unlockState, unlock, deleteAllWalletKeys } = useLocalStorage()

  const onRestore = useCallback(async () => {
    const choice = await showAlert({
      title: t('wallet_lost_title'),
      message: t('wallet_lost_body'),
      buttons: [
        { text: t('wallet_lost_later'), style: 'cancel', key: 'cancel' },
        { text: t('wallet_lost_restore'), style: 'destructive', key: 'restore' }
      ]
    })
    if (choice !== 'restore') return
    // The ciphertexts are already unopenable; clearing them is what lets
    // onboarding start clean instead of tripping over an orphan sentinel.
    await deleteAllWalletKeys()
    router.replace('/auth/mnemonic')
  }, [deleteAllWalletKeys])

  const status = unlockState.status
  if (status !== 'lost' && status !== 'cancelled' && status !== 'unavailable') return null

  const lost = status === 'lost'
  const body = lost
    ? t('wallet_lost_body')
    : status === 'unavailable' && unlockState.reason === 'lockout'
      ? t('wallet_lockout_body')
      : status === 'unavailable'
        ? t('wallet_no_biometrics_body')
        : t('wallet_locked_body')

  return (
    <View style={[styles.card, { backgroundColor: colors.backgroundSecondary, borderColor: colors.separator }]}>
      <Ionicons
        name={lost ? 'alert-circle-outline' : 'lock-closed-outline'}
        size={40}
        color={lost ? colors.textPrimary : colors.textTertiary}
      />
      <Text style={[styles.title, { color: colors.textPrimary }]}>
        {lost ? t('wallet_lost_title') : t('wallet_locked_title')}
      </Text>
      <Text style={[styles.body, { color: colors.textSecondary }]}>{body}</Text>

      <PressableScale
        haptic="confirm"
        onPress={lost ? onRestore : unlock}
        style={[styles.primary, { backgroundColor: colors.accent }]}
      >
        <Text style={styles.primaryText}>
          {lost ? t('wallet_lost_restore') : t('wallet_unlock_retry')}
        </Text>
      </PressableScale>
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.xl,
    margin: spacing.lg,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth
  },
  title: { ...typography.title3, textAlign: 'center' },
  body: { ...typography.subhead, textAlign: 'center' },
  primary: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xl,
    borderRadius: radii.pill,
    marginTop: spacing.xs
  },
  primaryText: { ...typography.headline, color: '#fff' }
})
