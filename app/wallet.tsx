/**
 * The Wallet screen — full screen, not a drawer.
 *
 * Structure, top to bottom:
 *   balance  →  Pay / Get paid / Vault  →  activity, grouped by day
 *
 * This replaces a bottom-sheet settings menu plus a separate Transactions
 * route. Activity now sits on the screen the user already opens to check their
 * money, so "did that payment go through?" costs one tap instead of two.
 *
 * Colour discipline: `colors.accent` is achromatic (black/white) in this token
 * set, so it only reads as emphasis when used as a FILL. Exactly one element
 * here is accent-filled — Pay — and chroma elsewhere is reserved for
 * transaction status, never for decoration.
 *
 * Surfaces come from the `canvas*`/`surface*` tokens rather than the iOS grays:
 * the screen is a shallow gradient with cards lifted off it, which is what makes
 * the balance read as the focal point in both appearances.
 */
import React, { useState, useEffect, useCallback, useRef, useMemo, useContext } from 'react'
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
import { router, useFocusEffect } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTranslation } from 'react-i18next'
import AsyncStorage from '@react-native-async-storage/async-storage'
import Clipboard from '@react-native-clipboard/clipboard'
import { Utils } from '@bsv/sdk'
import { sdk } from '@bsv/wallet-toolbox-mobile'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, radii, typography } from '@/context/theme/tokens'
import { useWallet } from '@/context/WalletContext'
import { ExchangeRateContext } from '@/context/ExchangeRateContext'
import {
  formatAmountParts,
  formatAmount,
  formatSatoshisAsBsvDecimal
} from '@/utils/amountFormatHelpers'
import PressableScale from '@/components/ui/PressableScale'
import ScreenGradient from '@/components/ui/ScreenGradient'
import ActivityRow, { type ActivityAction } from '@/components/wallet/ActivityRow'
import { showToast } from '@/components/ui/Toast'
import { exportTransactionsAsCsv } from '@/utils/exportTransactions'
import { findOfflineActions, type OfflineActionRow } from '@/storage/methods/offlineActions'
import { readWalletBalance } from '@/storage/methods/walletBalanceSql'
import tabStore from '@/stores/TabStore'
import WalletLockNotice from '@/components/security/WalletLockNotice'

const PAGE_SIZE = 30

/** A day heading injected between rows. Kept in the same list as the rows so
 * the whole thing stays one FlatList — a SectionList would re-measure every
 * section on each status poll. */
type DayHeader = { kind: 'day'; id: string; label: string }
type Row = DayHeader | (ActivityAction & { kind?: undefined })

const DAY_MS = 86_400_000
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

/** Group rows under Today / Yesterday / an absolute date. Rows with no
 * timestamp fall through ungrouped rather than being dated wrongly. */
