/**
 * The Vault screen.
 *
 * Not enrolled → a hero explainer and the enrollment wizard.
 * Enrolled → the vault balance, deposit/withdraw actions, the key card, and a
 * recovery/disable overflow.
 *
 * Feature-gated: when no YubiKey-capable driver is present (and not a dev
 * build) the screen explains the requirement rather than offering enrollment.
 */
import React, { useEffect, useState, useCallback } from 'react'
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { router } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, radii, typography } from '@/context/theme/tokens'
import { GroupedSection } from '@/components/ui/GroupedList'
import { ListRow } from '@/components/ui/ListRow'
import PressableScale from '@/components/ui/PressableScale'
import AmountDisplay from '@/components/wallet/AmountDisplay'
import { EnrollWizard } from '@/components/vault/EnrollWizard'
import { TransferSheet } from '@/components/vault/TransferSheet'
import { useVaultBalance } from '@/hooks/useVaultBalance'
import { vaultStore, VaultMeta } from '@/services/vault/vaultStore'
import { getVaultDriver } from '@/services/vault/driver'
import { disableVault, recoverVaultKey } from '@/services/vault/VaultKeyService'
import { sweepVaultWithKey, VaultWallet } from '@/services/vault/transfers'
import { useWallet } from '@/context/WalletContext'
import { RecoverSheet } from '@/components/vault/RecoverSheet'
import { showAlert } from '@/components/ui/AlertCard'
import { showToast } from '@/components/ui/Toast'
import { haptics } from '@/hooks/useHaptics'
import i18n from '@/context/i18n/translations'

const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, o) as string

