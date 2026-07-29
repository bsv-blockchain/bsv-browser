/**
 * Two things the user must be told, in one place.
 *
 * While offline: which rails still work and how many payments are waiting to be
 * broadcast. After a rejection: which payment the network refused and who
 * handed it over — that identity key is the only recourse the user has, so the
 * row persists rather than toasting away.
 *
 * It never claims settlement. A payment nobody has broadcast can still be
 * double-spent by the payer once they reconnect; no header check closes that,
 * so the copy says "not yet broadcast", never "received".
 */
import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useTranslation } from 'react-i18next'
import { useTheme } from '@/context/theme/ThemeContext'
import { radii, spacing, typography } from '@/context/theme/tokens'
import type { OfflineActionRow } from '@/storage/methods/offlineActions'

export interface OfflineNoticeProps {
  online: boolean
  queued: number
  rejected: OfflineActionRow[]
}

export default function OfflineNotice({ online, queued, rejected }: OfflineNoticeProps) {
  const { t } = useTranslation()
  const { colors } = useTheme()
  if (online && rejected.length === 0) return null

  return (
    <View style={styles.wrap}>
      {!online && (
        <View style={[styles.card, { backgroundColor: colors.fillTertiary, borderColor: colors.separator }]}>
          <Ionicons name="cloud-offline-outline" size={18} color={colors.textSecondary} />
          <View style={styles.text}>
            <Text style={[styles.title, { color: colors.textPrimary }]}>{t('pay_offline_title')}</Text>
            <Text style={[styles.body, { color: colors.textSecondary }]}>
              {queued > 0 ? t('pay_offline_queued', { count: queued }) : t('pay_offline_body')}
            </Text>
          </View>
        </View>
      )}
      {rejected.map(r => (
        <View
          key={r.txid}
          style={[styles.card, { backgroundColor: colors.fillTertiary, borderColor: colors.separator }]}
        >
          <Ionicons name="alert-circle-outline" size={18} color={colors.textSecondary} />
          <View style={styles.text}>
            <Text style={[styles.title, { color: colors.textPrimary }]}>{t('pay_offline_rejected_title')}</Text>
            <Text style={[styles.body, { color: colors.textSecondary }]}>
              {t('pay_offline_rejected_body', {
                sender: r.senderIdentityKey ? `${r.senderIdentityKey.slice(0, 8)}…` : t('pay_offline_unknown_sender'),
                // Unlike the sender, a missing transport isn't worth a translated
                // phrase of its own — 'awdl'/'qr' are left untranslated elsewhere
                // in this file (see local_pay_nearby_unavailable's "Wi-Fi"), and
                // this mirrors the same plain-'unknown' fallback processOfflineActions.ts
                // already uses for this exact field.
                via: r.receivedVia ?? 'unknown',
                when: r.created_at.slice(0, 10)
              })}
            </Text>
          </View>
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  // No horizontal padding: this mounts inside the grid, which already supplies
  // spacing.lg on both sides. Adding it here would double-indent the cards
  // relative to the cell rows below them.
  wrap: { paddingBottom: spacing.md, gap: spacing.sm },
  card: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth
  },
  text: { flex: 1, gap: 2 },
  title: { ...typography.subhead, fontWeight: '600' },
  body: { ...typography.footnote }
})
