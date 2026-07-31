/**
 * Pay — one screen, six cells.
 *
 * Direction is the primary axis because it is the first thing a user knows
 * about their own situation; who the counterparty is comes second, and IT is
 * what determines the rail. The user never picks a transport: see
 * utils/pay/rails/index.ts, where the rail is inferred from how the
 * counterparty was identified.
 *
 * Replaces /payments, /legacy-payments, /local-payments and the Identity Key
 * modal in settings.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { I18nManager, InteractionManager, Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { router, useLocalSearchParams } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTranslation } from 'react-i18next'

import PressableScale from '@/components/ui/PressableScale'
import PayCellRow from '@/components/pay/PayCellRow'
import NearbyFlow from '@/components/pay/NearbyFlow'
import PaymentQrDisplay from '@/components/pay/PaymentQrDisplay'
import HandleSend from '@/components/pay/HandleSend'
import HandleReceive from '@/components/pay/HandleReceive'
import AddressSend from '@/components/pay/AddressSend'
import AddressReceive from '@/components/pay/AddressReceive'
import OfflineNotice from '@/components/pay/OfflineNotice'
import { useTheme } from '@/context/theme/ThemeContext'
import { radii, spacing, typography } from '@/context/theme/tokens'
import { useWallet } from '@/context/WalletContext'
import { useOnline } from '@/hooks/useOnline'
import { validatePeerPayURI } from '@/utils/parsePeerPayURI'
import { isPayCell, type PayCell } from '@/utils/pay/rails'
import { takeProofNudge } from '@/utils/pay/proofNudge'
import { findOfflineActions, type OfflineActionRow } from '@/storage/methods/offlineActions'
import { TaskSendOffline } from '@/utils/monitor/TaskSendOffline'

type Direction = 'pay' | 'get'

const firstParam = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

interface CellSpec {
  cell: PayCell
  titleKey: string
  subtitleKey: string
  icon: keyof typeof Ionicons.glyphMap
}

const CELLS: Record<Direction, CellSpec[]> = {
  pay: [
    {
      cell: 'pay-nearby',
      titleKey: 'pay_cell_nearby_pay',
      subtitleKey: 'pay_cell_nearby_pay_sub',
      icon: 'scan-outline'
    },
    {
      cell: 'pay-handle',
      titleKey: 'pay_cell_handle_pay',
      subtitleKey: 'pay_cell_handle_pay_sub',
      icon: 'person-outline'
    },
    {
      cell: 'pay-address',
      titleKey: 'pay_cell_address_pay',
      subtitleKey: 'pay_cell_address_pay_sub',
      icon: 'wallet-outline'
    }
  ],
  get: [
    {
      cell: 'get-nearby',
      titleKey: 'pay_cell_nearby_get',
      subtitleKey: 'pay_cell_nearby_get_sub',
      icon: 'qr-code-outline'
    },
    {
      cell: 'get-handle',
      titleKey: 'pay_cell_handle_get',
      subtitleKey: 'pay_cell_handle_get_sub',
      icon: 'person-outline'
    },
    {
      cell: 'get-address',
      titleKey: 'pay_cell_address_get',
      subtitleKey: 'pay_cell_address_get_sub',
      icon: 'wallet-outline'
    }
  ]
}

const CELL_TITLE_KEYS: Record<PayCell, string> = {
  'pay-nearby': 'pay_cell_nearby_pay',
  'pay-handle': 'pay_cell_handle_pay',
  'pay-address': 'pay_cell_address_pay',
  'get-nearby': 'pay_cell_nearby_get',
  'get-handle': 'pay_cell_handle_get',
  'get-address': 'pay_cell_address_get'
}

export default function PayScreen() {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const online = useOnline()
  const { walletBuilding, walletBuilt, storage, txStatusVersion, walletUserId, runMonitorTask } = useWallet()
  const [queued, setQueued] = useState(0)
  const [rejected, setRejected] = useState<OfflineActionRow[]>([])
  const [sentRejected, setSentRejected] = useState<OfflineActionRow[]>([])
  const [queuedSentRows, setQueuedSentRows] = useState<OfflineActionRow[]>([])
  const [stalled, setStalled] = useState<string | undefined>(undefined)
  const [showCode, setShowCode] = useState<OfflineActionRow | null>(null)

  const params = useLocalSearchParams<{
    cell?: string | string[]
    identityKey?: string | string[]
    sats?: string | string[]
    peerpay?: string | string[]
  }>()

  const peerpay = firstParam(params.peerpay)
  const peerPayValidation = useMemo(() => (peerpay ? validatePeerPayURI(peerpay) : null), [peerpay])
  const peerPayNotice = useMemo(() => {
    if (!peerPayValidation) return null
    const messages = [peerPayValidation.errors.identityKey, peerPayValidation.errors.sats].filter(Boolean)
    return messages.length ? messages.join('. ') : null
  }, [peerPayValidation])

  const initialIdentityKey = peerPayValidation?.identityKey ?? firstParam(params.identityKey)
  const satsParam = peerPayValidation?.sats ?? Number(firstParam(params.sats))
  const initialSats = Number.isFinite(satsParam) && satsParam > 0 ? Number(satsParam) : undefined

  const paramCell = firstParam(params.cell)
  // A peerpay link is a request to pay a handle, whatever cell was named.
  const openingCell: PayCell | null = peerpay ? 'pay-handle' : isPayCell(paramCell) ? paramCell : null

  const [direction, setDirection] = useState<Direction>(openingCell?.startsWith('get') ? 'get' : 'pay')
  const [cell, setCell] = useState<PayCell | null>(openingCell)

  // Refreshed whenever the wallet finishes building, connectivity changes, or
  // the user enters/leaves a pay cell: the queue only moves when the network
  // state does or when a cell just queued a row (e.g. an in-session offline
  // QR Done), so there is no need to poll it on every render. `cell` is a
  // cheap local SQLite read, not a network round-trip, so re-running it on
  // every cell transition is fine — returning from a pay cell must pick up
  // rows the cell just queued.
  useEffect(() => {
    if (!walletBuilt) return
    let cancelled = false
    void (async () => {
      try {
        const db = storage?.sqliteDb
        if (!db) return
        const rows = await findOfflineActions(db, {
          status: ['queued', 'posting', 'rejected'],
          ...(walletUserId === null ? {} : { userId: walletUserId })
        })
        if (cancelled) return
        setQueued(rows.filter(r => r.status !== 'rejected').length)
        // 'sent'-role rows can be rejected too (a payer's own held payment can be
        // poisoned), but they carry no senderIdentityKey or receivedVia — those
        // are only ever recorded on the receiving side (see
        // storage/StorageExpoSQLite.ts's holdReqsOffline, and
        // utils/localpay/pending.ts's processPending, which backfills them
        // after the fact). Showing one through OfflineNotice's "who handed you
        // this" copy would misreport the user's own failed payment as someone
        // else's fraud against them, so it gets its own unattributed notice.
        setRejected(rows.filter(r => r.status === 'rejected' && r.role === 'received'))
        setSentRejected(rows.filter(r => r.status === 'rejected' && r.role === 'sent'))
        setQueuedSentRows(rows.filter(r => r.status !== 'rejected' && r.role === 'sent'))
        setStalled(TaskSendOffline.lastStall)
      } catch {
        // This banner is advisory, never load-bearing. A read failure here must
        // not break the rest of the screen — the grid still has to render.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [walletBuilt, storage, online, txStatusVersion, walletUserId, cell])

  // Auth failed while this screen was open (the wallet finished building and
  // there is no wallet) — same guard the old payments screen carried.
  const prevBuilding = React.useRef(walletBuilding)
  useEffect(() => {
    const wasBuilding = prevBuilding.current
    prevBuilding.current = walletBuilding
    if (wasBuilding && !walletBuilding && !walletBuilt) {
      if (router.canGoBack()) router.back()
      else router.replace('/')
    }
  }, [walletBuilding, walletBuilt])

  // One deferred proof sweep per visit (10-min gated): see utils/pay/proofNudge.ts.
  useEffect(() => {
    if (!online) return
    const task = InteractionManager.runAfterInteractions(() => {
      if (!takeProofNudge(Date.now())) return
      runMonitorTask('CheckForProofs').catch(() => {
        // Best-effort by design: a failed sweep leaves the 2h background
        // trigger as the backstop, and must never surface on this screen.
      })
    })
    return () => task.cancel()
  }, [online, runMonitorTask])

  const goBack = useCallback(() => {
    if (cell) setCell(null)
    else if (router.canGoBack()) router.back()
    else router.replace('/')
  }, [cell])

  const grid = () => (
    <View style={styles.grid}>
      <OfflineNotice
        online={online}
        queued={queued}
        rejected={rejected}
        sentRejected={sentRejected}
        onSendNow={() => TaskSendOffline.requestNow()}
        stalled={stalled}
        queuedSent={queuedSentRows}
        onShowCode={setShowCode}
      />
      {/* Direction first: it is what the user already knows. */}
      <View style={[styles.segment, { backgroundColor: colors.fillTertiary }]}>
        {(['pay', 'get'] as const).map(d => {
          const active = direction === d
          return (
            <PressableScale
              key={d}
              onPress={() => setDirection(d)}
              haptic="tap"
              scaleTo={0.98}
              style={[styles.segmentBtn, active && { backgroundColor: colors.background }]}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={t(d === 'pay' ? 'pay_direction_pay' : 'pay_direction_receive')}
            >
              <Text style={[styles.segmentLabel, { color: active ? colors.textPrimary : colors.textTertiary }]}>
                {t(d === 'pay' ? 'pay_direction_pay' : 'pay_direction_receive')}
              </Text>
            </PressableScale>
          )
        })}
      </View>

      <View style={styles.rows}>
        {CELLS[direction].map(spec => {
          // Handle needs a message box round-trip and address needs an overlay
          // lookup; neither works underground. Nearby is the whole point of
          // being offline — it is the one rail this whole feature was built for.
          const needsInternet = !spec.cell.endsWith('nearby')
          const disabled = !online && needsInternet
          return (
            <PayCellRow
              key={spec.cell}
              title={t(spec.titleKey)}
              subtitle={disabled ? t('pay_offline_needs_internet') : t(spec.subtitleKey)}
              icon={spec.icon}
              disabled={disabled}
              onPress={() => setCell(spec.cell)}
            />
          )
        })}
      </View>
    </View>
  )

  const body = () => {
    switch (cell) {
      case 'pay-nearby':
        return <NearbyFlow role="payer" onExit={() => setCell(null)} />
      case 'get-nearby':
        return <NearbyFlow role="payee" onExit={() => setCell(null)} />
      case 'pay-handle':
        return (
          <HandleSend initialIdentityKey={initialIdentityKey} initialSats={initialSats} initialNotice={peerPayNotice} />
        )
      case 'get-handle':
        return <HandleReceive />
      case 'pay-address':
        return <AddressSend />
      case 'get-address':
        return <AddressReceive />
      default:
        return grid()
    }
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.backgroundSecondary, paddingTop: insets.top }]}>
      <View style={[styles.header, { borderBottomColor: colors.separator }]}>
        <PressableScale
          onPress={goBack}
          haptic="tap"
          style={styles.headerBtn}
          accessibilityRole="button"
          accessibilityLabel={t('go_back')}
        >
          <Ionicons name={I18nManager.isRTL ? 'chevron-forward' : 'chevron-back'} size={24} color={colors.accent} />
        </PressableScale>
        <Text style={[styles.headerTitle, { color: colors.textPrimary }]} numberOfLines={1}>
          {/* The screen is Payments; `pay` is the direction tab and the CTA. */}
          {cell ? t(CELL_TITLE_KEYS[cell]) : t('payments')}
        </Text>
        <View style={styles.headerBtn} />
      </View>
      {/* The grid sits on the secondary background so its elevated rows read as
          cards — on `background` they would be white-on-white in light mode and
          separated by a hairline alone. A cell body is a form, not a card list,
          so it gets the plain background the rest of the app's forms use. */}
      <View style={[styles.bodyWrap, { backgroundColor: cell ? colors.background : colors.backgroundSecondary }]}>
        {body()}
      </View>
      <Modal visible={!!showCode} animationType="slide" transparent onRequestClose={() => setShowCode(null)}>
        <View style={styles.codeOverlay}>
          <View style={[styles.codeCard, { backgroundColor: colors.backgroundElevated }]}>
            {showCode?.framePayload ? (
              <PaymentQrDisplay frameQr={showCode.framePayload} size={288} />
            ) : (
              <Text style={{ color: colors.textSecondary }}>{t('local_pay_too_large')}</Text>
            )}
            <TouchableOpacity onPress={() => setShowCode(null)} style={styles.codeClose}>
              <Text style={{ color: colors.info }}>{t('done')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
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
  headerBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { ...typography.headline, fontWeight: '600', flex: 1, textAlign: 'center' },
  bodyWrap: { flex: 1 },
  grid: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg },
  segment: { flexDirection: 'row', borderRadius: radii.xl, padding: 2, marginBottom: spacing.xl },
  segmentBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.sm + 2,
    borderRadius: radii.xl - 2
  },
  segmentLabel: { ...typography.subhead, fontWeight: '500' },
  rows: { gap: spacing.md },
  codeOverlay: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)'
  },
  codeCard: {
    padding: spacing.xl,
    borderRadius: 16,
    alignItems: 'center',
    gap: spacing.lg
  },
  codeClose: { padding: spacing.md }
})