export default function VaultScreen() {
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const { balance, loading, refresh } = useVaultBalance()
  const [enrolled, setEnrolled] = useState<boolean | null>(null)
  const [meta, setMeta] = useState<VaultMeta | null>(null)
  const [enrolling, setEnrolling] = useState(false)
  const [transfer, setTransfer] = useState<'deposit' | 'withdraw' | null>(null)
  const [recovering, setRecovering] = useState(false)
  const { managers, adminOriginator, destroyPrivilegedKey } = useWallet()

  const supported = getVaultDriver()?.isSupported() ?? false

  const reload = useCallback(async () => {
    const [e, m] = await Promise.all([vaultStore.isEnrolled(), vaultStore.getMeta()])
    setEnrolled(e)
    setMeta(m)
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  const onEnrolled = useCallback(async () => {
    setEnrolling(false)
    await reload()
    refresh()
  }, [reload, refresh])

  const confirmDisable = useCallback(async () => {
    // Refuse to disable while funds remain: disabling removes the key gate and
    // the seal, and any vault UTXO left behind would be locked to a key with no
    // in-app signer. Force a withdrawal (or recovery sweep) first.
    if ((balance ?? 0) > 0) {
      await showAlert({
        title: t('vault_disable_blocked_title'),
        message: t('vault_disable_blocked_message'),
        buttons: [{ text: t('vault_ok'), key: 'ok' }]
      })
      return
    }
    const choice = await showAlert({
      title: t('vault_disable_title'),
      message: t('vault_disable_message'),
      buttons: [
        { text: t('vault_disable_confirm'), key: 'confirm', style: 'destructive' },
        { text: t('vault_cancel'), key: 'cancel', style: 'cancel' }
      ]
    })
    if (choice !== 'confirm') return
    await disableVault()
    destroyPrivilegedKey() // don't let V linger in the PKM retention window
    haptics.warning()
    showToast(t('vault_disabled_toast'), { type: 'info' })
    await reload()
  }, [balance, reload, destroyPrivilegedKey])

  // Recovery: enter the backup phrase, sweep all vault funds to the everyday
  // balance with the phrase key (no YubiKey), then clear the vault. This is the
  // escape hatch when the key is lost or bricked.
  const runRecovery = useCallback(
    async (phrase: string) => {
      const pm = managers?.permissionsManager
      if (!pm) throw new Error('wallet not ready')
      const v = await recoverVaultKey(phrase) // throws on an invalid phrase
      await sweepVaultWithKey(pm as unknown as VaultWallet, adminOriginator, v, t('vault_recover_reason'))
      await disableVault()
      destroyPrivilegedKey()
      haptics.success()
      showToast(t('vault_recovered_toast'), { type: 'success' })
      setRecovering(false)
      await reload()
      refresh()
    },
    [managers?.permissionsManager, adminOriginator, reload, refresh, destroyPrivilegedKey]
  )

  const Header = (
    <View style={[styles.header, { borderBottomColor: colors.separator }]}>
      <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn}>
        <Ionicons name="chevron-back" size={24} color={colors.accent} />
      </TouchableOpacity>
      <Text style={[styles.headerTitle, { color: colors.textPrimary }]}>{t('vault_title')}</Text>
      <View style={styles.iconBtn} />
    </View>
  )

  // ── unsupported device ───────────────────────────────────────────────
  if (!supported && !__DEV__) {
    return (
      <View style={[styles.container, { backgroundColor: colors.backgroundSecondary, paddingTop: insets.top }]}>
        {Header}
        <View style={styles.centered}>
          <Ionicons name="hardware-chip-outline" size={48} color={colors.textTertiary} />
          <Text style={[styles.h2, { color: colors.textPrimary }]}>{t('vault_unsupported_title')}</Text>
          <Text style={[styles.p, { color: colors.textSecondary }]}>{t('vault_unsupported_body')}</Text>
        </View>
      </View>
    )
  }

  if (enrolled === null) {
    return (
      <View style={[styles.container, { backgroundColor: colors.backgroundSecondary, paddingTop: insets.top }]}>
        {Header}
        <View style={styles.centered}>
          <ActivityIndicator color={colors.accent} />
        </View>
      </View>
    )
  }

  // ── enrollment wizard ────────────────────────────────────────────────
  if (enrolling) {
    return (
      <View style={[styles.container, { backgroundColor: colors.backgroundSecondary, paddingTop: insets.top }]}>
        {Header}
        <EnrollWizard onDone={onEnrolled} onCancel={() => setEnrolling(false)} />
      </View>
    )
  }

  // ── not enrolled ─────────────────────────────────────────────────────
  if (!enrolled) {
    return (
      <View style={[styles.container, { backgroundColor: colors.backgroundSecondary, paddingTop: insets.top }]}>
        {Header}
        <ScrollView contentContainerStyle={styles.centered}>
          <View style={[styles.heroBadge, { backgroundColor: colors.accent }]}>
            <Ionicons name="lock-closed" size={40} color={colors.textOnAccent} />
          </View>
          <Text style={[styles.h1, { color: colors.textPrimary }]}>{t('vault_hero_title')}</Text>
          <Text style={[styles.p, { color: colors.textSecondary }]}>{t('vault_hero_body')}</Text>
          <PressableScale
            haptic="confirm"
            onPress={() => setEnrolling(true)}
            style={[styles.primary, { backgroundColor: colors.accent }]}
          >
            <Text style={[styles.primaryLabel, { color: colors.textOnAccent }]}>{t('vault_enroll_begin')}</Text>
          </PressableScale>
        </ScrollView>
      </View>
    )
  }

  // ── enrolled ─────────────────────────────────────────────────────────
  return (
    <View style={[styles.container, { backgroundColor: colors.backgroundSecondary, paddingTop: insets.top }]}>
      {Header}
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.balanceBlock}>
          <Text style={[styles.balanceLabel, { color: colors.textSecondary }]}>{t('vault_balance_label')}</Text>
          <TouchableOpacity onPress={refresh} activeOpacity={0.7}>
            {loading && balance === null ? (
              <ActivityIndicator color={colors.accent} />
            ) : (
              <Text style={[styles.balance, { color: colors.textPrimary }]}>
                <AmountDisplay>{balance ?? 0}</AmountDisplay>
              </Text>
            )}
          </TouchableOpacity>
        </View>

        <View style={styles.actions}>
          <PressableScale
            haptic="confirm"
            onPress={() => setTransfer('deposit')}
            style={[styles.actionBtn, { backgroundColor: colors.accent }]}
          >
            <Ionicons name="arrow-down" size={18} color={colors.textOnAccent} />
            <Text style={[styles.actionLabel, { color: colors.textOnAccent }]}>{t('vault_deposit_cta')}</Text>
          </PressableScale>
          <PressableScale
            haptic="confirm"
            onPress={() => setTransfer('withdraw')}
            style={[styles.actionBtn, { backgroundColor: colors.backgroundElevated, borderColor: colors.separator, borderWidth: StyleSheet.hairlineWidth }]}
          >
            <Ionicons name="arrow-up" size={18} color={colors.accent} />
            <Text style={[styles.actionLabel, { color: colors.accent }]}>{t('vault_withdraw_cta')}</Text>
          </PressableScale>
        </View>

        <GroupedSection header={t('vault_key_section')}>
          <ListRow
            label={t('vault_key_nickname')}
            value={meta?.nickname}
            icon="hardware-chip"
            iconColor={colors.accent}
            showChevron={false}
          />
          <ListRow
            label={t('vault_key_serial')}
            value={meta?.yubiSerial}
            icon="finger-print"
            iconColor={colors.permissionSpending}
            showChevron={false}
            isLast
          />
        </GroupedSection>

        <GroupedSection header={t('vault_manage_section')}>
          <ListRow
            label={t('vault_recover_row')}
            icon="medkit-outline"
            iconColor={colors.info ?? colors.accent}
            onPress={() => setRecovering(true)}
          />
          <ListRow
            label={t('vault_disable_row')}
            icon="lock-open"
            iconColor={colors.error}
            destructive
            onPress={confirmDisable}
            isLast
          />
        </GroupedSection>
      </ScrollView>

      <TransferSheet direction={transfer} onClose={() => setTransfer(null)} onComplete={refresh} />
      <RecoverSheet visible={recovering} onClose={() => setRecovering(false)} onRecover={runRecovery} />
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.sm, paddingVertical: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth },
  iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { ...typography.headline },
  centered: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.lg },
  content: { padding: spacing.lg, gap: spacing.xl },
  heroBadge: { width: 80, height: 80, borderRadius: 40, alignItems: 'center', justifyContent: 'center' },
  h1: { ...typography.title1, textAlign: 'center' },
  h2: { ...typography.title3, textAlign: 'center' },
  p: { ...typography.subhead, textAlign: 'center' },
  primary: { width: '100%', borderRadius: radii.md, paddingVertical: spacing.lg, alignItems: 'center' },
  primaryLabel: { ...typography.headline },
  balanceBlock: { alignItems: 'center', gap: spacing.xs, paddingVertical: spacing.lg },
  balanceLabel: { ...typography.footnote, textTransform: 'uppercase' },
  balance: { ...typography.display },
  actions: { flexDirection: 'row', gap: spacing.md },
  actionBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, borderRadius: radii.md, paddingVertical: spacing.lg },
  actionLabel: { ...typography.headline }
})
