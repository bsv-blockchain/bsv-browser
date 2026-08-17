/**
 * One row of the wallet's activity list.
 *
 * Reading order is direction → what it was → how much, then status and time
 * underneath. The per-transaction utilities (explorer, BEEF, txid, refresh,
 * cancel) are NOT on the row: they used to sit permanently on the right, four
 * icons deep, which made every row look equally busy whether or not anything
 * needed doing. They now live behind a tap, and the expanded row lifts onto its
 * own surface so it is obvious which transaction the chips belong to.
 */
import React, { memo, useContext } from 'react'
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native'
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons'
import { useTranslation } from 'react-i18next'
import type { WalletAction } from '@bsv/sdk'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, radii } from '@/context/theme/tokens'
import { useWallet } from '@/context/WalletContext'
import { ExchangeRateContext } from '@/context/ExchangeRateContext'
import { formatAmount, formatAmountParts } from '@/utils/amountFormatHelpers'
import { txStatusView, toneColor } from '@/utils/txStatus'
import PressableScale from '@/components/ui/PressableScale'

/** A row as storage actually returns it: `reference` and `created_at` are real
 * columns the SDK's WalletAction type does not declare. */
export type ActivityAction = WalletAction & {
  reference?: string
  created_at?: string | number | Date
}

interface Props {
  action: ActivityAction
  /** Identity of this row in the list's expanded/busy bookkeeping. Passed back
   * to `onToggle` so the handler can stay referentially stable across renders —
   * an inline closure here would defeat the memo below on every poll. */
  rowKey: string
  /** Live offline-queue state for this txid, when it has one. */
  offlineStatus?: string
  expanded: boolean
  busy: boolean
  onToggle: (rowKey: string) => void
  onExplorer: (txid: string) => void
  onCopyBeef: (txid: string) => void
  onCopyTxid: (txid: string) => void
  onRefreshTx: (txid: string) => void
  onAbort: (reference: string) => void
}

/** Statuses whose transaction is still local and therefore abortable: nothing
 * has been (successfully) broadcast, so releasing it is safe and frees the
 * inputs it reserved. `failed` is included because a failed action still holds
 * its input reservations until it is cleared. */
const ABORTABLE_STATUSES = new Set(['unsigned', 'nosend', 'nonfinal', 'failed'])

