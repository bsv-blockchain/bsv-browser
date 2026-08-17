/**
 * Vault recovery — full screen, not a drawer.
 *
 * The escape hatch when the hardware key is lost or its PIV applet is bricked.
 * It sweeps the vault to the everyday balance WITHOUT the key, then clears the
 * vault.
 *
 * Which inputs are required depends on how the vault was enrolled:
 *   v2 — the wallet's own recovery phrase (already on this device) plus the
 *        vault passphrase the user chose. The stored xpub verifies the
 *        passphrase before anything is signed, because BIP39 passphrases have
 *        no checksum and a typo would otherwise derive a different, empty
 *        vault and look exactly like lost funds.
 *   v1 — the separate 24-word backup phrase from the old design.
 */
import React, { useCallback, useEffect, useState } from 'react'
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { router } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, radii, typography } from '@/context/theme/tokens'
import PressableScale from '@/components/ui/PressableScale'
import { showToast } from '@/components/ui/Toast'
import { haptics } from '@/hooks/useHaptics'
import { useWallet } from '@/context/WalletContext'
import { useLocalStorage } from '@/context/LocalStorageProvider'
import { vaultStore, type VaultMeta } from '@/services/vault/vaultStore'
import { disableVault, recoverVaultHD, recoverVaultKeyV1 } from '@/services/vault/VaultKeyService'
import { sweepVaultWithHD, sweepVaultWithKey, type VaultWallet } from '@/services/vault/transfers'
import { verifyVaultPassphrase } from '@/services/vault/vaultDerivation'
import { VaultError } from '@/services/vault/types'
import i18n from '@/context/i18n/translations'

const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, o) as string

export default function VaultRecoverScreen() {
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const { managers, adminOriginator, destroyPrivilegedKey } = useWallet()
  const { getMnemonic } = useLocalStorage()

  const [meta, setMeta] = useState<VaultMeta | null>(null)
  const [passphrase, setPassphrase] = useState('')
  const [legacyPhrase, setLegacyPhrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void vaultStore.getMeta().then(setMeta)
  }, [])

  const isLegacy = meta?.v === 1

  const run = useCallback(async () => {
    const pm = managers?.permissionsManager
    if (!pm) return
    setBusy(true)
    setError(null)
    try {
      if (isLegacy) {
        const words = legacyPhrase.trim().split(/\s+/).filter(Boolean)
        if (words.length < 12) throw new VaultError('bad-mnemonic', t('vault_recover_too_short'))
        const v = await recoverVaultKeyV1(words.join(' '))
        await sweepVaultWithKey(
          pm as unknown as VaultWallet,
          adminOriginator,
          v,
          t('vault_recover_reason')
        )
      } else {
        const mnemonic = await getMnemonic()
        if (!mnemonic) throw new VaultError('bad-mnemonic', t('vault_requires_mnemonic'))
        const xpub = meta && 'xpub' in meta ? meta.xpub : undefined
        // Verify BEFORE signing so a typo reports "wrong passphrase" instead of
        // silently sweeping an empty vault and reporting success.
        if (xpub && !verifyVaultPassphrase(mnemonic, passphrase, xpub)) {
          throw new VaultError('bad-passphrase', t('vault_recover_wrong_passphrase'))
        }
        const hd = await recoverVaultHD(mnemonic, passphrase, xpub)
        await sweepVaultWithHD(
          pm as unknown as VaultWallet,
          adminOriginator,
          hd,
          t('vault_recover_reason')
        )
      }

      await disableVault()
      destroyPrivilegedKey()
      haptics.success()
      showToast(t('vault_recovered_toast'), { type: 'success' })
      setPassphrase('')
      setLegacyPhrase('')
      router.back()
    } catch (e) {
      const msg =
        e instanceof VaultError
          ? e.message || t(`vault_err_${e.code.replace(/-/g, '_')}`)
          : t('vault_recover_failed')
      setError(msg)
      haptics.error()
    } finally {
      setBusy(false)
    }
  }, [
    isLegacy,
    legacyPhrase,
    passphrase,
    meta,
    managers?.permissionsManager,
    adminOriginator,
    getMnemonic,
    destroyPrivilegedKey
  ])

  const canRun = isLegacy ? legacyPhrase.trim().length > 0 : passphrase.length > 0

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
          {t('vault_recover_title')}
        </Text>
        <View style={styles.iconBtn} />
      </View>

      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Text style={[styles.sub, { color: colors.textSecondary }]}>{t('vault_recover_sub')}</Text>

        {isLegacy ? (
          <>
            <Text style={[styles.label, { color: colors.textPrimary }]}>
              {t('vault_recover_legacy_label')}
            </Text>
            <TextInput
              style={[
                styles.area,
                { color: colors.textPrimary, backgroundColor: colors.backgroundElevated }
              ]}
              value={legacyPhrase}
              onChangeText={setLegacyPhrase}
              placeholder={t('vault_recover_placeholder')}
              placeholderTextColor={colors.textTertiary}
              autoCapitalize="none"
              autoCorrect={false}
              multiline
            />
          </>
        ) : (
          <>
            <Text style={[styles.label, { color: colors.textPrimary }]}>
              {t('vault_recover_passphrase_label')}
            </Text>
            <Text style={[styles.fine, { color: colors.textSecondary }]}>
              {t('vault_recover_passphrase_help')}
            </Text>
            <TextInput
              style={[
                styles.input,
                { color: colors.textPrimary, backgroundColor: colors.backgroundElevated }
              ]}
              value={passphrase}
              onChangeText={setPassphrase}
              placeholder={t('vault_recover_passphrase_placeholder')}
              placeholderTextColor={colors.textTertiary}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              secureTextEntry
            />
          </>
        )}

        {error && <Text style={[styles.err, { color: colors.error }]}>{error}</Text>}

        <PressableScale
          haptic="confirm"
          onPress={canRun && !busy ? run : undefined}
          style={[
            styles.primary,
            {
              backgroundColor: canRun ? colors.accent : colors.backgroundElevated,
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
                { color: canRun ? colors.textOnAccent : colors.textTertiary }
              ]}
            >
              {t('vault_recover_cta')}
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
  body: { padding: spacing.xl, gap: spacing.md },
  sub: { ...typography.subhead },
  label: { ...typography.footnote, fontWeight: '600', textTransform: 'uppercase' },
  fine: { ...typography.footnote },
  input: {
    borderRadius: radii.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    ...typography.body
  },
  area: {
    minHeight: 96,
    borderRadius: radii.md,
    padding: spacing.lg,
    ...typography.body,
    textAlignVertical: 'top'
  },
  err: { ...typography.footnote },
  primary: {
    borderRadius: radii.md,
    paddingVertical: spacing.lg,
    alignItems: 'center',
    marginTop: spacing.sm
  },
  primaryLabel: { ...typography.headline }
})
