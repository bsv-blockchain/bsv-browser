/**
 * Vault deposit / withdraw — full screen, not a drawer.
 *
 * Direction comes from the `direction` search param ('deposit' | 'withdraw').
 *
 * Deposit runs immediately and needs no hardware key: addresses are BIP32
 * children of the stored xpub. Withdraw goes through the privileged signature
 * path, so the ceremony sheet takes over for insert/PIN/touch — that one stays
 * a sheet deliberately, because it fires from any screen as a system prompt.
 */
import React, { useState, useCallback } from 'react'
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
  TouchableOpacity
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { router, useLocalSearchParams } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import PressableScale from '@/components/ui/PressableScale'
import { AmountInput } from '@/components/wallet/AmountInput'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, radii, typography } from '@/context/theme/tokens'
import { useWallet } from '@/context/WalletContext'
import { useVaultBalance } from '@/hooks/useVaultBalance'
import AmountDisplay from '@/components/wallet/AmountDisplay'
import { depositToVault, withdrawFromVault, type VaultWallet } from '@/services/vault/transfers'
import { VaultError } from '@/services/vault/types'
import { sounds } from '@/hooks/useConfirmationSound'
import { haptics } from '@/hooks/useHaptics'
import { showToast } from '@/components/ui/Toast'
import i18n from '@/context/i18n/translations'

const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, o) as string

export default function VaultTransferScreen() {
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const { direction } = useLocalSearchParams<{ direction?: string }>()
  const { managers, adminOriginator } = useWallet()
  const { balance, refresh } = useVaultBalance()
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isDeposit = direction !== 'withdraw'

  const run = useCallback(async () => {
    const pm = managers?.permissionsManager
    const sats = parseInt(amount, 10)
    if (!pm || !Number.isFinite(sats) || sats <= 0) return
    setBusy(true)
    setError(null)
    try {
      const w = pm as unknown as VaultWallet
      if (isDeposit) {
        await depositToVault(w, adminOriginator, sats)
        sounds.confirmation()
        haptics.success()
        showToast(t('vault_deposit_done'), { type: 'success' })
      } else {
        await withdrawFromVault(
          w,
          adminOriginator,
          sats,
          t('vault_withdraw_reason', { amount: sats })
        )
        // vaultOpen/haptic already fired by the ceremony's onArmed
        showToast(t('vault_withdraw_done'), { type: 'success' })
      }
      setAmount('')
      refresh()
      router.back()
    } catch (e) {
      console.error('[vault] transfer failed:', e instanceof Error ? e.message : e, e)
      const code = e instanceof VaultError ? e.code : undefined
      setError(
        code ? t(`vault_err_${code.replace(/-/g, '_')}`, {}) || t('vault_err_generic') : t('vault_err_generic')
      )
      haptics.error()
    } finally {
      setBusy(false)
    }
  }, [amount, isDeposit, managers?.permissionsManager, adminOriginator, refresh])

  const sats = parseInt(amount, 10)
  const valid = Number.isFinite(sats) && sats > 0

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: colors.backgroundSecondary, paddingTop: insets.top }
      ]}
    >
      <View style={[styles.header, { borderBottomColor: colors.separator }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn}>
          <Ionicons name="chevron-back" size={24} color={colors.textSecondary} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.textPrimary }]}>
          {isDeposit ? t('vault_deposit_title') : t('vault_withdraw_title')}
        </Text>
        <View style={styles.iconBtn} />
      </View>

      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <View style={styles.balanceBlock}>
          <Text style={[styles.balanceLabel, { color: colors.textSecondary }]}>
            {t('vault_balance_label')}
          </Text>
          <Text style={[styles.balance, { color: colors.textPrimary }]}>
            <AmountDisplay>{balance ?? 0}</AmountDisplay>
          </Text>
        </View>

        <Text style={[styles.sub, { color: colors.textSecondary }]}>
          {isDeposit ? t('vault_deposit_sub') : t('vault_withdraw_sub')}
        </Text>

        <AmountInput value={amount} onChangeText={setAmount} showMax={false} />

        {error && <Text style={[styles.err, { color: colors.error }]}>{error}</Text>}

        <PressableScale
          haptic="confirm"
          onPress={valid && !busy ? run : undefined}
          style={[
            styles.primary,
            {
              backgroundColor: valid ? colors.accent : colors.backgroundElevated,
              opacity: busy ? 0.6 : 1
            }
          ]}
        >
          {busy ? (
            <ActivityIndicator color={colors.textOnAccent} />
          ) : (
            <Text
              style={[
                styles.primaryLabel,
                { color: valid ? colors.textOnAccent : colors.textTertiary }
              ]}
            >
              {isDeposit ? t('vault_deposit_cta') : t('vault_withdraw_cta')}
            </Text>
          )}
        </PressableScale>
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth
  },
  iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { ...typography.headline },
  body: { padding: spacing.xl, gap: spacing.lg },
  balanceBlock: { alignItems: 'center', gap: spacing.xs, paddingBottom: spacing.md },
  balanceLabel: { ...typography.footnote, textTransform: 'uppercase' },
  balance: { ...typography.title1, fontVariant: ['tabular-nums'] },
  sub: { ...typography.subhead, textAlign: 'center' },
  err: { ...typography.footnote, textAlign: 'center' },
  primary: { borderRadius: radii.md, paddingVertical: spacing.lg, alignItems: 'center' },
  primaryLabel: { ...typography.headline }
})