/** Local time of day, e.g. "14:32". Empty when storage gave us no timestamp. */
export function formatRowTime(value?: string | number | Date): string {
  if (value === undefined || value === null) return ''
  const d = new Date(value as string)
  if (Number.isNaN(d.getTime())) return ''
  try {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  } catch {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
}

function ActivityRowBase({
  action,
  rowKey,
  offlineStatus,
  expanded,
  busy,
  onToggle,
  onExplorer,
  onCopyBeef,
  onCopyTxid,
  onRefreshTx,
  onAbort
}: Props) {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const { settings } = useWallet()
  const { satoshisPerUSD } = useContext(ExchangeRateContext)

  const currency = settings?.currency || 'BSV'
  const view = txStatusView(action.status, offlineStatus)
  const settled = view.tone === 'settled'
  const tone = toneColor(view.tone, colors as unknown as Record<string, string>)
  const incoming = action.satoshis >= 0

  const { value, unit } = formatAmountParts(action.satoshis, currency, satoshisPerUSD, {
    abbreviate: true,
    showPlus: true
  })
  // The second denomination — the one the user is NOT currently displaying. It
  // is the answer to "yes, but how much is that really", which is the whole
  // reason a sats-denominated wallet needs a fiat line at all.
  const secondary = formatAmount(action.satoshis, currency === 'USD' ? 'BSV' : 'USD', satoshisPerUSD, {
    abbreviate: true,
    showPlus: true
  })

  const time = formatRowTime(action.created_at)
  const amountColor = incoming ? colors.successAmount : colors.textPrimary
  const unitColor = incoming ? colors.successAmount : colors.textSecondary

  const canAbort = ABORTABLE_STATUSES.has(action.status) && !!action.reference
  const hasUtilities = !!action.txid || canAbort

  return (
    <View
      style={[
        expanded && {
          backgroundColor: colors.surfaceRowExpanded,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderColor: colors.hairline
        }
      ]}
    >
      <PressableScale
        scaleTo={0.99}
        onPress={hasUtilities ? () => onToggle(rowKey) : undefined}
        style={styles.row}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={action.description || t('transactions')}
      >
        <View
          style={[
            styles.glyph,
            incoming
              ? {
                  backgroundColor: colors.successStrong + '1A',
                  borderColor: colors.successStrong + '2E'
                }
              : { backgroundColor: colors.surfaceSunken, borderColor: colors.surfaceSunkenBorder }
          ]}
        >
          <MaterialCommunityIcons
            name={incoming ? 'arrow-bottom-left' : 'arrow-top-right'}
            size={16}
            color={incoming ? colors.successStrong : colors.textSecondary}
          />
        </View>

        <View style={styles.middle}>
          <Text style={[styles.description, { color: colors.textPrimary }]} numberOfLines={1}>
            {action.description || t('transactions')}
          </Text>
          <View style={styles.statusLine}>
            <View
              style={[
                styles.dot,
                { backgroundColor: settled ? colors.successStrong : tone }
              ]}
            />
            <Text
              style={[styles.statusText, { color: settled ? colors.textSecondary : tone }]}
              numberOfLines={1}
            >
              {time ? `${t(view.key)} · ${time}` : t(view.key)}
            </Text>
          </View>
        </View>

        <View style={styles.amounts}>
          <Text style={[styles.amount, { color: amountColor }]}>
            {value}
            {unit ? <Text style={[styles.amountUnit, { color: unitColor }]}> {unit}</Text> : null}
          </Text>
          <Text style={[styles.amountSecondary, { color: colors.textTertiary }]}>{secondary}</Text>
        </View>
      </PressableScale>

      {expanded && hasUtilities ? (
        <View style={styles.chips}>
          {busy ? (
            <ActivityIndicator size="small" color={colors.textSecondary} style={styles.chipBusy} />
          ) : (
            <>
              {action.txid ? (
                <Chip
                  icon="refresh-outline"
                  label={t('tx_action_refresh_short')}
                  accessibilityLabel={t('tx_action_refresh')}
                  onPress={() => onRefreshTx(action.txid)}
                />
              ) : null}
              {action.txid ? (
                <Chip
                  icon="copy-outline"
                  label="BEEF"
                  accessibilityLabel={t('tx_action_copy_beef')}
                  onPress={() => onCopyBeef(action.txid)}
                />
              ) : null}
              {action.txid ? (
                <Chip
                  icon="link-outline"
                  label="WoC"
                  accessibilityLabel={t('tx_action_explorer')}
                  onPress={() => onExplorer(action.txid)}
                />
              ) : null}
              {action.txid ? (
                <Chip
                  icon="copy-outline"
                  label="TXID"
                  accessibilityLabel={t('tx_action_copy_txid')}
                  onPress={() => onCopyTxid(action.txid)}
                />
              ) : null}
              {canAbort ? (
                <Chip
                  icon="close-circle-outline"
                  label={t('cancel')}
                  accessibilityLabel={t('tx_action_abort')}
                  danger
                  onPress={() => onAbort(action.reference!)}
                />
              ) : null}
            </>
          )}
        </View>
      ) : null}

      {/* Inset to the description, not the screen edge: the rule separates the
          text columns, and the glyph tiles already read as separate objects. An
          expanded row is bounded by its own surface, so it needs no rule. */}
      {expanded ? null : (
        <View style={[styles.separator, { backgroundColor: colors.hairline }]} />
      )}
    </View>
  )
}

function Chip({
  icon,
  label,
  accessibilityLabel,
  onPress,
  danger
}: {
  icon: keyof typeof Ionicons.glyphMap
  label: string
  accessibilityLabel: string
  onPress: () => void
  danger?: boolean
}) {
  const { colors } = useTheme()
  const color = danger ? colors.error : colors.textSecondary
  return (
    <PressableScale
      onPress={onPress}
      haptic="tap"
      style={[
        styles.chip,
        { backgroundColor: colors.surfaceRaised, borderColor: colors.surfaceRaisedBorder }
      ]}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
    >
      <Ionicons name={icon} size={12} color={color} />
      <Text style={[styles.chipLabel, { color }]}>{label}</Text>
    </PressableScale>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingTop: 13,
    paddingBottom: 11
  },
  glyph: {
    width: 38,
    height: 38,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center'
  },
  middle: { flex: 1, minWidth: 0 },
  // 14.5/500 rather than body 17/400: the row is scanned, not read, and at 17pt
  // the description crowds the amount on narrow phones.
  description: { fontSize: 14.5, fontWeight: '500', letterSpacing: -0.1, lineHeight: 19 },
  statusLine: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 },
  dot: { width: 5, height: 5, borderRadius: 2.5 },
  statusText: { fontSize: 12, lineHeight: 16, flexShrink: 1 },
  amounts: { alignItems: 'flex-end' },
  amount: { fontSize: 14.5, fontWeight: '600', lineHeight: 19, fontVariant: ['tabular-nums'] },
  amountUnit: { fontSize: 12, fontWeight: '500' },
  amountSecondary: { fontSize: 11.5, lineHeight: 15, marginTop: 2, fontVariant: ['tabular-nums'] },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    paddingLeft: 70, // aligns the chip row with the description, past the glyph
    paddingRight: spacing.xl,
    paddingTop: 2,
    paddingBottom: 14
  },
  chipBusy: { marginBottom: 8 },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 70 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth
  },
  chipLabel: { fontSize: 12, fontWeight: '600' }
})

/** Rows are re-rendered only when something they actually show changes — the
 * list re-renders on every status poll, and there can be hundreds of them. */
export default memo(ActivityRowBase, (a, b) =>
  a.action === b.action &&
  a.rowKey === b.rowKey &&
  a.offlineStatus === b.offlineStatus &&
  a.expanded === b.expanded &&
  a.busy === b.busy &&
  a.onToggle === b.onToggle
)
