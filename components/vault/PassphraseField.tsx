/**
 * Vault passphrase entry with a live strength meter.
 *
 * Two things this component exists to prevent:
 *
 *  1. A weak passphrase. The vault key comes from the wallet mnemonic plus this
 *     passphrase via BIP39 PBKDF2 at 2048 rounds, so anyone holding the
 *     mnemonic can grind a typeable password in hours. The meter shows the
 *     honest crack time rather than a vague "weak/strong" badge.
 *
 *  2. A typo. BIP39 passphrases carry no checksum, so a mistyped passphrase
 *     silently opens a different, valid, EMPTY vault. Hence the confirm field.
 *
 * Colour discipline: chroma here is STATUS (the meter), never an action. The
 * primary action keeps the achromatic accent fill, per the app's token pairing.
 */
import React, { useMemo, useState } from 'react'
import { View, Text, TextInput, StyleSheet, Pressable } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import * as Clipboard from 'expo-clipboard'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, radii, typography } from '@/context/theme/tokens'
import PressableScale from '@/components/ui/PressableScale'
import { showToast } from '@/components/ui/Toast'
import {
  passphraseStrength,
  generatePassphrase,
  normalizeVaultPassphrase,
  MINIMUM_WORD_COUNT,
  RECOMMENDED_WORD_COUNT,
  type PassphraseTier
} from '@/services/vault/vaultPassphrase'

export interface PassphraseFieldProps {
  value: string
  onChangeText: (v: string) => void
  confirm: string
  onChangeConfirm: (v: string) => void
  /** Called with the normalised passphrase whenever validity changes. */
  onValidityChange?: (ok: boolean) => void
}

/** Meter colour by tier. Status chroma only — never used for actions. */
function tierColor(tier: PassphraseTier, colors: Record<string, string>): string {
  switch (tier) {
    case 'empty':
      return colors.separator
    case 'weak':
      return colors.error
    case 'fair':
      return colors.warning
    default:
      return colors.success
  }
}

const TIER_LABEL: Record<PassphraseTier, string> = {
  empty: '',
  weak: 'Too weak',
  fair: 'Still too weak',
  strong: 'Strong',
  excellent: 'Excellent'
}

