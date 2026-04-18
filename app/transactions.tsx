import React, { useState, useEffect, useCallback, useRef } from 'react'
import {
  View,
  Text,
  FlatList,
  ListRenderItem,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { router } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Clipboard from '@react-native-clipboard/clipboard'
import { toast } from 'react-toastify'
import { useTranslation } from 'react-i18next'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, typography } from '@/context/theme/tokens'
import { useWallet } from '@/context/WalletContext'
import AmountDisplay from '@/components/wallet/AmountDisplay'
import tabStore from '@/stores/TabStore'
import type { WalletAction } from '@bsv/sdk'

const PAGE_SIZE = 30

type StatusInfo = { label: string; color: string }

const ABORTABLE_STATUSES = new Set(['unsigned', 'nosend', 'nonfinal'])

function getStatusInfo(status: string, colors: any, t: (key: string) => string): StatusInfo {
  switch (status) {
    case 'completed': return { label: t('tx_status_confirmed'), color: colors.success }
    case 'unproven': return { label: t('tx_status_accepted'), color: colors.success }
    case 'sending': return { label: t('tx_status_broadcasting'), color: colors.success }
    case 'nosend': return { label: t('tx_status_not_sent'), color: colors.warning }
    case 'unsigned': return { label: t('tx_status_unsigned'), color: colors.warning }
    case 'nonfinal': return { label: t('tx_status_nonfinal'), color: colors.warning }
    case 'failed': return { label: t('tx_status_failed'), color: colors.error }
    default: return { label: status, color: colors.textSecondary }
  }
}

