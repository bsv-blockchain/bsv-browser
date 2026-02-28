import React, { useState, useEffect, useCallback, useRef } from 'react'
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { router } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Clipboard from '@react-native-clipboard/clipboard'
import { toast } from 'react-toastify'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, typography } from '@/context/theme/tokens'
import { useWallet } from '@/context/WalletContext'
import AmountDisplay from '@/components/wallet/AmountDisplay'
import tabStore from '@/stores/TabStore'
import type { WalletAction } from '@bsv/sdk'

const PAGE_SIZE = 30

type StatusInfo = { label: string; color: string }

function getStatusInfo(status: string, colors: any): StatusInfo {
  switch (status) {
    case 'completed': return { label: 'Confirmed', color: colors.success }
    case 'unproven': return { label: 'Broadcast', color: colors.warning }
    case 'sending': return { label: 'Sending', color: colors.warning }
    case 'nosend': return { label: 'Local', color: colors.textQuaternary }
    case 'failed': return { label: 'Failed', color: colors.error }
    default: return { label: status, color: colors.textSecondary }
  }
}

export default function TransactionsScreen() {
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const { managers, adminOriginator, selectedNetwork, storage, txStatusVersion } = useWallet()

  const [actions, setActions] = useState<WalletAction[]>([])
  const [totalActions, setTotalActions] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [copyingTxid, setCopyingTxid] = useState<string | null>(null)
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
      setLoading(true)
      const result = await fetchActions(0)
      if (cancelled || !result) return
      setActions(result.actions.reverse())
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
      setActions(prev => [...prev, ...result.actions.reverse()])
      setTotalActions(result.totalActions)
      offsetRef.current += result.actions.length
    }
    setLoadingMore(false)
  }, [loadingMore, totalActions, fetchActions])

  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    const result = await fetchActions(0)
    if (result) {
      setActions(result.actions.reverse())
      setTotalActions(result.totalActions)
      offsetRef.current = result.actions.length
    }
    setRefreshing(false)
  }, [fetchActions])

  const handleExplorerLink = useCallback((txid: string) => {
    const baseUrl = selectedNetwork === 'test'
      ? 'https://test.whatsonchain.com'
      : 'https://whatsonchain.com'
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
        toast.success('Transaction copied')
      } else {
        toast.error('Raw transaction not available')
      }
    } catch (e) {
      console.error('Failed to copy raw tx:', e)
      toast.error('Failed to copy transaction')
    } finally {
      setCopyingTxid(null)
    }
  }, [storage, copyingTxid])

  const renderItem = useCallback(({ item }: { item: WalletAction }) => {
    const status = getStatusInfo(item.status, colors)
    const isOutgoing = item.isOutgoing
    const amount = item.satoshis

    return (
      <View style={[styles.row, { borderBottomColor: colors.separator }]}>
        <View style={styles.rowLeft}>
          <Text style={[styles.description, { color: colors.textPrimary }]} numberOfLines={1}>
            {item.description || 'Transaction'}
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
          <Text style={[styles.amount, { color: isOutgoing ? colors.textPrimary : colors.error }]}>
            <AmountDisplay>
              {isOutgoing ? amount : -amount}
            </AmountDisplay>
          </Text>
          <View style={styles.actionButtons}>
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
          </View>
        </View>
      </View>
    )
  }, [colors, handleExplorerLink, handleCopyRawTx, copyingTxid])

  return (
    <View style={[styles.container, { backgroundColor: colors.backgroundSecondary, paddingTop: insets.top }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.separator }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <Ionicons name="chevron-back" size={24} color={colors.accent} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.textPrimary }]}>Transactions</Text>
        <View style={styles.backButton} />
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.accent} />
        </View>
      ) : actions.length === 0 ? (
        <View style={styles.centered}>
          <Text style={[styles.emptyText, { color: colors.textSecondary }]}>No transactions yet</Text>
        </View>
      ) : (
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
      )}
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
