/**
 * Vault deposit / withdraw — full screen, not a drawer.
 *
 * Direction comes from the `direction` search param ('deposit' | 'withdraw').
 *
 * Both directions run the ceremony sheet. A deposit address is a BIP32 child
 * of the vault's PRIVATE HD node — there is no stored xpub to derive one
 * from without it — so even a deposit needs one YubiKey tap to unwrap that
 * node. Withdraw derives every input's key (and any re-vaulted remainder)
 * from the same unwrapped node and signs in software. Either way the ceremony
 * sheet takes over for insert/PIN/touch — that one stays a sheet
 * deliberately, because it fires from any screen as a system prompt.
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
import { AmountInput, SEND_MAX_VALUE } from '@/components/wallet/AmountInput'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, radii, typography } from '@/context/theme/tokens'
import { useWallet } from '@/context/WalletContext'
import { useVaultBalance } from '@/hooks/useVaultBalance'
import AmountDisplay from '@/components/wallet/AmountDisplay'
import { depositToVault, withdrawFromVault, type VaultWallet } from '@/services/vault/transfers'
import { getOnline } from '@/utils/net/online'
import { VaultError } from '@/services/vault/types'
import { haptics } from '@/hooks/useHaptics'
import { showToast } from '@/components/ui/Toast'
import { showAlert } from '@/components/ui/AlertCard'
import i18n from '@/context/i18n/translations'

const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, o) as string

/**
 * i18next returns the KEY itself when a string is missing, and a key is
 * truthy — so the old `t(...) || t('vault_err_generic')` fallback never fired
 * and shipped raw keys like `vault_err_backup_required` to the screen.
 */
function translateVaultError(code: string | undefined): string {
  if (!code) return t('vault_err_generic')
  const key = `vault_err_${code.replace(/-/g, '_')}`
  const translated = t(key)
  return translated === key ? t('vault_err_generic') : translated
}

export default function VaultTransferScreen() {
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const { direction } = useLocalSearchParams<{ direction?: string }>()
  const { managers, adminOriginator, storage } = useWallet()
  const { balance, refresh } = useVaultBalance()
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isDeposit = direction !== 'withdraw'

  // Send max is a sentinel value, not a number: the withdraw path takes 'all'
  // and lets the toolbox work out the fee, which is the only way to empty the
  // vault exactly. Pre-computing "balance minus fee" here cannot work — a K1
  // withdrawal's fee depends on how many vault inputs it takes to cover the
  // amount (each input is an ordinary ~107-byte unlock), not on any one
  // script's size, and that count is not known until the outputs are selected.
  const isMax = amount === SEND_MAX_VALUE

  const run = useCallback(async () => {
    const pm = managers?.permissionsManager
    const sats = parseInt(amount, 10)
    if (!pm) return
    if (!isMax && (!Number.isFinite(sats) || sats <= 0)) return
    setBusy(true)
    setError(null)
    try {
      const w = pm as unknown as VaultWallet
      if (isDeposit) {
        await depositToVault(w, adminOriginator, sats, t('vault_deposit_reason', { amount: sats }), {
          isOnline: getOnline,
          // A failed tx2 leaves its staging coin spendable=0 even though it is
          // live on chain (see VaultTransferOptions.releaseStrandedStaging);
          // this lets the retry reuse that coin instead of splitting again.
          releaseStrandedStaging: storage ? () => storage.releaseVaultStagingStrandedByInvalidTx() : undefined
        })
        // vaultOpen/haptic already fired by the ceremony's onArmed
        showToast(t('vault_deposit_done'), { type: 'success' })
      } else {
        const result = await withdrawFromVault(
          w,
          adminOriginator,
          isMax ? 'all' : sats,
          t('vault_withdraw_reason', { amount: isMax ? (balance ?? 0) : sats }),
          {
            // Lets the reservation heal find the reserving transaction with one
            // indexed query instead of paging every action in the wallet.
            findSpendingReferences: storage ? outpoints => storage.findSpendingReferences(outpoints) : undefined,
            isOnline: getOnline
          }
        )
        // vaultOpen/haptic already fired by the ceremony's onArmed
        //
        // A capped withdrawal is partial by design (see VAULT_MAX_INPUTS), so
        // say so rather than letting the balance look wrong: the vault still
        // holds the untouched outputs, and repeating the withdrawal moves them.
        showToast(
          result.remainingInputs > 0
            ? t('vault_withdraw_partial', { count: result.remainingInputs })
            : t('vault_withdraw_done'),
          { type: 'success' }
        )
      }
      setAmount('')
      refresh()
      router.back()
    } catch (e) {
      console.error('[vault] transfer failed:', e instanceof Error ? e.message : e, e)
      const code = e instanceof VaultError ? e.code : undefined

      if (code === 'backup-required') {
        // A blocked deposit needs a route out, not a red footnote. Matches the
        // disable-while-funded pattern on the vault screen.
        //
        // The CTA goes to Settings > Wallet, not back to /vault: this refusal
        // only fires once a vault already exists (deposit is only offered
        // from the enrolled vault screen), and the enrolled vault screen has
        // no backup affordance of its own — EnrollWizard, the only other
        // place that records an attestation, isn't reachable from there.
        // Printing recovery shares from wallet-config is a real backup and
        // now records the same attestation (see handlePrintRecoveryShares),
        // so it satisfies the gate. push (not replace) keeps this screen on
        // the stack so the user can come back and retry the deposit.
        haptics.error()
        const choice = await showAlert({
          title: t('vault_deposit_blocked_title'),
          message: t('vault_deposit_blocked_message'),
          buttons: [
            { text: t('vault_deposit_blocked_dismiss'), style: 'cancel', key: 'cancel' },
            { text: t('vault_deposit_blocked_cta'), key: 'backup' }
          ]
        })
        if (choice === 'backup') router.push('/wallet-config')
        return
      }

      setError(translateVaultError(code))
      haptics.error()
    } finally {
      setBusy(false)
    }
  }, [amount, isMax, balance, isDeposit, managers?.permissionsManager, adminOriginator, refresh, storage])

  const sats = parseInt(amount, 10)
  const valid = isMax || (Number.isFinite(sats) && sats > 0)

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

        <AmountInput
          value={amount}
          onChangeText={setAmount}
          showMax={!isDeposit}
          maxLabelKey="entire_vault_balance"
        />

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