export default function TransactionsScreen() {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const { managers, adminOriginator, selectedNetwork, storage, txStatusVersion, refreshProof } = useWallet()

  const [actions, setActions] = useState<WalletAction[]>([])
  const [totalActions, setTotalActions] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [copyingTxid, setCopyingTxid] = useState<string | null>(null)
  const [abortingTxid, setAbortingTxid] = useState<string | null>(null)
  const [refreshingTxid, setRefreshingTxid] = useState<string | null>(null)
  const offsetRef = useRef(0)

  const fetchActions = useCallback(async (offset: number) => {
    if (!managers.permissionsManager) return null
    const result = await managers.permissionsManager.listActions(
      { labels: [], limit: PAGE_SIZE, offset },
      adminOriginator
    )
    return result
  }, [managers.permissionsManager, adminOriginator])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (actions.length === 0) setLoading(true)
      const result = await fetchActions(0)
      if (cancelled || !result) return
      const reversedActions = [...result.actions].reverse()
      setActions(reversedActions)
      setTotalActions(result.totalActions)
      offsetRef.current = result.actions.length
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [fetchActions, txStatusVersion])

  const loadMore = useCallback(async () => {
    if (loadingMore || offsetRef.current >= totalActions) return
    setLoadingMore(true)
    const result = await fetchActions(offsetRef.current)
    if (result) {
      const reversedActions = [...result.actions].reverse()
      setActions(prev => [...prev, ...reversedActions])
      setTotalActions(result.totalActions)
      offsetRef.current += result.actions.length
    }
    setLoadingMore(false)
  }, [loadingMore, totalActions, fetchActions])

  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    const result = await fetchActions(0)
    if (result) {
      const reversedActions = [...result.actions].reverse()
      setActions(reversedActions)
      setTotalActions(result.totalActions)
      offsetRef.current = result.actions.length
    }
    setRefreshing(false)
  }, [fetchActions])

  const handleExplorerLink = useCallback((txid: string) => {
    const baseUrl = selectedNetwork === 'main' ? 'https://whatsonchain.com'
      : selectedNetwork === 'teratest' ? 'https://woc-ttn.bsvb.tech'
      : 'https://test.whatsonchain.com'
    const url = `${baseUrl}/tx/${txid}`
    tabStore.updateTab(tabStore.activeTabId, { url })
    router.push('/')
  }, [selectedNetwork])

  const handleCopyRawTx = useCallback(async (txid: string) => {
    if (!storage || copyingTxid) return
    setCopyingTxid(txid)
    try {
      const rawTx = await storage.getRawTxOfKnownValidTransaction(txid)
      if (rawTx) {
        const hex = Array.from(rawTx).map(b => b.toString(16).padStart(2, '0')).join('')
        Clipboard.setString(hex)
        toast.success(t('tx_copied'))
      } else {
        toast.error(t('tx_not_available'))
      }
    } catch (e) {
      console.error('Failed to copy raw tx:', e)
      toast.error(t('tx_copy_failed'))
    } finally {
      setCopyingTxid(null)
    }
  }, [storage, copyingTxid])

  const handleAbort = useCallback(async (reference: string) => {
    if (!managers.permissionsManager || abortingTxid) return
    setAbortingTxid(reference)
    try {
      await managers.permissionsManager.abortAction({ reference }, adminOriginator)
      toast.success(t('tx_abort_success'))
      onRefresh()
    } catch (e) {
      console.error('Failed to abort transaction:', e)
      toast.error(t('tx_abort_failed'))
    } finally {
      setAbortingTxid(null)
    }
  }, [managers.permissionsManager, adminOriginator, abortingTxid, onRefresh, t])

  const handleRefreshProof = useCallback(async (txid: string) => {
    if (refreshingTxid) return
    setRefreshingTxid(txid)
    try {
      await refreshProof(txid)
      toast.success(t('tx_proof_refreshed'))
    } catch (e) {
      console.info('Proof refresh:', e instanceof Error ? e.message : e)
      toast.error(e instanceof Error ? e.message : t('tx_proof_refresh_failed'))
    } finally {
      setRefreshingTxid(null)
    }
  }, [refreshProof, refreshingTxid, t])

  const renderItem: ListRenderItem<WalletAction> = useCallback(({ item }) => {
    const status = getStatusInfo(item.status, colors, t)
    const isOutgoing = item.isOutgoing
    const amount = item.satoshis
    const reference = (item as any).reference as string | undefined
    const canAbort = ABORTABLE_STATUSES.has(item.status) && !!reference
    const canRefresh = !canAbort && item.status !== 'completed' && !!item.txid

    return (
      <View style={[styles.row, { borderBottomColor: colors.separator }]}>
        <View style={styles.rowLeft}>
          <Text style={[styles.description, { color: colors.textPrimary }]} numberOfLines={1}>
            {item.description || t('transactions')}
          </Text>
          <View style={styles.statusRow}>
            <View style={[styles.statusBadge, { backgroundColor: status.color + '20' }]}>
              <Text style={[styles.statusText, { color: status.color }]}>
                {status.label}
              </Text>
            </View>
          </View>
        </View>
        <View style={styles.rowRight}>
          <Text style={[styles.amount, { color: isOutgoing ? colors.error : colors.textPrimary }]}>
            <AmountDisplay>
              {amount}
            </AmountDisplay>
          </Text>
          <View style={styles.actionButtons}>
            {canAbort ? (
              <TouchableOpacity
                onPress={() => handleAbort(reference)}
                style={styles.iconButton}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                disabled={abortingTxid === reference}
              >
                <Ionicons
                  name={abortingTxid === reference ? 'hourglass-outline' : 'close-circle-outline'}
                  size={18}
                  color={colors.error}
                />
              </TouchableOpacity>
            ) : (
              <>
                {canRefresh ? (
                  <TouchableOpacity
                    onPress={() => handleRefreshProof(item.txid)}
                    style={styles.iconButton}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    disabled={refreshingTxid === item.txid}
                  >
                    <Ionicons
                      name={refreshingTxid === item.txid ? 'hourglass-outline' : 'refresh-outline'}
                      size={18}
                      color={colors.textSecondary}
                    />
                  </TouchableOpacity>
                ) : <View style={styles.iconButton} />}
                {item.txid ? (
                  <TouchableOpacity
                    onPress={() => handleExplorerLink(item.txid)}
                    style={styles.iconButton}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Ionicons name="open-outline" size={18} color={colors.textSecondary} />
                  </TouchableOpacity>
                ) : <View style={styles.iconButton} />}
                <TouchableOpacity
                  onPress={() => handleCopyRawTx(item.txid)}
                  style={styles.iconButton}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  disabled={!item.txid || copyingTxid === item.txid}
                >
                  <Ionicons
                    name={copyingTxid === item.txid ? 'hourglass-outline' : 'copy-outline'}
                    size={18}
                    color={item.txid ? colors.textSecondary : colors.textQuaternary}
                  />
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>
      </View>
    )
  }, [colors, handleExplorerLink, handleCopyRawTx, handleAbort, handleRefreshProof, copyingTxid, abortingTxid, refreshingTxid, t])

  let content: React.ReactNode
  if (loading) {
    content = (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    )
  } else if (actions.length === 0) {
    content = (
      <View style={styles.centered}>
        <Text style={[styles.emptyText, { color: colors.textSecondary }]}>{t('no_transactions')}</Text>
      </View>
    )
  } else {
    content = (
      <FlatList
        data={actions}
        keyExtractor={(item, index) => `${item.txid || index}-${index}`}
        renderItem={renderItem}
        onEndReached={loadMore}
        onEndReachedThreshold={0.3}
        refreshing={refreshing}
        onRefresh={onRefresh}
        ListFooterComponent={
          loadingMore
            ? <ActivityIndicator style={{ padding: spacing.lg }} color={colors.accent} />
            : <View style={{ height: insets.bottom + 40 }} />
        }
        style={{ backgroundColor: colors.background }}
      />
    )
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.backgroundSecondary, paddingTop: insets.top }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.separator }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <Ionicons name="chevron-back" size={24} color={colors.accent} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.textPrimary }]}>{t('transactions')}</Text>
        <View style={styles.backButton} />
      </View>
      {content}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    ...typography.headline,
    fontWeight: '600',
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyText: {
    ...typography.body,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowLeft: {
    flex: 1,
    marginRight: spacing.sm,
  },
  description: {
    ...typography.body,
    marginBottom: 4,
  },
  statusRow: {
    flexDirection: 'row',
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
  },
  statusText: {
    fontSize: 12,
    fontWeight: '500',
  },
  rowRight: {
    alignItems: 'flex-end',
  },
  amount: {
    ...typography.body,
    fontWeight: '600',
    marginBottom: 4,
  },
  actionButtons: {
    flexDirection: 'row',
    gap: 4,
  },
  iconButton: {
    width: 32,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