export function PassphraseField({
  value,
  onChangeText,
  confirm,
  onChangeConfirm,
  onValidityChange
}: PassphraseFieldProps) {
  const { colors } = useTheme()
  const [reveal, setReveal] = useState(false)

  const strength = useMemo(() => passphraseStrength(value), [value])
  // Compare normalised, so a stray trailing space is not reported as a
  // mismatch when BIP39 would treat both the same after our normalisation.
  const confirmed =
    confirm.length > 0 && normalizeVaultPassphrase(confirm) === normalizeVaultPassphrase(value)
  const mismatch = confirm.length > 0 && !confirmed
  const ok = strength.ok && confirmed

  React.useEffect(() => {
    onValidityChange?.(ok)
  }, [ok, onValidityChange])

  const onGenerate = () => {
    const generated = generatePassphrase()
    onChangeText(generated)
    onChangeConfirm(generated)
    setReveal(true) // they must be able to read what they now have to keep
  }

  const onCopy = async () => {
    await Clipboard.setStringAsync(value)
    showToast('Passphrase copied', { type: 'info' })
  }

  const meterColor = tierColor(strength.tier, colors as unknown as Record<string, string>)

  return (
    <View style={styles.wrap}>
      {/* ── passphrase ─────────────────────────────────────────────── */}
      <View
        style={[
          styles.field,
          { backgroundColor: colors.backgroundElevated, borderColor: colors.separator }
        ]}
      >
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder={`${MINIMUM_WORD_COUNT} or more random words`}
          placeholderTextColor={colors.textTertiary}
          secureTextEntry={!reveal}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          // A password manager offering to save this is fine, but iOS strong-
          // password suggestions would propose a short random string, which is
          // exactly the wrong shape for a 2048-round KDF.
          textContentType="none"
          style={[styles.input, { color: colors.textPrimary }]}
          accessibilityLabel="Vault passphrase"
        />
        <Pressable
          onPress={() => setReveal(r => !r)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={reveal ? 'Hide passphrase' : 'Show passphrase'}
        >
          <Ionicons name={reveal ? 'eye-off' : 'eye'} size={20} color={colors.textSecondary} />
        </Pressable>
      </View>

      {/* ── strength meter ─────────────────────────────────────────── */}
      <View style={styles.meterBlock}>
        <View style={[styles.meterTrack, { backgroundColor: colors.separator }]}>
          <View
            style={[
              styles.meterFill,
              { width: `${Math.round(strength.fraction * 100)}%`, backgroundColor: meterColor }
            ]}
          />
        </View>
        <View style={styles.meterRow}>
          <Text style={[styles.tier, { color: meterColor }]}>{TIER_LABEL[strength.tier]}</Text>
          {value.length > 0 && (
            <Text style={[styles.crack, { color: colors.textSecondary }]} numberOfLines={1}>
              Cracked in {strength.crackTime}
            </Text>
          )}
        </View>
        {value.length > 0 && !strength.ok && strength.reason && (
          <Text style={[styles.hint, { color: colors.textSecondary }]}>{strength.reason}</Text>
        )}
      </View>

      {/* ── generate ───────────────────────────────────────────────── */}
      <View style={styles.genRow}>
        <PressableScale
          haptic="confirm"
          onPress={onGenerate}
          style={[styles.ghost, { borderColor: colors.separator }]}
        >
          <Ionicons name="dice-outline" size={16} color={colors.info} />
          <Text style={[styles.ghostLabel, { color: colors.info }]}>
            Generate {RECOMMENDED_WORD_COUNT} random words
          </Text>
        </PressableScale>
        {value.length > 0 && (
          <PressableScale
            onPress={onCopy}
            style={[styles.ghost, { borderColor: colors.separator }]}
          >
            <Ionicons name="copy-outline" size={16} color={colors.info} />
            <Text style={[styles.ghostLabel, { color: colors.info }]}>Copy</Text>
          </PressableScale>
        )}
      </View>

      {/* ── confirm ────────────────────────────────────────────────── */}
      <View
        style={[
          styles.field,
          {
            backgroundColor: colors.backgroundElevated,
            borderColor: mismatch ? colors.error : colors.separator
          }
        ]}
      >
        <TextInput
          value={confirm}
          onChangeText={onChangeConfirm}
          placeholder="Type it again"
          placeholderTextColor={colors.textTertiary}
          secureTextEntry={!reveal}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          textContentType="none"
          style={[styles.input, { color: colors.textPrimary }]}
          accessibilityLabel="Confirm vault passphrase"
        />
        {confirm.length > 0 && (
          <Ionicons
            name={confirmed ? 'checkmark-circle' : 'close-circle'}
            size={20}
            color={confirmed ? colors.success : colors.error}
          />
        )}
      </View>
      {mismatch && (
        <Text style={[styles.hint, { color: colors.error }]}>
          These do not match. A mistyped passphrase opens a different, empty vault — there is no way
          to detect it later.
        </Text>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.md },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md
  },
  input: { flex: 1, ...typography.body },
  meterBlock: { gap: spacing.xs },
  meterTrack: { height: 4, borderRadius: 2, overflow: 'hidden' },
  meterFill: { height: 4, borderRadius: 2 },
  meterRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  tier: { ...typography.footnote, fontWeight: '600' },
  crack: { ...typography.footnote, flexShrink: 1 },
  hint: { ...typography.footnote },
  genRow: { flexDirection: 'row', gap: spacing.sm },
  ghost: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm
  },
  ghostLabel: { ...typography.footnote, fontWeight: '600' }
})

export default PassphraseField
