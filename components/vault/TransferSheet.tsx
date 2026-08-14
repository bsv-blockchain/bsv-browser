/**
 * Deposit / withdraw sheet. Deposit runs immediately (no YubiKey). Withdraw
 * calls the transfer, which triggers the ceremony via the privileged signature
 * path — the ceremony sheet takes over for insert/PIN/touch, then this reports
 * the result.
 */
import React, { useState, useCallback } from 'react'
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import Sheet from '@/components/ui/Sheet'
import PressableScale from '@/components/ui/PressableScale'
import { AmountInput } from '@/components/wallet/AmountInput'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, radii, typography } from '@/context/theme/tokens'
import { useWallet } from '@/context/WalletContext'
import { depositToVault, withdrawFromVault, VaultWallet } from '@/services/vault/transfers'
import { VaultError } from '@/services/vault/types'
import { sounds } from '@/hooks/useConfirmationSound'
import { haptics } from '@/hooks/useHaptics'
import { showToast } from '@/components/ui/Toast'
import i18n from '@/context/i18n/translations'

const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, o) as string

export const TransferSheet: React.FC<{
  direction: 'deposit' | 'withdraw' | null
  onClose: () => void
  onComplete: () => void
}> = ({ direction, onClose, onComplete }) => {
  const { colors } = useTheme()
  const { managers, adminOriginator } = useWallet()
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isDeposit = direction === 'deposit'

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
        await withdrawFromVault(w, adminOriginator, sats, t('vault_withdraw_reason', { amount: sats }))
        // vaultOpen/haptic already fired by the ceremony's onArmed
        showToast(t('vault_withdraw_done'), { type: 'success' })
      }
      setAmount('')
      onComplete()
      onClose()
    } catch (e) {
      console.error('[vault] transfer failed:', e instanceof Error ? e.message : e, e)
      const code = e instanceof VaultError ? e.code : undefined
      setError(code ? t(`vault_err_${code.replace(/-/g, '_')}`, {}) || t('vault_err_generic') : t('vault_err_generic'))
      haptics.error()
    } finally {
      setBusy(false)
    }
  }, [amount, isDeposit, managers?.permissionsManager, adminOriginator, onClose, onComplete])

  return (
    <Sheet
      visible={direction !== null}
      onClose={onClose}
      title={isDeposit ? t('vault_deposit_title') : t('vault_withdraw_title')}
      fitContent
    >
      <View style={styles.body}>
        <Ionicons
          name={isDeposit ? 'arrow-down-circle-outline' : 'arrow-up-circle-outline'}
          size={40}
          color={colors.accent}
        />
        <Text style={[styles.sub, { color: colors.textSecondary }]}>
          {isDeposit ? t('vault_deposit_sub') : t('vault_withdraw_sub')}
        </Text>
        <View style={styles.amountWrap}>
          <AmountInput value={amount} onChangeText={setAmount} showMax={false} />
        </View>
        {error && <Text style={[styles.err, { color: colors.error }]}>{error}</Text>}
        <PressableScale
          haptic="confirm"
          onPress={run}
          disabled={busy}
          style={[styles.primary, { backgroundColor: colors.accent, opacity: busy ? 0.6 : 1 }]}
        >
          {busy ? (
            <ActivityIndicator color={colors.textOnAccent} />
          ) : (
            <Text style={[styles.primaryLabel, { color: colors.textOnAccent }]}>
              {isDeposit ? t('vault_deposit_cta') : t('vault_withdraw_cta')}
            </Text>
          )}
        </PressableScale>
      </View>
    </Sheet>
  )
}

const styles = StyleSheet.create({
  body: { padding: spacing.xl, gap: spacing.lg, alignItems: 'center' },
  amountWrap: { alignSelf: 'stretch' },
  sub: { ...typography.subhead, textAlign: 'center' },
  err: { ...typography.footnote, textAlign: 'center' },
  primary: { width: '100%', borderRadius: radii.md, paddingVertical: spacing.lg, alignItems: 'center' },
  primaryLabel: { ...typography.headline }
})
