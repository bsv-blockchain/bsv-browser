/**
 * Get paid → a conventional wallet.
 *
 * Show the address, and money appears: the sweep runs in WalletContext, not
 * here, so this view registers today's address on the watchlist and then
 * stays out of the way. The day-offset stepper survives as a recovery
 * affordance only — a previously-issued address whose funds cannot be swept is
 * lost money — which is why it is behind a disclosure rather than on the main
 * view.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, AppState, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import Clipboard from '@react-native-clipboard/clipboard'
import QRCode from 'react-native-qrcode-svg'
import { useTranslation } from 'react-i18next'
import { formatDistanceToNow } from 'date-fns'

import AmountDisplay from '@/components/wallet/AmountDisplay'
import ReceivedOverlay from '@/components/pay/PaymentSuccessOverlay'
import { useTheme } from '@/context/theme/ThemeContext'
import { radii, spacing, typography } from '@/context/theme/tokens'
import { useWallet } from '@/context/WalletContext'
import { showToast } from '@/components/ui/Toast'
import {
  MAX_RECOVERY_DAYS,
  derivationPrefixFor,
  getCurrentDate,
  getPaymentAddress,
  getProcessedTransactions,
  sweepAddress,
  wocConfigFor,
  type ProcessedTx
} from '@/utils/pay/rails/address'
import { watchAddress } from '@/utils/pay/watchlist'

/**
 * How often this screen re-reads its own imported history while it is in front.
 *
 * The sweep itself lives in WalletContext and runs on its own 30s cycle whether
 * or not anyone is looking. This is only the screen noticing — it exists so a
 * payee standing in front of the address gets the arrival moment rather than a
 * silently-updated list.
 */
const HISTORY_POLL_MS = 5000

