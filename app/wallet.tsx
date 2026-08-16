/**
 * The Wallet screen — full screen, not a drawer.
 *
 * Structure, top to bottom:
 *   balance  →  Payments / Vault / Settings  →  recent activity (inline)
 *
 * This replaces a bottom-sheet settings menu plus a separate Transactions
 * route. Activity now sits on the screen the user already opens to check their
 * money, so "did that payment go through?" costs one tap instead of two.
 *
 * Colour discipline: `colors.accent` is achromatic (black/white) in this token
 * set, so it only reads as emphasis when used as a FILL. Exactly one element
 * here is accent-filled — Payments — and chroma elsewhere is reserved for
 * transaction status, never for decoration.
 */
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  type ListRenderItem
} from 'react-native'
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons'
import { router } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTranslation } from 'react-i18next'
import AsyncStorage from '@react-native-async-storage/async-storage'
import Clipboard from '@react-native-clipboard/clipboard'
import { Utils, type WalletAction } from '@bsv/sdk'
import { sdk } from '@bsv/wallet-toolbox-mobile'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, radii, typography } from '@/context/theme/tokens'
import { useWallet } from '@/context/WalletContext'
import AmountDisplay from '@/components/wallet/AmountDisplay'
import PressableScale from '@/components/ui/PressableScale'
import { showToast } from '@/components/ui/Toast'
import { exportTransactionsAsCsv } from '@/utils/exportTransactions'
import { findOfflineActions, type OfflineActionRow } from '@/storage/methods/offlineActions'
import { txStatusView, toneColor, tonePill } from '@/utils/txStatus'
import tabStore from '@/stores/TabStore'
import WalletLockNotice from '@/components/security/WalletLockNotice'

const PAGE_SIZE = 30

/** Statuses whose transaction is still local and therefore abortable: nothing
 * has been (successfully) broadcast, so releasing it is safe and frees the
 * inputs it reserved. `failed` is included because a failed action still holds
 * its input reservations until it is cleared. */
const ABORTABLE_STATUSES = new Set(['unsigned', 'nosend', 'nonfinal', 'failed'])

