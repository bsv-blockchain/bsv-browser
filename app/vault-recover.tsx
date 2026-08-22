/**
 * Vault recovery — full screen, not a drawer.
 *
 * The escape hatch when the hardware key is lost or its PIV applet is bricked.
 * It sweeps the vault to the everyday balance WITHOUT the key, then clears the
 * vault.
 *
 * Requires the wallet's own recovery phrase (already on this device) plus the
 * vault passphrase chosen at enrollment. BIP39 passphrases have no checksum,
 * so a typo silently derives a different, valid, empty vault node rather than
 * throwing. v4 vault meta stores no key material to catch that here anymore —
 * the sweep itself catches it instead: every vault output mismatches a wrong
 * key (transfers.ts's prepareSpends), and the resulting
 * VaultError('wrong-key') is mapped below to the passphrase copy the user
 * actually needs to see.
 */
import React, { useCallback, useState } from 'react'
import { View, Text, StyleSheet, TextInput, ScrollView, ActivityIndicator, TouchableOpacity } from 'react-native'
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
import { disableVault, recoverVaultHD } from '@/services/vault/VaultKeyService'
import { sweepVaultWithHD, type VaultWallet } from '@/services/vault/transfers'
import { VaultError } from '@/services/vault/types'
import i18n from '@/context/i18n/translations'

const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, o) as string

export default function VaultRecoverScreen() {
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const { managers, adminOriginator } = useWallet()
  const { getMnemonic } = useLocalStorage()

  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(async () => {
    const pm = managers?.permissionsManager
    if (!pm) return
    setBusy(true)
    setError(null)
    try {
      const mnemonic = await getMnemonic()
      if (!mnemonic) throw new VaultError('bad-mnemonic', t('vault_requires_mnemonic'))
      const hd = await recoverVaultHD(mnemonic, passphrase)
      await sweepVaultWithHD(pm as unknown as VaultWallet, adminOriginator, hd, t('vault_recover_reason'))

      await disableVault()
      haptics.success()
      showToast(t('vault_recovered_toast'), { type: 'success' })
      setPassphrase('')
      router.back()
    } catch (e) {
      const code = e instanceof VaultError ? e.code : undefined
      // The sweep's prepareSpends throws 'wrong-key' when every vault output
      // mismatches the derived key — on this screen that always means the
      // typed passphrase does not match the one this vault was enrolled
      // with (there is no YubiKey involved here to be the "wrong" one), so
      // show the passphrase-specific copy rather than the sweep's own
      // generic wrong-key message.
      const msg =
        code === 'wrong-key'
          ? t('vault_recover_wrong_passphrase')
          : e instanceof VaultError
            ? e.message || t(`vault_err_${e.code.replace(/-/g, '_')}`)
            : t('vault_recover_failed')
      setError(msg)
      haptics.error()
    } finally {
      setBusy(false)
    }
  }, [passphrase, managers?.permissionsManager, adminOriginator, getMnemonic])

  const canRun = passphrase.length > 0

  return (
    <View style={[styles.container, { backgroundColor: colors.backgroundSecondary, paddingTop: insets.top }]}>
      <View style={[styles.header, { borderBottomColor: colors.separator }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn}>
          <Ionicons name="chevron-back" size={24} color={colors.textSecondary} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.textPrimary }]}>{t('vault_recover_title')}</Text>
        <View style={styles.iconBtn} />
      </View>

      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Text style={[styles.sub, { color: colors.textSecondary }]}>{t('vault_recover_sub')}</Text>

        <Text style={[styles.label, { color: colors.textPrimary }]}>{t('vault_recover_passphrase_label')}</Text>
        <Text style={[styles.fine, { color: colors.textSecondary }]}>{t('vault_recover_passphrase_help')}</Text>
        <TextInput
          style={[styles.input, { color: colors.textPrimary, backgroundColor: colors.backgroundElevated }]}
          value={passphrase}
          onChangeText={setPassphrase}
          placeholder={t('vault_recover_passphrase_placeholder')}
          placeholderTextColor={colors.textTertiary}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          secureTextEntry
        />

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
            <Text style={[styles.primaryLabel, { color: canRun ? colors.textOnAccent : colors.textTertiary }]}>
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
  err: { ...typography.footnote },
  primary: {
    borderRadius: radii.md,
    paddingVertical: spacing.lg,
    alignItems: 'center',
    marginTop: spacing.sm
  },
  primaryLabel: { ...typography.headline }
})
