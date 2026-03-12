import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  StyleSheet,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Animated
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { router } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Clipboard from '@react-native-clipboard/clipboard'

import QRCode from 'react-native-qrcode-svg'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { StatusBar } from 'expo-status-bar'
import {
  PublicKey,
  P2PKH,
  Beef,
  Utils,
  PrivateKey,
  WalletProtocol,
  InternalizeActionArgs,
  InternalizeOutput
} from '@bsv/sdk'

import { useTranslation } from 'react-i18next'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, typography, radii } from '@/context/theme/tokens'
import { useWallet } from '@/context/WalletContext'
import { SatsAmountInput } from '@/components/wallet/SatsAmountInput'
import { formatDistanceToNow } from 'date-fns'

const brc29ProtocolID: WalletProtocol = [2, '3241645161d8']

type Tab = 'receive' | 'send'

interface Utxo {
  txid: string
  vout: number
  satoshis: number
}

interface ProcessedTx {
  txid: string
  satoshis: number
  status: string
  importedAt: Date | null
}

const getCurrentDate = (daysOffset: number): string => {
  const today = new Date()
  today.setDate(today.getDate() - daysOffset)
  return today.toISOString().split('T')[0]
}

export default function LegacyPaymentsScreen() {
  const { t } = useTranslation()
  const { colors, isDark } = useTheme()
  const insets = useSafeAreaInsets()
  const { managers, adminOriginator, selectedNetwork } = useWallet()
  const wallet = managers?.permissionsManager || null

  // ── Tab state ────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<Tab>('receive')
  const indicatorAnim = useRef(new Animated.Value(0)).current

  const switchTab = useCallback(
    (tab: Tab) => {
      setActiveTab(tab)
      Animated.spring(indicatorAnim, {
        toValue: tab === 'receive' ? 0 : 1,
        useNativeDriver: false,
        tension: 300,
        friction: 30
      }).start()
    },
    [indicatorAnim]
  )

  // ── Receive state ────────────────────────────────────────────────────────
  const [paymentAddress, setPaymentAddress] = useState<string | null>(null)
  const [balance, setBalance] = useState<number>(-1)
  const [isLoadingAddress, setIsLoadingAddress] = useState(false)
  const [isCheckingBalance, setIsCheckingBalance] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const [copied, setCopied] = useState(false)
  const [daysOffset, setDaysOffset] = useState(0)
  const [derivationPrefix, setDerivationPrefix] = useState(Utils.toBase64(Utils.toArray(getCurrentDate(0), 'utf8')))
  const derivationSuffix = Utils.toBase64(Utils.toArray('legacy', 'utf8'))
  const [processedTxs, setProcessedTxs] = useState<ProcessedTx[]>([])

  // ── Send state ───────────────────────────────────────────────────────────
  const [recipientAddress, setRecipientAddress] = useState('')
  const [sendAmount, setSendAmount] = useState('')
  const [isSending, setIsSending] = useState(false)
  const [addressError, setAddressError] = useState<string | null>(null)
  const [sendLog, setSendLog] = useState<{ sats: number; address: string; at: Date }[]>([])

  // ── Snackbar ─────────────────────────────────────────────────────────────
  const [snack, setSnack] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null)
  const snackTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showSnack = useCallback((message: string, type: 'success' | 'error' | 'info' = 'info') => {
    if (snackTimer.current) clearTimeout(snackTimer.current)
    setSnack({ message, type })
    snackTimer.current = setTimeout(() => setSnack(null), 3500)
  }, [])

  // ── QR scanner state ─────────────────────────────────────────────────────
  const [scannerVisible, setScannerVisible] = useState(false)
  const [cameraPermission, requestCameraPermission] = useCameraPermissions()
  const scanLockRef = useRef(false)

  // ── Pulse animation for "listening" indicator ─────────────────────────────
  const pulseAnim = useRef(new Animated.Value(1)).current
  const pulseLoop = useRef<Animated.CompositeAnimation | null>(null)

  useEffect(() => {
    pulseLoop.current = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 0.25, duration: 900, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 900, useNativeDriver: true })
      ])
    )
    pulseLoop.current.start()
    return () => {
      pulseLoop.current?.stop()
    }
  }, [])

  // ── Network config ───────────────────────────────────────────────────────
  const wocConfig = {
    main: { apiBase: 'https://api.whatsonchain.com', segment: 'main', network: 'mainnet' as const },
    test: { apiBase: 'https://api.whatsonchain.com', segment: 'test', network: 'testnet' as const },
    teratest: { apiBase: 'https://api.woc-ttn.bsvb.tech', segment: 'test', network: 'testnet' as const }
  }[selectedNetwork]
  const network = wocConfig.network

  // ── Wallet helpers ───────────────────────────────────────────────────────
  const getPaymentAddress = useCallback(
    async (prefix: string): Promise<string> => {
      if (!wallet) throw new Error('Wallet not initialized')
      const { publicKey } = await wallet.getPublicKey(
        {
          protocolID: brc29ProtocolID,
          keyID: prefix + ' ' + derivationSuffix,
          counterparty: 'anyone',
          forSelf: true
        },
        adminOriginator
      )
      return PublicKey.fromString(publicKey).toAddress(network)
    },
    [wallet, adminOriginator, derivationSuffix, network]
  )

  const getUtxosForAddress = useCallback(
    async (address: string): Promise<Utxo[]> => {
      const response = await fetch(`${wocConfig.apiBase}/v1/bsv/${wocConfig.segment}/address/${address}/unspent/all`)
      const rp = await response.json()
      return rp.result
        .filter((r: any) => r.isSpentInMempoolTx === false)
        .map((r: any) => ({ txid: r.tx_hash, vout: r.tx_pos, satoshis: r.value }))
    },
    [wocConfig]
  )

  const getInternalizedUtxos = useCallback(
    async (address: string): Promise<Set<string>> => {
      if (!wallet) return new Set()
      try {
        const response = await wallet.listActions(
          { labels: [address], labelQueryMode: 'all', includeOutputs: true, limit: 1000 },
          adminOriginator
        )
        const set = new Set<string>()
        for (const action of response.actions) {
          if (action.outputs) {
            for (const output of action.outputs) {
              if (action.txid) set.add(`${action.txid}.${output.outputIndex}`)
            }
          }
        }
        return set
      } catch {
        return new Set()
      }
    },
    [wallet, adminOriginator]
  )

  const getProcessedTransactions = useCallback(
    async (address: string): Promise<ProcessedTx[]> => {
      if (!wallet) return []
      try {
        const response = await wallet.listActions(
          { labels: [address], labelQueryMode: 'all', includeLabels: true, includeOutputs: true, limit: 1000 },
          adminOriginator
        )
        return response.actions
          .map(action => {
            const totalSats = action.outputs ? action.outputs.reduce((sum, o) => sum + o.satoshis, 0) : action.satoshis
            const tsLabel = action.labels?.find(l => l.startsWith('ts:'))
            const importedAt = tsLabel ? new Date(Number(tsLabel.slice(3)) * 1000) : null
            return {
              txid: action.txid,
              satoshis: totalSats,
              status: action.status,
              importedAt
            }
          })
          .sort((a, b) => {
            if (a.importedAt && b.importedAt) return b.importedAt.getTime() - a.importedAt.getTime()
            if (a.importedAt) return -1
            if (b.importedAt) return 1
            return 0
          })
      } catch {
        return []
      }
    },
    [wallet, adminOriginator]
  )

  const fetchBalance = useCallback(
    async (address: string): Promise<number> => {
      const allUtxos = await getUtxosForAddress(address)
      const internalizedUtxos = await getInternalizedUtxos(address)
      const available = allUtxos.filter(u => !internalizedUtxos.has(`${u.txid}.${u.vout}`))
      return available.reduce((acc, r) => acc + r.satoshis, 0)
    },
    [getUtxosForAddress, getInternalizedUtxos]
  )

  const handleViewAddress = useCallback(
    async (offset: number = 0) => {
      setIsLoadingAddress(true)
      try {
        const prefix = Utils.toBase64(Utils.toArray(getCurrentDate(offset), 'utf8'))
        const address = await getPaymentAddress(prefix)
        setDaysOffset(offset)
        setDerivationPrefix(prefix)
        setPaymentAddress(address)
        setBalance(-1)
        setProcessedTxs([])
      } catch (error: any) {
        showSnack(`Error generating address: ${error.message || 'unknown error'}`, 'error')
      } finally {
        setIsLoadingAddress(false)
      }
    },
    [getPaymentAddress]
  )

  const handleCopy = useCallback(() => {
    if (!paymentAddress) return
    Clipboard.setString(paymentAddress)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [paymentAddress])

  const handleImportFunds = useCallback(async () => {
    if (!paymentAddress || !wallet || balance <= 0) return
    setIsImporting(true)
    try {
      const allUtxos = await getUtxosForAddress(paymentAddress)
      const internalizedUtxos = await getInternalizedUtxos(paymentAddress)
      const utxos = allUtxos.filter(u => !internalizedUtxos.has(`${u.txid}.${u.vout}`))

      if (utxos.length === 0) {
        showSnack('All available funds have already been imported', 'info')
        setIsImporting(false)
        return
      }

      const beef = new Beef()
      for (const utxo of utxos) {
        if (!beef.findTxid(utxo.txid)) {
          const resp = await fetch(`${wocConfig.apiBase}/v1/bsv/${wocConfig.segment}/tx/${utxo.txid}/beef`)
          const beefHex = await resp.text()
          beef.mergeBeef(Utils.toArray(beefHex, 'hex'))
        }
      }

      const txs = beef.txs
        .map(beefTx => {
          const tx = beef.findAtomicTransaction(beefTx.txid)
          const relevantUtxos = utxos.filter(o => o.txid === beefTx.txid)
          if (relevantUtxos.length === 0) return null
          const outputs: InternalizeOutput[] = relevantUtxos.map(o => ({
            outputIndex: o.vout,
            protocol: 'wallet payment' as const,
            paymentRemittance: {
              senderIdentityKey: new PrivateKey(1).toPublicKey().toString(),
              derivationPrefix,
              derivationSuffix
            }
          }))
          const satoshis = relevantUtxos.reduce((sum, o) => sum + o.satoshis, 0)
          const args: InternalizeActionArgs = {
            tx: tx!.toAtomicBEEF(),
            description: 'Legacy Bridge Payment',
            outputs,
            labels: ['legacy', 'inbound', 'bsvbrowser', paymentAddress!, `ts:${Math.floor(Date.now() / 1000)}`]
          }
          return { args, satoshis }
        })
        .filter(Boolean) as { args: InternalizeActionArgs; satoshis: number }[]

      let importedSatoshis = 0
      let failureCount = 0
      for (const { args, satoshis } of txs) {
        try {
          const response = await wallet.internalizeAction(args, adminOriginator)
          if (response?.accepted) {
            importedSatoshis += satoshis
          } else {
            failureCount++
          }
        } catch (error: any) {
          failureCount++
          showSnack(`Import failed: ${error?.message || 'unknown error'}`, 'error')
        }
      }

      if (importedSatoshis > 0) {
        showSnack(
          `Successfully imported ${importedSatoshis.toLocaleString()} sats${failureCount > 0 ? ` (${failureCount} failed)` : ''}`,
          'success'
        )
      } else if (failureCount > 0) {
        showSnack(`Failed to import ${failureCount} transaction${failureCount > 1 ? 's' : ''}`, 'error')
      }

      const [newBalance, processed] = await Promise.all([
        fetchBalance(paymentAddress),
        getProcessedTransactions(paymentAddress)
      ])
      setBalance(newBalance)
      setProcessedTxs(processed)
    } catch (error: any) {
      showSnack(`Import failed: ${error.message || 'unknown error'}`, 'error')
    } finally {
      setIsImporting(false)
    }
  }, [
    paymentAddress,
    wallet,
    balance,
    getUtxosForAddress,
    getInternalizedUtxos,
    wocConfig,
    derivationPrefix,
    derivationSuffix,
    adminOriginator,
    fetchBalance
  ])

  // ── Lifecycle ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (wallet) handleViewAddress(0)
  }, [wallet]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!paymentAddress || balance > 0 || isImporting) return
    const poll = async () => {
      if (!paymentAddress) return
      setIsCheckingBalance(true)
      try {
        const [bal, processed] = await Promise.all([
          fetchBalance(paymentAddress),
          getProcessedTransactions(paymentAddress)
        ])
        setBalance(bal)
        setProcessedTxs(processed)
      } catch {
        // ignore polling errors
      } finally {
        setIsCheckingBalance(false)
      }
    }
    poll()
    const interval = setInterval(poll, 3000)
    return () => clearInterval(interval)
  }, [paymentAddress]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (balance > 0 && !isImporting) handleImportFunds()
  }, [balance]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Address validation ───────────────────────────────────────────────────
  const validateAddress = useCallback((address: string): boolean => {
    if (!address) return false
    try {
      Utils.fromBase58Check(address)
      return true
    } catch {
      return false
    }
  }, [])

  const handleRecipientAddressChange = useCallback(
    (text: string) => {
      setRecipientAddress(text)
      if (text.length === 0) {
        setAddressError(null)
      } else if (!validateAddress(text)) {
        setAddressError(t('invalid_bsv_address'))
      } else {
        setAddressError(null)
      }
    },
    [validateAddress, t]
  )

  // ── QR scanner ───────────────────────────────────────────────────────────
  const handleQRScanned = useCallback(
    ({ data }: { data: string }) => {
      if (scanLockRef.current) return
      scanLockRef.current = true
      const raw = data
        .replace(/^bitcoin:/i, '')
        .split('?')[0]
        .trim()
      if (validateAddress(raw)) {
        setRecipientAddress(raw)
        setAddressError(null)
        setScannerVisible(false)
      } else {
        setTimeout(() => {
          scanLockRef.current = false
        }, 1500)
      }
    },
    [validateAddress]
  )

  const openScanner = useCallback(async () => {
    if (!cameraPermission?.granted) await requestCameraPermission()
    scanLockRef.current = false
    setScannerVisible(true)
  }, [cameraPermission, requestCameraPermission])

  // ── Send ─────────────────────────────────────────────────────────────────
  const handleSendBSV = useCallback(async () => {
    if (!wallet || !recipientAddress || !sendAmount) return
    const sats = Math.round(Number(sendAmount))
    if (isNaN(sats) || sats <= 0) {
      showSnack('Please enter a valid amount > 0', 'error')
      return
    }
    if (!validateAddress(recipientAddress)) {
      showSnack(t('invalid_bsv_address'), 'error')
      return
    }
    setIsSending(true)
    try {
      const lockingScript = new P2PKH().lock(recipientAddress).toHex()
      await wallet.createAction(
        {
          description: 'Send BSV to address',
          outputs: [{ lockingScript, satoshis: sats, outputDescription: 'BSV for recipient address' }],
          labels: ['legacy', 'outbound']
        },
        adminOriginator
      )
      showSnack(`Sent ${sats.toLocaleString()} sats`, 'success')
      setSendLog(prev => [{ sats, address: recipientAddress, at: new Date() }, ...prev])
      setRecipientAddress('')
      setSendAmount('')
      setAddressError(null)
    } catch (error: any) {
      showSnack(`Send failed: ${error.message || 'unknown error'}`, 'error')
    } finally {
      setIsSending(false)
    }
  }, [wallet, recipientAddress, sendAmount, validateAddress, t, adminOriginator])

  const canSend = !!recipientAddress && !!sendAmount && !addressError && !isSending

  // ── Receive tab content ──────────────────────────────────────────────────
  const renderReceiveTab = () => (
    <ScrollView style={styles.tabScroll} contentContainerStyle={styles.tabContent} keyboardShouldPersistTaps="handled">
      {/* Date navigator */}
      <View style={styles.dateRow}>
        <TouchableOpacity onPress={() => handleViewAddress(daysOffset + 1)} style={styles.dateArrow} hitSlop={8}>
          <Ionicons name="chevron-back" size={20} color={colors.accent} />
        </TouchableOpacity>
        <Text style={[styles.dateText, { color: colors.textSecondary }]}>{getCurrentDate(daysOffset)}</Text>
        <TouchableOpacity
          onPress={() => handleViewAddress(Math.max(0, daysOffset - 1))}
          style={styles.dateArrow}
          disabled={daysOffset === 0}
          hitSlop={8}
        >
          <Ionicons name="chevron-forward" size={20} color={daysOffset === 0 ? colors.textQuaternary : colors.accent} />
        </TouchableOpacity>
      </View>

      {isLoadingAddress ? (
        <View style={styles.centeredBlock}>
          <ActivityIndicator size="large" color={colors.accent} />
          <Text style={[styles.loadingText, { color: colors.textSecondary }]}>{t('generating_address')}</Text>
        </View>
      ) : !paymentAddress ? (
        <View style={styles.centeredBlock}>
          <Text style={[styles.emptyText, { color: colors.textSecondary }]}>{t('unable_to_generate_address')}</Text>
        </View>
      ) : (
        <>
          {/* QR hero */}
          <View style={styles.qrHero}>
            <View style={[styles.qrCard, { backgroundColor: '#fff', shadowColor: colors.textPrimary }]}>
              <QRCode value={paymentAddress} size={192} color="#000" backgroundColor="#fff" />
            </View>
          </View>

          {/* Address chip */}
          <TouchableOpacity
            onPress={handleCopy}
            activeOpacity={0.7}
            style={[styles.addressChip, { backgroundColor: colors.fillTertiary }]}
          >
            <Text
              style={[styles.addressChipText, { color: colors.textSecondary }]}
              numberOfLines={1}
              ellipsizeMode="middle"
            >
              {paymentAddress}
            </Text>
            <View style={[styles.copyPill, { backgroundColor: copied ? colors.success + '20' : colors.fill }]}>
              <Ionicons
                name={copied ? 'checkmark' : 'copy-outline'}
                size={16}
                color={copied ? colors.success : colors.textSecondary}
              />
              <Text style={[styles.copyPillText, { color: copied ? colors.success : colors.textSecondary }]}>
                {copied ? t('copied') : t('copy_to_clipboard')}
              </Text>
            </View>
          </TouchableOpacity>

          {/* Listening indicator */}
          <View style={styles.listeningRow}>
            <Animated.View
              style={[
                styles.listeningDot,
                {
                  backgroundColor: isImporting ? colors.success : colors.textQuaternary,
                  opacity: isImporting ? pulseAnim : 1
                }
              ]}
            />
            <Text style={[styles.listeningText, { color: colors.textTertiary }]}>Listening for transactions…</Text>
          </View>

          {/* Processed transactions (already imported into wallet) */}
          {processedTxs.length > 0 && (
            <>
              <View style={[styles.balanceRow, { borderTopColor: colors.separator, marginTop: spacing.lg }]}>
                <Text style={[styles.balanceLabel, { color: colors.textSecondary }]}>{t('imported')}</Text>
                <Text style={[styles.balanceValue, { color: colors.success }]}>
                  {processedTxs.reduce((sum, tx) => sum + tx.satoshis, 0).toLocaleString()} sats
                </Text>
              </View>
              <View style={[styles.logContainer, { borderColor: colors.separator, marginTop: spacing.md }]}>
                {processedTxs.map((tx, i) => (
                  <View
                    key={tx.txid}
                    style={[
                      styles.logEntry,
                      i < processedTxs.length - 1 && {
                        borderBottomWidth: StyleSheet.hairlineWidth,
                        borderBottomColor: colors.separator
                      }
                    ]}
                  >
                    <Ionicons name="checkmark-circle" size={14} color={colors.success} />
                    <Text style={[styles.logSats, { color: colors.success }]}>
                      +{tx.satoshis.toLocaleString()} sats
                    </Text>
                    {tx.importedAt ? (
                      <Text style={[styles.logTime, { color: colors.textTertiary }]}>
                        {formatDistanceToNow(tx.importedAt, { addSuffix: true })}
                      </Text>
                    ) : (
                      <Text
                        style={[styles.logAddress, { color: colors.textTertiary }]}
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
        </>
      )}
      <View style={{ height: insets.bottom + spacing.xxxl }} />
    </ScrollView>
  )

  // ── Send tab content ─────────────────────────────────────────────────────
  const renderSendTab = () => (
    <ScrollView
      style={styles.tabScroll}
      contentContainerStyle={styles.tabContent}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
    >
      <View style={styles.sendForm}>
        {/* Address field */}
        <View style={styles.fieldGroup}>
          <Text style={[styles.fieldLabel, { color: colors.textTertiary }]}>
            {t('recipient_address').toUpperCase()}
          </Text>
          <View
            style={[
              styles.inputRow,
              {
                backgroundColor: colors.backgroundSecondary,
                borderColor: addressError ? colors.error : colors.separator
              }
            ]}
          >
            <TextInput
              value={recipientAddress}
              onChangeText={handleRecipientAddressChange}
              placeholder={t('enter_bsv_address')}
              placeholderTextColor={colors.textQuaternary}
              autoCapitalize="none"
              autoCorrect={false}
              style={[styles.input, { color: colors.textPrimary }]}
            />
            <TouchableOpacity onPress={openScanner} style={styles.inputAction} accessibilityLabel="Scan QR code">
              <Ionicons name="qr-code-outline" size={20} color={colors.accent} />
            </TouchableOpacity>
          </View>
          {addressError ? (
            <Text style={[styles.fieldError, { color: colors.error }]}>{addressError}</Text>
          ) : recipientAddress.length > 0 ? (
            <Text style={[styles.fieldHint, { color: colors.success }]}>
              <Ionicons name="checkmark-circle" size={12} color={colors.success} /> Valid address
            </Text>
          ) : null}
        </View>

        {/* Amount field */}
        <View style={styles.fieldGroup}>
          <Text style={[styles.fieldLabel, { color: colors.textTertiary }]}>{t('amount_sats').toUpperCase()}</Text>
          <SatsAmountInput value={sendAmount} onChangeText={setSendAmount} />
        </View>

        {/* Send button */}
        <TouchableOpacity
          onPress={handleSendBSV}
          disabled={!canSend}
          activeOpacity={0.8}
          style={[styles.sendCTA, { backgroundColor: canSend ? colors.accent : colors.fill }]}
        >
          {isSending ? (
            <ActivityIndicator size="small" color={canSend ? colors.background : colors.textTertiary} />
          ) : (
            <>
              <Ionicons name="arrow-up-circle" size={20} color={canSend ? colors.background : colors.textTertiary} />
              <Text style={[styles.sendCTAText, { color: canSend ? colors.background : colors.textTertiary }]}>
                {t('send_bsv')}
              </Text>
            </>
          )}
        </TouchableOpacity>

        {/* Send log */}
        {sendLog.length > 0 && (
          <View style={[styles.logContainer, { borderColor: colors.separator, marginTop: spacing.xl }]}>
            {sendLog.map((entry, i) => (
              <View
                key={i}
                style={[
                  styles.logEntry,
                  i < sendLog.length - 1 && {
                    borderBottomWidth: StyleSheet.hairlineWidth,
                    borderBottomColor: colors.separator
                  }
                ]}
              >
                <Text style={[styles.logSats, { color: colors.error }]}>-{entry.sats.toLocaleString()} sats</Text>
                <Text
                  style={[styles.logAddress, { color: colors.textTertiary }]}
                  numberOfLines={1}
                  ellipsizeMode="middle"
                >
                  {entry.address}
                </Text>
                <Text style={[styles.logTime, { color: colors.textTertiary }]}>
                  {formatDistanceToNow(entry.at, { addSuffix: true })}
                </Text>
              </View>
            ))}
          </View>
        )}
      </View>
      <View style={{ height: insets.bottom + spacing.xxxl }} />
    </ScrollView>
  )

  // ── Tab bar ──────────────────────────────────────────────────────────────
  const TAB_W = 120

  const indicatorLeft = indicatorAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [2, TAB_W + 2]
  })

  // ── Root render ──────────────────────────────────────────────────────────
  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={[styles.root, { backgroundColor: colors.background, paddingTop: insets.top }]}>
        {/* ── Header ─────────────────────────────────────────────────────── */}
        <View style={[styles.header, { borderBottomColor: colors.separator }]}>
          <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn}>
            <Ionicons name="chevron-back" size={24} color={colors.accent} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: colors.textPrimary }]}>{t('legacy_bridge')}</Text>
          <View style={styles.headerBtn} />
        </View>

        {/* ── Segmented control ───────────────────────────────────────────── */}
        <View style={styles.segmentWrapper}>
          <View style={[styles.segmentTrack, { backgroundColor: colors.fillTertiary }]}>
            {/* Sliding pill */}
            <Animated.View
              style={[
                styles.segmentPill,
                {
                  width: TAB_W,
                  left: indicatorLeft,
                  backgroundColor: colors.background,
                  shadowColor: colors.textPrimary
                }
              ]}
            />
            {/* Receive */}
            <TouchableOpacity
              style={[styles.segmentBtn, { width: TAB_W }]}
              onPress={() => switchTab('receive')}
              activeOpacity={1}
            >
              <Ionicons
                name={activeTab === 'receive' ? 'arrow-down-circle' : 'arrow-down-circle-outline'}
                size={16}
                color={activeTab === 'receive' ? colors.textPrimary : colors.textTertiary}
              />
              <Text
                style={[
                  styles.segmentLabel,
                  { color: activeTab === 'receive' ? colors.textPrimary : colors.textTertiary }
                ]}
              >
                {t('receive')}
              </Text>
            </TouchableOpacity>
            {/* Send */}
            <TouchableOpacity
              style={[styles.segmentBtn, { width: TAB_W }]}
              onPress={() => switchTab('send')}
              activeOpacity={1}
            >
              <Ionicons
                name={activeTab === 'send' ? 'arrow-up-circle' : 'arrow-up-circle-outline'}
                size={16}
                color={activeTab === 'send' ? colors.textPrimary : colors.textTertiary}
              />
              <Text
                style={[
                  styles.segmentLabel,
                  { color: activeTab === 'send' ? colors.textPrimary : colors.textTertiary }
                ]}
              >
                {t('send')}
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* ── Tab content ─────────────────────────────────────────────────── */}
        {activeTab === 'receive' ? renderReceiveTab() : renderSendTab()}
      </View>

      {/* ── Snackbar ─────────────────────────────────────────────────────── */}
      {snack && (
        <TouchableOpacity
          activeOpacity={0.9}
          onPress={() => setSnack(null)}
          style={[
            styles.snack,
            {
              backgroundColor: colors.backgroundElevated,
              borderColor:
                snack.type === 'success' ? colors.success : snack.type === 'error' ? colors.error : colors.separator
            }
          ]}
        >
          <Ionicons
            name={
              snack.type === 'success'
                ? 'checkmark-circle'
                : snack.type === 'error'
                  ? 'alert-circle'
                  : 'information-circle'
            }
            size={18}
            color={snack.type === 'success' ? colors.success : snack.type === 'error' ? colors.error : colors.info}
          />
          <Text style={[styles.snackText, { color: colors.textPrimary }]}>{snack.message}</Text>
        </TouchableOpacity>
      )}

      {/* ── QR Scanner Modal ─────────────────────────────────────────────── */}
      <Modal
        visible={scannerVisible}
        animationType="slide"
        onRequestClose={() => setScannerVisible(false)}
        statusBarTranslucent
      >
        <StatusBar style="light" />
        {!cameraPermission?.granted ? (
          <View style={styles.permScreen}>
            <View style={[styles.permIconWrap, { backgroundColor: 'rgba(255,255,255,0.1)' }]}>
              <Ionicons name="camera-outline" size={40} color="#fff" />
            </View>
            <Text style={styles.permTitle}>{t('scan_shares_camera_needed')}</Text>
            <Text style={styles.permBody}>{t('scan_shares_camera_description')}</Text>
            <TouchableOpacity style={styles.permBtn} onPress={requestCameraPermission}>
              <Text style={styles.permBtnText}>{t('scan_shares_grant_camera')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={{ marginTop: spacing.lg }} onPress={() => setScannerVisible(false)}>
              <Text style={styles.permBack}>{t('go_back')}</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.scannerRoot}>
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={handleQRScanned}
            />
            <View style={styles.scanOverlay}>
              <View style={styles.scanTop}>
                <TouchableOpacity style={styles.scanClose} onPress={() => setScannerVisible(false)}>
                  <Ionicons name="close" size={26} color="#fff" />
                </TouchableOpacity>
              </View>
              <View style={styles.scanMiddle}>
                <View style={styles.scanSide} />
                <View style={styles.scanWindow}>
                  <View style={[styles.corner, styles.cTL]} />
                  <View style={[styles.corner, styles.cTR]} />
                  <View style={[styles.corner, styles.cBL]} />
                  <View style={[styles.corner, styles.cBR]} />
                </View>
                <View style={styles.scanSide} />
              </View>
              <View style={styles.scanBottom}>
                <Text style={styles.scanHint}>{t('scan_bsv_address_hint')}</Text>
              </View>
            </View>
          </View>
        )}
      </Modal>
    </KeyboardAvoidingView>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  root: {
    flex: 1
  },

  // ── Header ─────────────────────────────────────────────────────────────
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth
  },
  headerBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center'
  },
  headerTitle: {
    ...typography.headline,
    fontWeight: '600'
  },

  // ── Segmented control ───────────────────────────────────────────────────
  segmentWrapper: {
    alignItems: 'center',
    paddingVertical: spacing.lg
  },
  segmentTrack: {
    flexDirection: 'row',
    borderRadius: radii.xl,
    padding: 2,
    position: 'relative'
  },
  segmentPill: {
    position: 'absolute',
    top: 2,
    bottom: 2,
    borderRadius: radii.xl - 2,
    // subtle shadow for the floating pill effect
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 3,
    elevation: 2
  },
  segmentBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm + 2,
    zIndex: 1
  },
  segmentLabel: {
    ...typography.subhead,
    fontWeight: '500'
  },

  // ── Shared tab scroll ───────────────────────────────────────────────────
  tabScroll: {
    flex: 1
  },
  tabContent: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg
  },

  // ── Receive tab ─────────────────────────────────────────────────────────
  dateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    marginBottom: spacing.xxl
  },
  dateArrow: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center'
  },
  dateText: {
    ...typography.footnote,
    fontFamily: 'monospace',
    fontWeight: '500',
    minWidth: 100,
    textAlign: 'center',
    letterSpacing: 0.3
  },
  centeredBlock: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xxxl
  },
  loadingText: {
    ...typography.subhead,
    marginTop: spacing.md
  },
  emptyText: {
    ...typography.body
  },
  qrHero: {
    alignItems: 'center',
    marginBottom: spacing.xxl
  },
  qrCard: {
    padding: spacing.lg,
    borderRadius: radii.xl,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 16,
    elevation: 6
  },
  addressChip: {
    borderRadius: radii.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginBottom: spacing.lg,
    gap: spacing.sm
  },
  addressChipText: {
    ...typography.footnote,
    fontFamily: 'monospace',
    textAlign: 'center',
    marginBottom: spacing.xs
  },
  copyPill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    borderRadius: radii.pill,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg
  },
  copyPillText: {
    ...typography.subhead,
    fontWeight: '500'
  },
  balanceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: spacing.lg,
    marginBottom: spacing.md
  },
  balanceLabel: {
    ...typography.subhead
  },
  balanceValue: {
    ...typography.headline,
    fontWeight: '700'
  },
  logContainer: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    overflow: 'hidden',
    marginBottom: spacing.sm
  },
  logEntry: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    gap: spacing.sm
  },
  logSats: {
    ...typography.subhead,
    fontWeight: '600'
  },
  logAddress: {
    ...typography.caption1,
    fontFamily: 'monospace',
    flex: 1,
    marginHorizontal: spacing.sm
  },
  logTime: {
    ...typography.caption1,
    fontFamily: 'monospace'
  },
  listeningRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    marginBottom: spacing.md
  },
  listeningDot: {
    width: 7,
    height: 7,
    borderRadius: 4
  },
  listeningText: {
    ...typography.footnote,
    textAlign: 'center'
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radii.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    marginTop: spacing.sm
  },
  statusText: {
    ...typography.subhead
  },
  resultBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radii.md,
    borderWidth: 1,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.md,
    marginTop: spacing.md
  },
  resultText: {
    ...typography.footnote,
    fontWeight: '500',
    flex: 1
  },

  // ── Send tab ────────────────────────────────────────────────────────────
  sendForm: {
    flex: 1
  },
  fieldGroup: {
    marginBottom: spacing.xl
  },
  fieldLabel: {
    ...typography.caption2,
    fontWeight: '600',
    letterSpacing: 0.8,
    marginBottom: spacing.sm
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden'
  },
  input: {
    ...typography.body,
    flex: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md
  },
  inputAction: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center'
  },
  fieldError: {
    ...typography.caption1,
    marginTop: spacing.xs
  },
  fieldHint: {
    ...typography.caption1,
    marginTop: spacing.xs
  },
  sendCTA: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md + 2,
    borderRadius: radii.md,
    marginTop: spacing.sm
  },
  sendCTAText: {
    ...typography.subhead,
    fontWeight: '600'
  },

  // ── QR Scanner ──────────────────────────────────────────────────────────
  snack: {
    position: 'absolute',
    bottom: 32,
    left: spacing.lg,
    right: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12,
    shadowRadius: 8,
    elevation: 6
  },
  snackText: {
    ...typography.subhead,
    flex: 1
  },
  scannerRoot: {
    flex: 1,
    backgroundColor: '#000'
  },
  scanOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'space-between'
  },
  scanTop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingTop: 60,
    paddingHorizontal: spacing.lg,
    justifyContent: 'flex-start'
  },
  scanClose: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center',
    justifyContent: 'center'
  },
  scanMiddle: {
    flexDirection: 'row',
    height: 260
  },
  scanSide: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)'
  },
  scanWindow: {
    width: 260,
    height: 260
  },
  scanBottom: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    paddingTop: spacing.xxl,
    paddingHorizontal: spacing.xl
  },
  scanHint: {
    ...typography.subhead,
    color: 'rgba(255,255,255,0.8)',
    textAlign: 'center'
  },
  corner: {
    position: 'absolute',
    width: 24,
    height: 24
  },
  cTL: { top: 0, left: 0, borderTopWidth: 3, borderLeftWidth: 3, borderColor: '#fff' },
  cTR: { top: 0, right: 0, borderTopWidth: 3, borderRightWidth: 3, borderColor: '#fff' },
  cBL: { bottom: 0, left: 0, borderBottomWidth: 3, borderLeftWidth: 3, borderColor: '#fff' },
  cBR: { bottom: 0, right: 0, borderBottomWidth: 3, borderRightWidth: 3, borderColor: '#fff' },

  // ── Camera permission screen ─────────────────────────────────────────────
  permScreen: {
    flex: 1,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xxxl
  },
  permIconWrap: {
    width: 80,
    height: 80,
    borderRadius: 40,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xxl
  },
  permTitle: {
    ...typography.headline,
    color: '#fff',
    textAlign: 'center',
    marginBottom: spacing.sm
  },
  permBody: {
    ...typography.subhead,
    color: 'rgba(255,255,255,0.6)',
    textAlign: 'center',
    marginBottom: spacing.xxl
  },
  permBtn: {
    backgroundColor: '#007AFF',
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xxxl
  },
  permBtnText: {
    ...typography.headline,
    color: '#fff'
  },
  permBack: {
    ...typography.subhead,
    color: 'rgba(255,255,255,0.5)'
  }
})