export default function AddressReceive() {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const { managers, adminOriginator, selectedNetwork, storage } = useWallet()
  const wallet = managers?.permissionsManager || null
  const woc = wocConfigFor(selectedNetwork)

  const [daysOffset, setDaysOffset] = useState(0)
  const [address, setAddress] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [processed, setProcessed] = useState<ProcessedTx[]>([])
  const [showRecovery, setShowRecovery] = useState(false)
  const [sweeping, setSweeping] = useState(false)

  /** The success moment, held until the payee acknowledges it. */
  const [received, setReceived] = useState<{ amount: number; count: number } | null>(null)

  /**
   * What this screen had already seen imported, so a poll can tell an arrival
   * from the history it loaded with. Null until the first read establishes the
   * baseline — without that, opening the screen on an address with past imports
   * would celebrate them all over again.
   */
  const baselineRef = useRef<{ total: number; count: number } | null>(null)
  const focusedRef = useRef(true)
  const pollingRef = useRef(false)
  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true
      return () => {
        focusedRef.current = false
      }
    }, [])
  )

  /** Sum and count of everything imported to the address on screen. */
  const tally = (rows: ProcessedTx[]) => ({
    total: rows.reduce((sum, tx) => sum + tx.satoshis, 0),
    count: rows.length
  })

  const load = useCallback(
    async (offset: number) => {
      if (!wallet) return
      setLoading(true)
      try {
        const date = getCurrentDate(offset)
        const derivationPrefix = derivationPrefixFor(date)
        const next = await getPaymentAddress(wallet as any, adminOriginator, derivationPrefix, woc.network)
        setDaysOffset(offset)
        setAddress(next)
        // Registering is what makes the background sweeper poll it. Every
        // address the user is shown gets watched — including a recovered one.
        if (storage) await watchAddress(storage as any, { address: next, date, derivationPrefix })
        const rows = await getProcessedTransactions(wallet as any, adminOriginator, next)
        setProcessed(rows)
        // A different address means a different history: re-baseline, or stepping
        // to a recovered day would read its existing imports as new arrivals.
        baselineRef.current = tally(rows)
      } catch (e: any) {
        showToast(e?.message || t('unable_to_generate_address'), { type: 'error' })
      } finally {
        setLoading(false)
      }
    },
    [wallet, adminOriginator, woc.network, storage, t]
  )

  useEffect(() => {
    if (wallet) void load(0)
  }, [wallet]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleCopy = useCallback(() => {
    if (!address) return
    Clipboard.setString(address)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [address])

  // ── Notice what the background sweep credited ──
  //
  // The sweeper in WalletContext does the work and raises a global toast, which
  // is right when the user is elsewhere in the app. But when they are standing on
  // this screen watching the address, the arrival deserves the same full-screen
  // moment every other way of being paid gets. This only reads the wallet's own
  // imported history — it never sweeps, so it cannot race the sweeper.
  useEffect(() => {
    if (!wallet || !address) return
    let cancelled = false

    const tick = async () => {
      if (cancelled || !focusedRef.current) return
      if (AppState.currentState !== 'active') return
      if (pollingRef.current) return
      pollingRef.current = true
      try {
        const rows = await getProcessedTransactions(wallet as any, adminOriginator, address)
        if (cancelled) return
        setProcessed(rows)
        const now = tally(rows)
        const before = baselineRef.current
        baselineRef.current = now
        // Compare on total AND count: two imports of equal size in one interval
        // move the count when the delta alone would look like one payment.
        if (before && (now.total > before.total || now.count > before.count)) {
          setReceived({
            amount: Math.max(0, now.total - before.total),
            count: Math.max(1, now.count - before.count)
          })
        }
      } catch {
        // A failed history read is not worth reporting: the next tick retries and
        // the money is already credited either way.
      } finally {
        pollingRef.current = false
      }
    }

    const interval = setInterval(() => void tick(), HISTORY_POLL_MS)
    const appSubscription = AppState.addEventListener('change', next => {
      if (next === 'active') void tick()
    })

    return () => {
      cancelled = true
      clearInterval(interval)
      appSubscription.remove()
    }
  }, [wallet, address, adminOriginator])

  /**
   * Sweep this address now. The background pass covers the common case; this
   * exists for a recovered day, where the user is standing in front of the
   * screen precisely because they want an answer immediately.
   */
  const handleSweepNow = useCallback(async () => {
    if (!wallet || !address) return
    setSweeping(true)
    try {
      const { importedSatoshis } = await sweepAddress({
        wallet: wallet as any,
        adminOriginator,
        woc,
        address,
        derivationPrefix: derivationPrefixFor(getCurrentDate(daysOffset))
      })
      const rows = await getProcessedTransactions(wallet as any, adminOriginator, address)
      setProcessed(rows)
      baselineRef.current = tally(rows)
      if (importedSatoshis > 0) {
        // The arrival gets the full-screen moment, same as every other way of
        // being paid. Nothing found is not an event — a toast is right for that.
        setReceived({ amount: importedSatoshis, count: 1 })
      } else {
        showToast(t('no_pending_payments'), { type: 'info' })
      }
    } catch (e: any) {
      showToast(e?.message || t('unknown_error'), { type: 'error' })
    } finally {
      setSweeping(false)
    }
  }, [wallet, address, adminOriginator, woc, daysOffset, t])

  return (
    <ScrollView contentContainerStyle={styles.content}>
      {loading && !address ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.accent} />
          <Text style={[styles.support, { color: colors.textSecondary }]}>{t('generating_address')}</Text>
        </View>
      ) : !address ? (
        <View style={styles.centered}>
          <Text style={[styles.support, { color: colors.textSecondary }]}>{t('unable_to_generate_address')}</Text>
        </View>
      ) : (
        <>
          <View style={styles.qrHero}>
            <View style={styles.qrPlate}>
              <QRCode value={address} size={240} color="#000" backgroundColor="#fff" />
            </View>
          </View>

          <TouchableOpacity onPress={handleCopy} style={[styles.addressChip, { backgroundColor: colors.fillTertiary }]}>
            <Text
              style={[styles.addressText, { color: colors.textSecondary }]}
              numberOfLines={1}
              ellipsizeMode="middle"
            >
              {address}
            </Text>
            <View style={[styles.copyPill, { backgroundColor: copied ? colors.success + '20' : colors.fill }]}>
              <Ionicons
                name={copied ? 'checkmark' : 'copy-outline'}
                size={16}
                color={copied ? colors.success : colors.textSecondary}
              />
              <Text style={[styles.copyText, { color: copied ? colors.success : colors.textSecondary }]}>
                {copied ? t('copied') : t('pay_copy')}
              </Text>
            </View>
          </TouchableOpacity>

          {/* No Check balance, no Import funds: the sweep is automatic now. */}
          <Text style={[styles.watching, { color: colors.textTertiary }]}>{t('pay_address_watching')}</Text>

          {processed.length > 0 && (
            <>
              <View style={[styles.totalRow, { borderTopColor: colors.separator }]}>
                <Text style={[styles.totalLabel, { color: colors.textSecondary }]}>{t('imported')}</Text>
                <Text style={[styles.totalValue, { color: colors.success }]}>
                  <AmountDisplay>{processed.reduce((sum, tx) => sum + tx.satoshis, 0)}</AmountDisplay>
                </Text>
              </View>
              <View style={[styles.log, { borderColor: colors.separator }]}>
                {processed.map((tx, i) => (
                  <View
                    key={tx.txid}
                    style={[
                      styles.logRow,
                      i < processed.length - 1 && {
                        borderBottomWidth: StyleSheet.hairlineWidth,
                        borderBottomColor: colors.separator
                      }
                    ]}
                  >
                    <Ionicons name="checkmark-circle" size={14} color={colors.success} />
                    <Text style={[styles.logSats, { color: colors.success }]}>
                      +<AmountDisplay>{tx.satoshis}</AmountDisplay>
                    </Text>
                    {tx.importedAt ? (
                      <Text style={[styles.logTime, { color: colors.textTertiary }]}>
                        {formatDistanceToNow(tx.importedAt, { addSuffix: true })}
                      </Text>
                    ) : (
                      <Text
                        style={[styles.logTxid, { color: colors.textTertiary }]}
                        numberOfLines={1}
                        ellipsizeMode="middle"
                      >
                        {tx.txid}
                      </Text>
                    )}
                  </View>
                ))}
              </View>
            </>
          )}

          {/* ── Recovery. Secondary by design: reaching an earlier day is the
                 uncommon case of a payer who sat on an address. It must exist —
                 unswept funds on an unreachable address are lost — but it is not
                 a primary control. */}
          <TouchableOpacity onPress={() => setShowRecovery(v => !v)} style={styles.disclosure} hitSlop={8}>
            <Ionicons name={showRecovery ? 'chevron-down' : 'chevron-forward'} size={16} color={colors.textTertiary} />
            <Text style={[styles.disclosureText, { color: colors.textTertiary }]}>{t('pay_address_earlier_day')}</Text>
          </TouchableOpacity>

          {showRecovery && (
            <View style={styles.recovery}>
              <View style={styles.dateRow}>
                <TouchableOpacity
                  onPress={() => void load(Math.min(MAX_RECOVERY_DAYS, daysOffset + 1))}
                  disabled={daysOffset >= MAX_RECOVERY_DAYS}
                  hitSlop={8}
                  style={styles.dateArrow}
                >
                  <Ionicons
                    name="chevron-back"
                    size={20}
                    color={daysOffset >= MAX_RECOVERY_DAYS ? colors.textQuaternary : colors.accent}
                  />
                </TouchableOpacity>
                <Text style={[styles.dateText, { color: colors.textSecondary }]}>{getCurrentDate(daysOffset)}</Text>
                <TouchableOpacity
                  onPress={() => void load(Math.max(0, daysOffset - 1))}
                  disabled={daysOffset === 0}
                  hitSlop={8}
                  style={styles.dateArrow}
                >
                  <Ionicons
                    name="chevron-forward"
                    size={20}
                    color={daysOffset === 0 ? colors.textQuaternary : colors.accent}
                  />
                </TouchableOpacity>
              </View>
              <TouchableOpacity
                onPress={handleSweepNow}
                disabled={sweeping}
                style={[styles.sweepButton, { borderColor: colors.separator }]}
              >
                {sweeping ? (
                  <ActivityIndicator size="small" color={colors.accent} />
                ) : (
                  <Text style={[styles.sweepText, { color: colors.accent }]}>{t('pay_address_sweep_now')}</Text>
                )}
              </TouchableOpacity>
            </View>
          )}
        </>
      )}
      {/* The moment money arrives. A Modal, so it covers the header too, and it
          stays until acknowledged. */}
      {received && (
        <ReceivedOverlay amount={received.amount} count={received.count} onDismiss={() => setReceived(null)} />
      )}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg },
  centered: { alignItems: 'center', justifyContent: 'center', paddingVertical: spacing.xxxl, gap: spacing.md },
  support: { ...typography.subhead, textAlign: 'center' },
  qrHero: { alignItems: 'center', marginBottom: spacing.lg },
  qrPlate: { padding: spacing.lg, borderRadius: radii.xl, backgroundColor: '#fff' },
  addressChip: { borderRadius: radii.lg, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, gap: spacing.sm },
  addressText: { ...typography.footnote, fontFamily: 'monospace', textAlign: 'center' },
  copyPill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    borderRadius: radii.pill,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg
  },
  copyText: { ...typography.subhead, fontWeight: '500' },
  watching: { ...typography.footnote, textAlign: 'center', marginTop: spacing.md },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: spacing.lg,
    marginTop: spacing.lg,
    marginBottom: spacing.md
  },
  totalLabel: { ...typography.subhead },
  totalValue: { ...typography.headline, fontWeight: '700' },
  log: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radii.md, overflow: 'hidden' },
  logRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md
  },
  logSats: { ...typography.subhead, fontWeight: '600' },
  logTxid: { ...typography.caption1, fontFamily: 'monospace', flex: 1 },
  logTime: { ...typography.caption1, fontFamily: 'monospace' },
  disclosure: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: spacing.xl },
  disclosureText: { ...typography.footnote },
  recovery: { marginTop: spacing.md, gap: spacing.md },
  dateRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.md },
  dateArrow: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  dateText: {
    ...typography.footnote,
    fontFamily: 'monospace',
    fontWeight: '500',
    minWidth: 100,
    textAlign: 'center',
    letterSpacing: 0.3
  },
  sweepButton: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.sm + 2,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth
  },
  sweepText: { ...typography.subhead, fontWeight: '500' }
})