export default function WalletScreen() {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const {
    managers,
    adminOriginator,
    selectedNetwork,
    storage,
    txStatusVersion,
    walletUserId,
    refreshProof
  } = useWallet()

  const balanceCacheKey = `cached_wallet_balance_${selectedNetwork}`
  const [balance, setBalance] = useState<number | null>(null)
  const [actions, setActions] = useState<WalletAction[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [offlineByTxid, setOfflineByTxid] = useState<Map<string, OfflineActionRow>>(new Map())
  // Per-row in-flight action, keyed by txid (or reference for abort) so only
  // the tapped row shows a spinner rather than the whole list.
  const [busyRow, setBusyRow] = useState<string | null>(null)
  const offsetRef = useRef(0)
  /** Set once the server has no more rows, so onEndReached stops re-querying at
   * the bottom of the list. Cleared whenever the list is refetched from 0. */
  const exhaustedRef = useRef(false)
  /** Synchronous in-flight latch for loadMore (state updates are async). */
  const inFlightRef = useRef(false)

  // ── balance ─────────────────────────────────────────────────────────
  const refreshBalance = useCallback(async () => {
    if (!managers.permissionsManager) return
    try {
      const { totalOutputs } = await managers.permissionsManager.listOutputs(
        { basket: sdk.specOpWalletBalance },
        adminOriginator
      )
      const total = totalOutputs ?? 0
      setBalance(total)
      await AsyncStorage.setItem(balanceCacheKey, String(total))
    } catch {
      // Keep the last known balance on screen rather than blanking it.
    }
  }, [managers.permissionsManager, adminOriginator, balanceCacheKey])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      // Show the cached figure immediately so the screen never opens empty.
      const cached = await AsyncStorage.getItem(balanceCacheKey)
      if (!cancelled && cached != null) setBalance(Number(cached))
      await refreshBalance()
    })()
    return () => {
      cancelled = true
    }
  }, [refreshBalance, balanceCacheKey])

  // ── activity ────────────────────────────────────────────────────────
  const fetchActions = useCallback(
    async (offset: number) => {
      if (!managers.permissionsManager) return null
      return managers.permissionsManager.listActions(
        { labels: [], limit: PAGE_SIZE, offset },
        adminOriginator
      )
    },
    [managers.permissionsManager, adminOriginator]
  )

  const fetchOfflineRows = useCallback(async () => {
    try {
      const db = storage?.sqliteDb
      if (!db) return
      const rows = await findOfflineActions(db, {
        status: ['queued', 'posting', 'rejected'],
        ...(walletUserId === null ? {} : { userId: walletUserId })
      })
      setOfflineByTxid(new Map(rows.map(r => [r.txid, r])))
    } catch {
      // Advisory overlay only — a read failure must not break the list.
    }
  }, [storage, walletUserId])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (actions.length === 0) setLoading(true)
      const result = await fetchActions(0)
      if (cancelled || !result) return
      setActions(result.actions)
      offsetRef.current = result.actions.length
      // A fresh first page may have more behind it again.
      exhaustedRef.current =
        result.actions.length < PAGE_SIZE || result.actions.length >= (result.totalActions ?? 0)
      setLoading(false)
    })()
    void fetchOfflineRows()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchActions, txStatusVersion, fetchOfflineRows])

  const loadMore = useCallback(async () => {
    // Three guards, all load-bearing:
    //  - exhaustedRef: without it, reaching the bottom fires onEndReached
    //    forever — each pass runs a real listActions query, returns nothing, and
    //    the footer swapping between spinner and spacer changes content height,
    //    which makes FlatList re-evaluate and fire again. That is a tight loop.
    //  - inFlightRef: `loadingMore` is state, so two onEndReached calls in the
    //    same tick would both read the stale `false` and double-fetch.
    //  - loading: the first page is still landing; its result sets the offset.
    if (exhaustedRef.current || inFlightRef.current || loading) return
    inFlightRef.current = true
    setLoadingMore(true)
    try {
      const result = await fetchActions(offsetRef.current)
      const page = result?.actions ?? []
      if (page.length) {
        setActions(prev => [...prev, ...page])
        offsetRef.current += page.length
      }
      // A short page means the end; so does reaching the reported total.
      if (page.length < PAGE_SIZE || offsetRef.current >= (result?.totalActions ?? 0)) {
        exhaustedRef.current = true
      }
    } finally {
      inFlightRef.current = false
      setLoadingMore(false)
    }
  }, [fetchActions, loading])

  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      const [result] = await Promise.all([fetchActions(0), refreshBalance(), fetchOfflineRows()])
      if (result) {
        setActions(result.actions)
        offsetRef.current = result.actions.length
        exhaustedRef.current =
          result.actions.length < PAGE_SIZE || result.actions.length >= (result.totalActions ?? 0)
      }
    } finally {
      setRefreshing(false)
    }
  }, [fetchActions, refreshBalance, fetchOfflineRows])

  const onExport = useCallback(async () => {
    if (exporting || actions.length === 0 || !managers.permissionsManager) return
    setExporting(true)
    try {
      const count = await exportTransactionsAsCsv(
        managers.permissionsManager,
        storage,
        adminOriginator
      )
      if (count === 0) showToast(t('no_transactions'), { type: 'info' })
    } catch {
      showToast(t('tx_export_failed'), { type: 'error' })
    } finally {
      setExporting(false)
    }
  }, [exporting, actions.length, managers.permissionsManager, storage, adminOriginator, t])

  // ── per-row actions ──────────────────────────────────────────────────

  /** Open the transaction on a block explorer, in the browser tab the user
   * already has. */
  const onExplorer = useCallback(
    (txid: string) => {
      const base =
        selectedNetwork === 'main'
          ? 'https://whatsonchain.com'
          : selectedNetwork === 'teratest'
            ? 'https://woc-ttn.bsvblockchain.tech'
            : 'https://test.whatsonchain.com'
      tabStore.updateTab(tabStore.activeTabId, { url: `${base}/tx/${txid}` })
      // Return to the live Browser screen rather than push('/'), which would
      // stack a SECOND Browser on top of the running one (native-stack keeps
      // both mounted → two concurrent WebView hosts).
      if (router.canGoBack()) router.back()
      else router.replace('/')
    },
    [selectedNetwork]
  )

  /** Copy the transaction's full BEEF (raw tx + the proofs/ancestry that make
   * it independently verifiable) as hex — what you paste into a tool or hand to
   * support, unlike a bare txid. */
  const onCopyBeef = useCallback(
    async (txid: string) => {
      if (!storage || busyRow) return
      setBusyRow(txid)
      try {
        const beef = await storage.getValidBeefForKnownTxid(txid)
        Clipboard.setString(Utils.toHex(beef.toBinary()))
        showToast(t('tx_beef_copied'), { type: 'success' })
      } catch {
        // Falls here when the BEEF cannot be assembled (e.g. ancestry not yet
        // known for a still-unconfirmed tx) — not a crash, just unavailable.
        showToast(t('tx_beef_not_available'), { type: 'error' })
      } finally {
        setBusyRow(null)
      }
    },
    [storage, busyRow, t]
  )

  /** Reconcile this one transaction against the network now, rather than
   * waiting for the background monitor's next sweep. It either confirms it,
   * leaves it alone as genuinely in-flight, or — when the network does not have
   * it and the local record is stale — marks it failed and frees the inputs it
   * was holding. refreshProof bumps txStatusVersion on any change, which
   * re-runs the list fetch, so there is nothing to refetch here. */
  const onRefreshTx = useCallback(
    async (txid: string) => {
      if (busyRow) return
      setBusyRow(txid)
      try {
        const outcome = await refreshProof(txid)
        if (outcome === 'confirmed') showToast(t('tx_proof_refreshed'), { type: 'success' })
        else if (outcome === 'failed') showToast(t('tx_marked_failed'), { type: 'info' })
        else showToast(t('tx_still_pending'), { type: 'info' })
      } catch {
        showToast(t('tx_proof_refresh_failed'), { type: 'error' })
      } finally {
        setBusyRow(null)
      }
    },
    [busyRow, refreshProof, t]
  )

  /** Abort a still-local transaction, releasing the inputs it reserved. */
  const onAbort = useCallback(
    async (reference: string) => {
      if (!managers.permissionsManager || busyRow) return
      setBusyRow(reference)
      try {
        await managers.permissionsManager.abortAction({ reference }, adminOriginator)
        showToast(t('tx_abort_success'), { type: 'success' })
        await onRefresh()
      } catch {
        showToast(t('tx_abort_failed'), { type: 'error' })
      } finally {
        setBusyRow(null)
      }
    },
    [managers.permissionsManager, adminOriginator, busyRow, onRefresh, t]
  )

  // ── rows ────────────────────────────────────────────────────────────
  const renderItem: ListRenderItem<WalletAction> = useCallback(
    ({ item }) => {
      const offline = item.txid ? offlineByTxid.get(item.txid) : undefined
      const view = txStatusView(item.status, offline?.status)
      const color = toneColor(view.tone, colors as unknown as Record<string, string>)
      const boxed = tonePill(view.tone)

      // `reference` is what abortAction takes; the SDK's WalletAction type does
      // not declare it, but storage returns it.
      const reference = (item as unknown as { reference?: string }).reference
      const canAbort = ABORTABLE_STATUSES.has(item.status) && !!reference
      const busy = busyRow === item.txid || (!!reference && busyRow === reference)

      return (
        <View style={[styles.row, { borderBottomColor: colors.separator }]}>
          {/* Line 1: what it was, and how much. */}
          <View style={styles.rowTop}>
            <Text
              style={[styles.description, { color: colors.textPrimary }]}
              numberOfLines={1}
            >
              {item.description || t('transactions')}
            </Text>
            <Text
              style={[
                styles.amount,
                { color: item.satoshis < 0 ? colors.textPrimary : colors.success }
              ]}
            >
              <AmountDisplay>{item.satoshis}</AmountDisplay>
            </Text>
          </View>

          {/* Line 2: status on the left, actions right-justified under the
              amount. Icon-only and low-chroma so they never compete with the
              status colour, which is the one signal that matters. */}
          <View style={styles.rowBottom}>
            {boxed ? (
              <View style={[styles.pill, { backgroundColor: color + '20' }]}>
                <Text style={[styles.pillText, { color }]}>{t(view.key)}</Text>
              </View>
            ) : (
              <Text style={[styles.quietStatus, { color }]}>{t(view.key)}</Text>
            )}
            <View style={styles.rowActions}>
            {busy ? (
              <ActivityIndicator size="small" color={colors.textSecondary} style={styles.rowAction} />
            ) : (
              <>
                {item.txid && (
                  <TouchableOpacity
                    onPress={() => onExplorer(item.txid)}
                    style={styles.rowAction}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={t('tx_action_explorer')}
                  >
                    <Ionicons name="link-outline" size={18} color={colors.textSecondary} />
                  </TouchableOpacity>
                )}
                {item.txid && (
                  <TouchableOpacity
                    onPress={() => onCopyBeef(item.txid)}
                    style={styles.rowAction}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={t('tx_action_copy_beef')}
                  >
                    <Ionicons name="copy-outline" size={18} color={colors.textSecondary} />
                  </TouchableOpacity>
                )}
                {item.txid && (
                  <TouchableOpacity
                    onPress={() => onRefreshTx(item.txid)}
                    style={styles.rowAction}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={t('tx_action_refresh')}
                  >
                    <Ionicons name="refresh-outline" size={18} color={colors.textSecondary} />
                  </TouchableOpacity>
                )}
                {canAbort && (
                  <TouchableOpacity
                    onPress={() => onAbort(reference)}
                    style={styles.rowAction}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={t('tx_action_abort')}
                  >
                    <Ionicons name="close-circle-outline" size={18} color={colors.error} />
                  </TouchableOpacity>
                )}
              </>
            )}
            </View>
          </View>
        </View>
      )
    },
    [colors, offlineByTxid, t, busyRow, onExplorer, onCopyBeef, onRefreshTx, onAbort]
  )

  // ── header (balance + the three destinations + activity heading) ─────
  const listHeader = useMemo(
    () => (
      <View>
        <TouchableOpacity
          onPress={refreshBalance}
          activeOpacity={0.7}
          style={styles.balanceBlock}
          accessibilityLabel={t('wallet_balance_refresh')}
        >
          <Text style={[styles.balanceLabel, { color: colors.textSecondary }]}>
            {t('you_have')}
          </Text>
          {balance === null ? (
            <ActivityIndicator color={colors.textSecondary} />
          ) : (
            <Text style={[styles.balance, { color: colors.textPrimary }]}>
              <AmountDisplay>{balance}</AmountDisplay>
            </Text>
          )}
        </TouchableOpacity>

        {/* The three destinations. Payments is the only accent-filled element
            on this screen, so the eye lands on it first. */}
        <View style={styles.destinations}>
          <PressableScale
            haptic="confirm"
            onPress={() => router.push('/pay')}
            style={[styles.dest, styles.destPrimary, { backgroundColor: colors.accent }]}
          >
            <MaterialCommunityIcons name="arrow-top-right" size={22} color={colors.textOnAccent} />
            <Text style={[styles.destLabel, { color: colors.textOnAccent }]}>
              {t('pay_direction_pay')}
            </Text>
          </PressableScale>

          <PressableScale
            haptic="confirm"
            onPress={() => router.push('/pay?direction=get')}
            style={[
              styles.dest,
              { backgroundColor: colors.backgroundElevated, borderColor: colors.separator }
            ]}
          >
            <MaterialCommunityIcons name="arrow-bottom-right" size={22} color={colors.textPrimary} />
            <Text style={[styles.destLabel, { color: colors.textPrimary }]}>
              {t('pay_direction_receive')}
            </Text>
          </PressableScale>

          <PressableScale
            onPress={() => router.push('/vault')}
            style={[
              styles.dest,
              { backgroundColor: colors.backgroundElevated, borderColor: colors.separator }
            ]}
          >
            <MaterialCommunityIcons name="safe" size={22} color={colors.textPrimary} />
            <Text style={[styles.destLabel, { color: colors.textPrimary }]}>
              {t('wallet_vault')}
            </Text>
          </PressableScale>

        </View>

        <View style={styles.activityHead}>
          <Text style={[styles.activityTitle, { color: colors.textPrimary }]}>
            {t('wallet_activity')}
          </Text>
          <TouchableOpacity
            onPress={onExport}
            disabled={exporting || actions.length === 0}
            hitSlop={8}
            style={styles.exportBtn}
            accessibilityLabel={t('tx_export_csv')}
          >
            {exporting ? (
              <ActivityIndicator size="small" color={colors.info} />
            ) : (
              <Ionicons
                name="download-outline"
                size={18}
                color={actions.length === 0 ? colors.textTertiary : colors.info}
              />
            )}
            <Text
              style={[
                styles.exportLabel,
                { color: actions.length === 0 ? colors.textTertiary : colors.info }
              ]}
            >
              {t('tx_export_csv')}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    ),
    [balance, colors, t, refreshBalance, onExport, exporting, actions.length]
  )

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: colors.backgroundSecondary, paddingTop: insets.top }
      ]}
    >
      <View style={[styles.header, { borderBottomColor: colors.separator }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn}>
          <Ionicons name="chevron-back" size={24} color={colors.info} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.textPrimary }]}>{t('wallet')}</Text>
        {/* Settings lives here rather than among the destinations below: it is
            navigation chrome, not a money action, so it should not compete with
            Payments and Vault for the eye. */}
        <TouchableOpacity
          onPress={() => router.push('/wallet-config')}
          style={styles.iconBtn}
          accessibilityRole="button"
          accessibilityLabel={t('wallet_settings')}
        >
          <Ionicons name="settings-outline" size={22} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>

      {/* Renders only when the keys could not be released — a destroyed key, a
          dismissed prompt, or biometric lockout. Previously all three looked
          identical to "you have no wallet". */}
      <WalletLockNotice />

      <FlatList
        data={actions}
        keyExtractor={(item, index) => `${item.txid || index}-${index}`}
        renderItem={renderItem}
        ListHeaderComponent={listHeader}
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator style={styles.pad} color={colors.textSecondary} />
          ) : (
            <Text style={[styles.empty, { color: colors.textSecondary }]}>
              {t('no_transactions')}
            </Text>
          )
        }
        onEndReached={loadMore}
        onEndReachedThreshold={0.3}
        refreshing={refreshing}
        onRefresh={onRefresh}
        ListFooterComponent={
          // One container of FIXED height in both states. Swapping a short
          // spinner for a tall spacer changed the content height every time a
          // page load started/ended, which made FlatList re-evaluate and re-fire
          // onEndReached — feeding the loop the guards above now break.
          <View style={[styles.footer, { height: insets.bottom + spacing.xxxl }]}>
            {loadingMore ? <ActivityIndicator color={colors.textSecondary} /> : null}
          </View>
        }
      />
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

  balanceBlock: {
    alignItems: 'center',
    gap: spacing.xs,
    paddingTop: spacing.xxl,
    paddingBottom: spacing.xl,
    paddingHorizontal: spacing.lg
  },
  // No textTransform: "You have" is a phrase leading into the amount, not a
  // column heading — and casing is the translation's business, not the CSS's
  // (uppercasing mangles scripts that have no case, and title-casing English).
  balanceLabel: { ...typography.footnote },
  // tabular-nums keeps the figure from jittering as digits change.
  balance: { ...typography.display, fontVariant: ['tabular-nums'] },

  destinations: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.xxl
  },
  dest: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    borderRadius: radii.md,
    paddingVertical: spacing.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'transparent'
  },
  destPrimary: { borderColor: 'transparent' },
  destLabel: { ...typography.footnote, fontWeight: '600' },

  activityHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm
  },
  activityTitle: { ...typography.footnote, textTransform: 'uppercase' },
  exportBtn: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  exportLabel: { ...typography.footnote, fontWeight: '600' },

  row: {
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth
  },
  rowTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md
  },
  // Status sits left, actions right — so the icons land under the amount.
  rowBottom: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    minHeight: 28 // reserve the icon row's height so rows don't jump on busy
  },
  rowActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginRight: -spacing.xs // optical: last glyph's padding aligns to the amount's right edge
  },
  rowAction: { padding: spacing.xs },
  description: { ...typography.body, flex: 1 },
  pill: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radii.sm
  },
  pillText: { ...typography.caption2, fontWeight: '600' },
  quietStatus: { ...typography.caption2 },
  amount: { ...typography.body, fontVariant: ['tabular-nums'] },

  pad: { padding: spacing.xl },
  footer: { alignItems: 'center', justifyContent: 'center' },
  empty: { ...typography.subhead, textAlign: 'center', padding: spacing.xxxl }
})
