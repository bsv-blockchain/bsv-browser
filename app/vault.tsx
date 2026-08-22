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
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons'
import { router } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, radii, typography } from '@/context/theme/tokens'
import { GroupedSection } from '@/components/ui/GroupedList'
import { ListRow } from '@/components/ui/ListRow'
import PressableScale from '@/components/ui/PressableScale'
import AmountDisplay from '@/components/wallet/AmountDisplay'
import { EnrollWizard } from '@/components/vault/EnrollWizard'
import { useVaultBalance } from '@/hooks/useVaultBalance'
import { vaultStore, VaultMeta } from '@/services/vault/vaultStore'
import { getVaultDriver } from '@/services/vault/driver'
import { disableVault } from '@/services/vault/VaultKeyService'
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
    // Refuse to disable while funds remain: there IS a seal (disableVault's
    // vaultStore.clear deletes it along with the meta), and disabling before
    // a sweep would leave any vault UTXO reachable only the slow way — the
    // main mnemonic + vault passphrase, via the recovery sweep — with no more
    // in-app YubiKey ceremony to reach it directly. Force a withdrawal (or
    // recovery sweep) first.
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
    haptics.warning()
    showToast(t('vault_disabled_toast'), { type: 'info' })
    await reload()
  }, [balance, reload])

  const Header = (
    <View style={[styles.header, { borderBottomColor: colors.separator }]}>
      <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn}>
        <Ionicons name="chevron-back" size={24} color={colors.textSecondary} />
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
          {/* Quiet outline, not an accent fill: the CTA below is the only
              accent-filled element on this screen, so it wins the eye. */}
          <View style={[styles.heroBadge, { borderColor: colors.separator }]}>
            <MaterialCommunityIcons name="safe" size={40} color={colors.textSecondary} />
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
            onPress={() => router.push('/vault-transfer?direction=deposit')}
            style={[styles.actionBtn, { backgroundColor: colors.accent }]}
          >
            <Ionicons name="arrow-down" size={18} color={colors.textOnAccent} />
            <Text style={[styles.actionLabel, { color: colors.textOnAccent }]}>{t('vault_deposit_cta')}</Text>
          </PressableScale>
          <PressableScale
            haptic="confirm"
            onPress={() => router.push('/vault-transfer?direction=withdraw')}
            style={[
              styles.actionBtn,
              {
                backgroundColor: colors.backgroundElevated,
                borderColor: colors.separator,
                borderWidth: StyleSheet.hairlineWidth
              }
            ]}
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
            onPress={() => router.push('/vault-recover')}
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
  centered: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.lg },
  // NO horizontal padding here. GroupedSection insets itself (its card carries
  // marginHorizontal: spacing.lg, its header paddingHorizontal: spacing.xl), so
  // padding this container double-inset every grouped card to 32pt while the
  // balance and action row sat at 16pt — three different left edges on one
  // screen. Direct children now carry their own gutter instead, matching the
  // house pattern in app/settings.tsx and app/wallet-config.tsx.
  content: { paddingTop: spacing.lg, paddingBottom: spacing.xxxl },
  gutter: { paddingHorizontal: spacing.lg },
  heroBadge: {
    width: 80,
    height: 80,
    borderRadius: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth
  },
  h1: { ...typography.title1, textAlign: 'center' },
  h2: { ...typography.title3, textAlign: 'center' },
  p: { ...typography.subhead, textAlign: 'center' },
  primary: { width: '100%', borderRadius: radii.md, paddingVertical: spacing.lg, alignItems: 'center' },
  primaryLabel: { ...typography.headline },
  balanceBlock: {
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.lg
  },
  // No textTransform, matching the wallet screen: "Vault holds" is a phrase
  // leading into the amount, and casing belongs to the translation.
  balanceLabel: { ...typography.footnote },
  // tabular-nums so the balance does not jitter as digits change — the repo
  // convention (NearbyFlow, AmountInput).
  balance: { ...typography.display, fontVariant: ['tabular-nums'] },
  actions: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.xxl
  },
  actionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    borderRadius: radii.md,
    paddingVertical: spacing.lg
  },
  actionLabel: { ...typography.headline }
})