function withDayHeaders(actions: ActivityAction[], t: (k: string) => string): Row[] {
  const today = startOfDay(new Date())
  const out: Row[] = []
  let currentDay: number | null = null
  for (const action of actions) {
    const raw = action.created_at
    const ts = raw === undefined || raw === null ? NaN : new Date(raw as string).getTime()
    if (!Number.isNaN(ts)) {
      const day = startOfDay(new Date(ts))
      if (day !== currentDay) {
        currentDay = day
        const label =
          day === today
            ? t('wallet_group_today')
            : day === today - DAY_MS
              ? t('wallet_group_yesterday')
              : new Date(day).toLocaleDateString(undefined, {
                  day: 'numeric',
                  month: 'short',
                  year: day < today - 300 * DAY_MS ? 'numeric' : undefined
                })
        out.push({ kind: 'day', id: `day-${day}`, label })
      }
    }
    out.push(action)
  }
  return out
}

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
    refreshProof,
    settings
  } = useWallet()
  const { satoshisPerUSD } = useContext(ExchangeRateContext)
  const currency = settings?.currency || 'BSV'

  const balanceCacheKey = `cached_wallet_balance_${selectedNetwork}`
  const [balance, setBalance] = useState<number | null>(null)
  const [actions, setActions] = useState<ActivityAction[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [offlineByTxid, setOfflineByTxid] = useState<Map<string, OfflineActionRow>>(new Map())
  // Per-row in-flight action, keyed by txid (or reference for abort) so only
  // the tapped row shows a spinner rather than the whole list.
  const [busyRow, setBusyRow] = useState<string | null>(null)
  /** The one row whose utility chips are open. One at a time: two open rows and
   * the chips stop obviously belonging to a transaction. */
  const [expandedRow, setExpandedRow] = useState<string | null>(null)
  const offsetRef = useRef(0)
  /** Set once the server has no more rows, so onEndReached stops re-querying at
   * the bottom of the list. Cleared whenever the list is refetched from 0. */
  const exhaustedRef = useRef(false)
  /** Synchronous in-flight latch for loadMore (state updates are async). */
  const inFlightRef = useRef(false)

  // ── balance ─────────────────────────────────────────────────────────
  /**
   * One balance read at a time, shared by every caller.
   *
   * Mount, invalidation and pull-to-refresh all funnel through this latch, so a
   * caller arriving mid-read awaits that read instead of starting another.
   */
  const inFlightBalanceRef = useRef<Promise<void> | null>(null)
  const refreshBalance = useCallback(async () => {
    if (inFlightBalanceRef.current) return await inFlightBalanceRef.current
    const read = (async () => {
      try {
        // Straight to our own SQLite, deliberately NOT through the wallet's
        // listOutputs: every call through WalletStorageManager queues on one
        // FIFO reader lock, and the monitor holds that lock across network
        // broadcasts — so this read used to wait on whatever the monitor was
        // doing rather than on the database. See storage/methods/walletBalanceSql.
        // The wallet's own path stays as the fallback for the window before
        // storage and the user id are known.
        let total: number | null = null
        if (storage && walletUserId != null) {
          total = await readWalletBalance(storage, walletUserId)
        }
        if (total == null) {
          const pm = managers.permissionsManager
          if (!pm) return
          const { totalOutputs } = await pm.listOutputs(
            { basket: sdk.specOpWalletBalance },
            adminOriginator
          )
          total = totalOutputs ?? 0
        }
        setBalance(total)
        await AsyncStorage.setItem(balanceCacheKey, String(total))
      } catch {
        // Keep the last known balance on screen rather than blanking it: a
        // failed read is not "zero satoshis".
      }
    })()
    inFlightBalanceRef.current = read
    // Cleared here rather than in a `finally` inside the body: a synchronous
    // throw from the read would run that finally BEFORE the assignment above,
    // leaving a settled promise latched forever.
    void read.finally(() => {
      if (inFlightBalanceRef.current === read) inFlightBalanceRef.current = null
    })
    return await read
  }, [storage, walletUserId, managers.permissionsManager, adminOriginator, balanceCacheKey])

  /**
   * The effects below key off DATA changes, never off `refreshBalance`'s
   * identity.
   *
   * `refreshBalance` is rebuilt whenever the wallet context rebuilds, because
   * `managers.permissionsManager` is one of its deps. With that callback in an
   * effect's dependency list, a mid-session rebuild made every live instance of
   * this screen fire a fresh multi-second balance read — the "mount" effect was
   * never mount-only. What the effects actually need is *whether* a wallet
   * exists, so they depend on that instead.
   */
  const refreshBalanceRef = useRef(refreshBalance)
  useEffect(() => {
    refreshBalanceRef.current = refreshBalance
  }, [refreshBalance])
  // Either route to a figure counts: the direct read needs storage and the user
  // id, the fallback needs the permissions manager.
  const hasWallet = (storage != null && walletUserId != null) || managers.permissionsManager != null

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      // Show the cached figure immediately so the screen never opens empty.
      const cached = await AsyncStorage.getItem(balanceCacheKey)
      if (cancelled) return
      if (cached != null) setBalance(Number(cached))
      await refreshBalanceRef.current()
    })()
    return () => {
      cancelled = true
    }
    // `hasWallet` covers the cold start where this screen mounts before the
    // wallet finishes building; `balanceCacheKey` covers a network switch.
  }, [balanceCacheKey, hasWallet])

  /**
   * Returning to this screen refetches the balance and the activity list once.
   *
   * This screen stays mounted while /pay and /vault sit on top of it in the
   * stack, so neither the mount effect above nor the activity effect below runs
   * again on the way back. `txStatusVersion` covers writes that go through the
   * wallet, but relying on it alone leaves the user's own money looking stale
   * for any path that does not — an offline row queued while the network was
   * down, say — and "did that payment go through?" is the exact question this
   * screen exists to answer.
   *
   * A counter rather than a direct call: both effects below already know how to
   * fetch, so this reuses them instead of duplicating the fetch logic. Fires
   * once per return, not on a timer. The first focus is skipped — that is the
   * mount, which the effects already cover.
   */
  const [focusVersion, setFocusVersion] = useState(0)
  const firstFocusRef = useRef(true)
  useFocusEffect(
    useCallback(() => {
      if (firstFocusRef.current) {
        firstFocusRef.current = false
        return
      }
      setFocusVersion(v => v + 1)
    }, [])
  )

  // Re-read the figure whenever the transaction tables move — a payment sent, a
  // deposit internalized, a status change from the monitor. Skips the first pass,
  // which the mount effect above already covers.
  const balanceMountedRef = useRef(false)
  useEffect(() => {
    if (!balanceMountedRef.current) {
      balanceMountedRef.current = true
      return
    }
    void refreshBalanceRef.current()
  }, [txStatusVersion, focusVersion])

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
      setActions(result.actions as ActivityAction[])
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
  }, [fetchActions, txStatusVersion, focusVersion, fetchOfflineRows])

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
      const page = (result?.actions ?? []) as ActivityAction[]
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
        setActions(result.actions as ActivityAction[])
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

  /** The bare txid — what you paste into someone else's explorer or a support
   * thread, where a full BEEF would be unusable. */
  const onCopyTxid = useCallback(
    (txid: string) => {
      Clipboard.setString(txid)
      showToast(t('tx_txid_copied'), { type: 'success' })
    },
    [t]
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

  const toggleRow = useCallback((key: string) => {
    setExpandedRow(prev => (prev === key ? null : key))
  }, [])

  // ── rows ────────────────────────────────────────────────────────────
  const rows = useMemo(() => withDayHeaders(actions, t), [actions, t])

  const renderItem: ListRenderItem<Row> = useCallback(
    ({ item, index }) => {
      if (item.kind === 'day') {
        return (
          <Text style={[styles.dayHeader, { color: colors.textTertiary }]}>{item.label}</Text>
        )
      }
      const key = item.txid || item.reference || `row-${index}`
      const offline = item.txid ? offlineByTxid.get(item.txid) : undefined
      const busy =
        busyRow === item.txid || (!!item.reference && busyRow === item.reference)

      return (
        <ActivityRow
          action={item}
          rowKey={key}
          offlineStatus={offline?.status}
          expanded={expandedRow === key}
          busy={busy}
          onToggle={toggleRow}
          onExplorer={onExplorer}
          onCopyBeef={onCopyBeef}
          onCopyTxid={onCopyTxid}
          onRefreshTx={onRefreshTx}
          onAbort={onAbort}
        />
      )
    },
    [
      colors,
      offlineByTxid,
      busyRow,
      expandedRow,
      toggleRow,
      onExplorer,
      onCopyBeef,
      onCopyTxid,
      onRefreshTx,
      onAbort
    ]
  )

  // ── header (balance + the three destinations + activity heading) ─────
  const balanceParts = useMemo(
    () =>
      balance === null
        ? null
        : formatAmountParts(balance, currency, satoshisPerUSD, { abbreviate: true }),
    [balance, currency, satoshisPerUSD]
  )

  /** The line under the figure: the same money in the denominations the figure
   * is not using, so the user never has to convert in their head. */
  const balanceContext = useMemo(() => {
    if (balance === null) return ''
    const bsv = `${formatSatoshisAsBsvDecimal(balance)} BSV`
    const other = formatAmount(balance, currency === 'USD' ? 'BSV' : 'USD', satoshisPerUSD, {
      abbreviate: true
    })
    return `${bsv}   ·   ${other}`
  }, [balance, currency, satoshisPerUSD])

  const listHeader = useMemo(
    () => (
      <View>
        <TouchableOpacity
          onPress={() => void refreshBalance()}
          activeOpacity={0.7}
          style={styles.balanceBlock}
          accessibilityLabel={t('wallet_balance_refresh')}
        >
          <Text style={[styles.balanceLabel, { color: colors.textTertiary }]}>
            {t('wallet_balance_you_have')}
          </Text>
          {balanceParts === null ? (
            <ActivityIndicator color={colors.textSecondary} style={styles.balanceSpinner} />
          ) : (
            <>
              <Text style={[styles.balance, { color: colors.textPrimary }]}>
                {balanceParts.value}
                {balanceParts.unit ? (
                  <Text style={[styles.balanceUnit, { color: colors.textSecondary }]}>
                    {' '}
                    {balanceParts.unit}
                  </Text>
                ) : null}
              </Text>
              <Text style={[styles.balanceContext, { color: colors.textSecondary }]}>
                {balanceContext}
              </Text>
            </>
          )}
        </TouchableOpacity>

        {/* The three destinations. Pay is the only accent-filled element on this
            screen, so the eye lands on it first. */}
        <View style={styles.destinations}>
          <PressableScale
            haptic="confirm"
            onPress={() => router.push('/pay')}
            style={[styles.dest, styles.destPrimary, { backgroundColor: colors.accent }]}
          >
            <MaterialCommunityIcons name="arrow-top-right" size={19} color={colors.textOnAccent} />
            <Text style={[styles.destLabel, styles.destLabelPrimary, { color: colors.textOnAccent }]}>
              {t('pay_direction_pay')}
            </Text>
          </PressableScale>

          <PressableScale
            haptic="confirm"
            onPress={() => router.push('/pay?direction=get')}
            style={[
              styles.dest,
              { backgroundColor: colors.surfaceRaised, borderColor: colors.surfaceRaisedBorder }
            ]}
          >
            <MaterialCommunityIcons name="arrow-bottom-left" size={19} color={colors.textPrimary} />
            <Text style={[styles.destLabel, { color: colors.textPrimary }]}>
              {t('pay_direction_receive')}
            </Text>
          </PressableScale>

          <PressableScale
            onPress={() => router.push('/vault')}
            style={[
              styles.dest,
              { backgroundColor: colors.surfaceRaised, borderColor: colors.surfaceRaisedBorder }
            ]}
          >
            <MaterialCommunityIcons name="safe" size={19} color={colors.textPrimary} />
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
            style={[styles.exportBtn, { borderColor: colors.surfaceRaisedBorder }]}
            accessibilityRole="button"
            accessibilityLabel={t('tx_export_csv')}
          >
            {exporting ? (
              <ActivityIndicator size="small" color={colors.textSecondary} />
            ) : (
              <Ionicons
                name="download-outline"
                size={12}
                color={actions.length === 0 ? colors.textTertiary : colors.textSecondary}
              />
            )}
            <Text
              style={[
                styles.exportLabel,
                { color: actions.length === 0 ? colors.textTertiary : colors.textSecondary }
              ]}
            >
              {t('tx_export_csv')}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    ),
    [balanceParts, balanceContext, colors, t, refreshBalance, onExport, exporting, actions.length]
  )

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <ScreenGradient from={colors.canvasTop} to={colors.canvasBase} height={360} />

      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={[
            styles.iconBtn,
            { backgroundColor: colors.surfaceRaised, borderColor: colors.surfaceRaisedBorder }
          ]}
          accessibilityRole="button"
          accessibilityLabel={t('back')}
        >
          <Ionicons name="chevron-back" size={18} color={colors.textSecondary} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.textPrimary }]}>{t('wallet')}</Text>
        {/* Settings lives here rather than among the destinations below: it is
            navigation chrome, not a money action, so it should not compete with
            Pay and Vault for the eye. */}
        <TouchableOpacity
          onPress={() => router.push('/wallet-config')}
          style={[
            styles.iconBtn,
            { backgroundColor: colors.surfaceRaised, borderColor: colors.surfaceRaisedBorder }
          ]}
          accessibilityRole="button"
          accessibilityLabel={t('wallet_settings')}
        >
          <Ionicons name="options-outline" size={17} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>

      {/* Renders only when the keys could not be released — a destroyed key, a
          dismissed prompt, or biometric lockout. Previously all three looked
          identical to "you have no wallet". */}
      <WalletLockNotice />

      <FlatList
        data={rows}
        keyExtractor={(item, index) =>
          item.kind === 'day' ? item.id : `${item.txid || index}-${index}`
        }
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
  // No bottom rule: the gradient already separates the chrome from the balance,
  // and a hairline there cut the screen in half above the focal figure.
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs
  },
  iconBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center'
  },
  headerTitle: { ...typography.headline, letterSpacing: -0.2 },

  balanceBlock: {
    alignItems: 'center',
    paddingTop: spacing.xxl,
    paddingBottom: spacing.xl,
    paddingHorizontal: spacing.xl
  },
  // Uppercase + wide tracking: this is a column heading over a figure, not a
  // phrase leading into it. Scripts without case ignore the transform.
  // Sentence case, not the uppercase eyebrow treatment: "You have" is a phrase
  // leading into the figure, and caps would read as shouting rather than as a
  // label.
  balanceLabel: {
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.2
  },
  balanceSpinner: { marginTop: spacing.md },
  // tabular-nums keeps the figure from jittering as digits change.
  balance: {
    ...typography.display,
    lineHeight: 46,
    letterSpacing: -1.2,
    marginTop: 10,
    fontVariant: ['tabular-nums']
  },
  balanceUnit: { fontSize: 19, fontWeight: '600', letterSpacing: 0 },
  balanceContext: { fontSize: 13, lineHeight: 18, marginTop: 10, fontVariant: ['tabular-nums'] },

  destinations: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: spacing.xl
  },
  dest: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    borderRadius: 16,
    paddingTop: 15,
    paddingBottom: 13,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'transparent'
  },
  // The one accent-filled control on the screen, so it also gets the only
  // shadow — the two cues have to agree about what is primary.
  destPrimary: {
    borderColor: 'transparent',
    shadowColor: '#000',
    shadowOpacity: 0.28,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
    elevation: 4
  },
  destLabel: { fontSize: 13, fontWeight: '600' },
  destLabelPrimary: { fontWeight: '700' },

  activityHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xl,
    paddingTop: 28,
    paddingBottom: 10
  },
  activityTitle: { fontSize: 15, fontWeight: '700', letterSpacing: -0.2 },
  exportBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: radii.pill,
    borderWidth: StyleSheet.hairlineWidth
  },
  exportLabel: { fontSize: 12, fontWeight: '600' },

  dayHeader: {
    fontSize: 10.5,
    fontWeight: '700',
    letterSpacing: 1.3,
    textTransform: 'uppercase',
    paddingHorizontal: spacing.xl,
    paddingTop: 14,
    paddingBottom: 4
  },

  pad: { padding: spacing.xl },
  footer: { alignItems: 'center', justifyContent: 'center' },
  empty: { ...typography.subhead, textAlign: 'center', padding: spacing.xxxl }
})
