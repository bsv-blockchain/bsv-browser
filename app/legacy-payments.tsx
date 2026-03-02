import React, { useState, useEffect, useCallback } from 'react'
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  StyleSheet,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { router } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Clipboard from '@react-native-clipboard/clipboard'
import { toast } from 'react-toastify'
import QRCode from 'react-native-qrcode-svg'
import { PublicKey, P2PKH, Beef, Utils, PrivateKey, WalletProtocol, InternalizeActionArgs, InternalizeOutput } from '@bsv/sdk'

import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, typography, radii } from '@/context/theme/tokens'
import { useWallet } from '@/context/WalletContext'
import { BsvAmountInput } from '@/components/wallet/BsvAmountInput'

const brc29ProtocolID: WalletProtocol = [2, '3241645161d8']

interface Utxo {
  txid: string
  vout: number
  satoshis: number
}

const getCurrentDate = (daysOffset: number): string => {
  const today = new Date()
  today.setDate(today.getDate() - daysOffset)
  return today.toISOString().split('T')[0]
}

export default function LegacyPaymentsScreen() {
  const { colors, isDark } = useTheme()
  const insets = useSafeAreaInsets()
  const { managers, adminOriginator, selectedNetwork } = useWallet()
  const wallet = managers?.permissionsManager || null

  const [paymentAddress, setPaymentAddress] = useState<string | null>(null)
  const [balance, setBalance] = useState<number>(-1)
  const [isLoadingAddress, setIsLoadingAddress] = useState(false)
  const [isCheckingBalance, setIsCheckingBalance] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const [copied, setCopied] = useState(false)
  const [daysOffset, setDaysOffset] = useState(0)
  const [derivationPrefix, setDerivationPrefix] = useState(
    Utils.toBase64(Utils.toArray(getCurrentDate(0), 'utf8'))
  )
  const derivationSuffix = Utils.toBase64(Utils.toArray('legacy', 'utf8'))
  const network = selectedNetwork === 'test' ? 'testnet' : 'mainnet'
  const wocNetwork = selectedNetwork === 'test' ? 'test' : 'main'

  // Send state
  const [recipientAddress, setRecipientAddress] = useState('')
  const [sendAmount, setSendAmount] = useState('')
  const [isSending, setIsSending] = useState(false)

  // Import result state
  const [importResult, setImportResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  // Derive payment address from wallet public key
  const getPaymentAddress = useCallback(async (prefix: string): Promise<string> => {
    if (!wallet) throw new Error('Wallet not initialized')
    const { publicKey } = await wallet.getPublicKey({
      protocolID: brc29ProtocolID,
      keyID: prefix + ' ' + derivationSuffix,
      counterparty: 'anyone',
      forSelf: true,
    }, adminOriginator)
    return PublicKey.fromString(publicKey).toAddress(network)
  }, [wallet, adminOriginator, derivationSuffix, network])

  // Fetch UTXOs for address from WhatsOnChain
  const getUtxosForAddress = useCallback(async (address: string): Promise<Utxo[]> => {
    const response = await fetch(
      `https://api.whatsonchain.com/v1/bsv/${wocNetwork}/address/${address}/unspent/all`
    )
    const rp = await response.json()
    return rp.result
      .filter((r: any) => r.isSpentInMempoolTx === false)
      .map((r: any) => ({ txid: r.tx_hash, vout: r.tx_pos, satoshis: r.value }))
  }, [wocNetwork])

  // Get internalized UTXOs from transaction history
  const getInternalizedUtxos = useCallback(async (): Promise<Set<string>> => {
    if (!wallet) return new Set()
    try {
      const response = await wallet.listActions({
        labels: ['bsvbrowser', 'inbound'],
        labelQueryMode: 'all',
        includeOutputs: true,
        limit: 1000,
      }, adminOriginator)
      const set = new Set<string>()
      for (const action of response.actions) {
        if (action.inputs) {
          for (const input of action.inputs) {
            if (input.sourceOutpoint) set.add(input.sourceOutpoint)
          }
        }
      }
      return set
    } catch (error) {
      console.error('Error fetching internalized UTXOs:', error)
      return new Set()
    }
  }, [wallet, adminOriginator])

  // Fetch balance for address
  const fetchBalance = useCallback(async (address: string): Promise<number> => {
    const allUtxos = await getUtxosForAddress(address)
    const internalizedUtxos = await getInternalizedUtxos()
    const available = allUtxos.filter(utxo => {
      const outpoint = `${utxo.txid}.${utxo.vout}`
      return !internalizedUtxos.has(outpoint)
    })
    return available.reduce((acc, r) => acc + r.satoshis, 0) / 100000000
  }, [getUtxosForAddress, getInternalizedUtxos])

  // Show address for a given day offset
  const handleViewAddress = useCallback(async (offset: number = 0) => {
    setIsLoadingAddress(true)
    try {
      const prefix = Utils.toBase64(Utils.toArray(getCurrentDate(offset), 'utf8'))
      const address = await getPaymentAddress(prefix)
      setDaysOffset(offset)
      setDerivationPrefix(prefix)
      setPaymentAddress(address)
      setBalance(-1)
    } catch (error: any) {
      toast.error(`Error generating address: ${error.message || 'unknown error'}`)
    } finally {
      setIsLoadingAddress(false)
    }
  }, [getPaymentAddress])

  // Auto-show today's address on mount
  useEffect(() => {
    if (wallet) handleViewAddress(0)
  }, [wallet]) // eslint-disable-line react-hooks/exhaustive-deps

  // Check balance
  const handleCheckBalance = useCallback(async () => {
    if (!paymentAddress) return
    setIsCheckingBalance(true)
    try {
      const bal = await fetchBalance(paymentAddress)
      setBalance(bal)
    } catch (error: any) {
      toast.error(`Error checking balance: ${error.message || 'unknown error'}`)
    } finally {
      setIsCheckingBalance(false)
    }
  }, [paymentAddress, fetchBalance])

  // Copy address
  const handleCopy = useCallback(() => {
    if (!paymentAddress) return
    Clipboard.setString(paymentAddress)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [paymentAddress])

  // Import funds
  const handleImportFunds = useCallback(async () => {
    if (!paymentAddress || !wallet || balance <= 0) return

    setIsImporting(true)
    try {
      const allUtxos = await getUtxosForAddress(paymentAddress)
      const internalizedUtxos = await getInternalizedUtxos()
      const utxos = allUtxos.filter(utxo => {
        const outpoint = `${utxo.txid}.${utxo.vout}`
        return !internalizedUtxos.has(outpoint)
      })

      if (utxos.length === 0) {
        toast.info('All available funds have already been imported')
        setIsImporting(false)
        return
      }

      // Merge BEEF for the inputs
      const beef = new Beef()
      for (const utxo of utxos) {
        if (!beef.findTxid(utxo.txid)) {
          const resp = await fetch(
            `https://api.whatsonchain.com/v1/bsv/${wocNetwork}/tx/${utxo.txid}/beef`
          )
          const beefHex = await resp.text()
          beef.mergeBeef(Utils.toArray(beefHex, 'hex'))
        }
      }

      const txs = beef.txs.map(beefTx => {
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

        const args: InternalizeActionArgs = {
          tx: tx.toAtomicBEEF(),
          description: 'Legacy Bridge Payment',
          outputs,
          labels: ['legacy', 'inbound', 'bsvbrowser'],
        }
        return args
      }).filter(Boolean) as InternalizeActionArgs[]

      let successCount = 0
      let failureCount = 0
      for (const t of txs) {
        try {
          const response = await wallet.internalizeAction(t, adminOriginator)
          if (response?.accepted) {
            successCount++
          } else {
            failureCount++
            toast.error('Payment was rejected')
          }
        } catch (error: any) {
          failureCount++
          console.error('Internalize error:', error)
          toast.error(`Import failed: ${error?.message || 'unknown error'}`)
        }
      }

      // Show result banner
      if (successCount > 0) {
        setImportResult({
          type: 'success',
          message: `Successfully imported ${successCount} transaction${successCount > 1 ? 's' : ''}${failureCount > 0 ? ` (${failureCount} failed)` : ''}`
        })
      } else if (failureCount > 0) {
        setImportResult({
          type: 'error',
          message: `Failed to import ${failureCount} transaction${failureCount > 1 ? 's' : ''}`
        })
      }

      // Refresh balance
      const newBalance = await fetchBalance(paymentAddress)
      setBalance(newBalance)

      // Clear result banner after 5 seconds
      setTimeout(() => setImportResult(null), 5000)
    } catch (error: any) {
      console.error(error)
      toast.error(`Import failed: ${error.message || 'unknown error'}`)
    } finally {
      setIsImporting(false)
    }
  }, [paymentAddress, wallet, balance, getUtxosForAddress, getInternalizedUtxos, wocNetwork, derivationPrefix, derivationSuffix, adminOriginator, fetchBalance])

  // Send BSV to address
  const handleSendBSV = useCallback(async () => {
    if (!wallet || !recipientAddress || !sendAmount) return

    const amt = Number(sendAmount)
    if (isNaN(amt) || amt <= 0) {
      toast.error('Please enter a valid amount > 0')
      return
    }

    if (network === 'mainnet' && !recipientAddress.startsWith('1')) {
      toast.error('Mainnet addresses must start with "1"')
      return
    }

    setIsSending(true)
    try {
      const lockingScript = new P2PKH().lock(recipientAddress).toHex()
      await wallet.createAction({
        description: 'Send BSV to address',
        outputs: [{
          lockingScript,
          satoshis: Math.round(amt * 100000000),
          outputDescription: 'BSV for recipient address',
        }],
        labels: ['legacy', 'outbound'],
      }, adminOriginator)
      toast.success(`Sent ${amt} BSV to ${recipientAddress}`)
      setRecipientAddress('')
      setSendAmount('')
    } catch (error: any) {
      toast.error(`Send failed: ${error.message || 'unknown error'}`)
    } finally {
      setIsSending(false)
    }
  }, [wallet, recipientAddress, sendAmount, network, adminOriginator])

  // Date navigation
  const handleDateChange = useCallback((offset: number) => {
    setBalance(-1)
    handleViewAddress(offset)
  }, [handleViewAddress])

  return (
    <View style={[styles.container, { backgroundColor: colors.backgroundSecondary, paddingTop: insets.top }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.separator }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <Ionicons name="chevron-back" size={24} color={colors.accent} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.textPrimary }]}>Legacy Payments</Text>
        <View style={styles.backButton} />
      </View>

      <ScrollView
        style={{ flex: 1, backgroundColor: colors.background }}
        contentContainerStyle={styles.content}
      >
        {/* Info banner */}
        <View style={[styles.infoBanner, { backgroundColor: colors.info + '15' }]}>
          <Ionicons name="information-circle" size={20} color={colors.info} style={{ marginRight: spacing.sm }} />
          <Text style={[styles.infoText, { color: colors.info }]}>
            Address-based BSV payments to and from external wallets. A unique address is generated each day for privacy.
          </Text>
        </View>

        {/* Date navigator */}
        <View style={styles.dateRow}>
          <TouchableOpacity
            onPress={() => handleDateChange(daysOffset + 1)}
            style={styles.dateButton}
          >
            <Ionicons name="chevron-back" size={22} color={colors.accent} />
          </TouchableOpacity>
          <Text style={[styles.dateText, { color: colors.textPrimary }]}>
            {getCurrentDate(daysOffset)}
          </Text>
          <TouchableOpacity
            onPress={() => handleDateChange(Math.max(0, daysOffset - 1))}
            style={styles.dateButton}
            disabled={daysOffset === 0}
          >
            <Ionicons
              name="chevron-forward"
              size={22}
              color={daysOffset === 0 ? colors.textQuaternary : colors.accent}
            />
          </TouchableOpacity>
        </View>

        {/* Address + QR */}
        {isLoadingAddress ? (
          <View style={styles.centered}>
            <ActivityIndicator size="large" color={colors.accent} />
            <Text style={[styles.loadingText, { color: colors.textSecondary }]}>
              Generating address...
            </Text>
          </View>
        ) : paymentAddress ? (
          <>
            {/* QR Code */}
            <View style={styles.qrContainer}>
              <View style={[styles.qrWrapper, { backgroundColor: '#FFFFFF' }]}>
                <QRCode
                  value={paymentAddress}
                  size={200}
                  color="#000000"
                  backgroundColor="#FFFFFF"
                />
              </View>
            </View>

            {/* Address display */}
            <View style={[styles.addressContainer, { backgroundColor: colors.backgroundSecondary }]}>
              <Text
                style={[styles.addressText, { color: colors.textPrimary }]}
                selectable
                numberOfLines={2}
              >
                {paymentAddress}
              </Text>
              <TouchableOpacity onPress={handleCopy} style={styles.copyButton}>
                <Ionicons
                  name={copied ? 'checkmark' : 'copy-outline'}
                  size={20}
                  color={copied ? colors.success : colors.accent}
                />
              </TouchableOpacity>
            </View>

            {/* Balance */}
            <View style={styles.balanceSection}>
              <Text style={[styles.balanceLabel, { color: colors.textSecondary }]}>
                Available Balance
              </Text>
              <Text style={[styles.balanceValue, { color: colors.textPrimary }]}>
                {balance === -1 ? 'Not checked' : `${balance} BSV`}
              </Text>
            </View>

            {/* Import result banner */}
            {importResult && (
              <View style={[
                styles.resultBanner,
                {
                  backgroundColor: importResult.type === 'success' ? colors.success + '15' : colors.error + '15',
                  borderColor: importResult.type === 'success' ? colors.success : colors.error,
                }
              ]}>
                <Ionicons
                  name={importResult.type === 'success' ? 'checkmark-circle' : 'alert-circle'}
                  size={20}
                  color={importResult.type === 'success' ? colors.success : colors.error}
                />
                <Text style={[
                  styles.resultText,
                  { color: importResult.type === 'success' ? colors.success : colors.error }
                ]}>
                  {importResult.message}
                </Text>
                <TouchableOpacity
                  onPress={() => setImportResult(null)}
                  style={styles.resultDismiss}
                >
                  <Ionicons
                    name="close"
                    size={18}
                    color={importResult.type === 'success' ? colors.success : colors.error}
                  />
                </TouchableOpacity>
              </View>
            )}

            {/* Action buttons */}
            <View style={styles.buttonRow}>
              <TouchableOpacity
                onPress={handleCheckBalance}
                disabled={isCheckingBalance}
                style={[styles.actionButton, { backgroundColor: colors.backgroundSecondary, borderColor: colors.separator, borderWidth: StyleSheet.hairlineWidth }]}
              >
                {isCheckingBalance ? (
                  <ActivityIndicator size="small" color={colors.accent} />
                ) : (
                  <Ionicons name="refresh" size={18} color={colors.accent} />
                )}
                <Text style={[styles.actionButtonText, { color: colors.accent }]}>
                  Check Balance
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={handleImportFunds}
                disabled={isImporting || balance <= 0}
                style={[
                  styles.actionButton,
                  {
                    backgroundColor: balance > 0 ? colors.accent : colors.backgroundSecondary,
                    opacity: balance > 0 ? 1 : 0.5
                  }
                ]}
              >
                {isImporting ? (
                  <ActivityIndicator size="small" color={balance > 0 ? colors.background : colors.accent} />
                ) : (
                  <Ionicons name="download" size={18} color={balance > 0 ? colors.background : colors.accent} />
                )}
                <Text style={[styles.actionButtonText, { color: balance > 0 ? colors.background : colors.accent }]}>
                  Import Funds
                </Text>
              </TouchableOpacity>
            </View>
          </>
        ) : (
          <View style={styles.centered}>
            <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
              Unable to generate address
            </Text>
          </View>
        )}

        {/* Send section */}
        <View style={[styles.sendDivider, { borderTopColor: colors.separator }]} />
        <Text style={[styles.sendTitle, { color: colors.textPrimary }]}>
          Send BSV
        </Text>

        <View style={styles.fieldGroup}>
          <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>Recipient Address</Text>
          <TextInput
            value={recipientAddress}
            onChangeText={setRecipientAddress}
            placeholder="Enter BSV address"
            placeholderTextColor={colors.textTertiary}
            autoCapitalize="none"
            autoCorrect={false}
            style={[
              styles.textInput,
              {
                color: colors.textPrimary,
                backgroundColor: colors.backgroundSecondary,
                borderColor: colors.separator,
              }
            ]}
          />
        </View>

        <View style={styles.fieldGroup}>
          <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>Amount (BSV)</Text>
          <BsvAmountInput value={sendAmount} onChangeText={setSendAmount} />
        </View>

        <TouchableOpacity
          onPress={handleSendBSV}
          disabled={isSending || !recipientAddress || !sendAmount}
          style={[
            styles.sendButton,
            {
              backgroundColor: (recipientAddress && sendAmount) ? colors.accent : colors.backgroundSecondary,
              opacity: (recipientAddress && sendAmount) ? 1 : 0.5,
            }
          ]}
        >
          {isSending ? (
            <ActivityIndicator size="small" color={(recipientAddress && sendAmount) ? colors.background : colors.textSecondary} />
          ) : (
            <>
              <Ionicons
                name="send"
                size={18}
                color={(recipientAddress && sendAmount) ? colors.background : colors.textSecondary}
              />
              <Text style={[
                styles.sendButtonText,
                { color: (recipientAddress && sendAmount) ? colors.background : colors.textSecondary }
              ]}>
                Send BSV
              </Text>
            </>
          )}
        </TouchableOpacity>

        <View style={{ height: insets.bottom + 40 }} />
      </ScrollView>
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
  content: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
  },
  infoBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: spacing.md,
    borderRadius: radii.md,
    marginBottom: spacing.lg,
  },
  infoText: {
    ...typography.footnote,
    flex: 1,
  },
  dateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xl,
    gap: spacing.lg,
  },
  dateButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dateText: {
    ...typography.body,
    fontFamily: 'monospace',
    fontWeight: '500',
    minWidth: 110,
    textAlign: 'center',
  },
  centered: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xxxl,
  },
  loadingText: {
    ...typography.subhead,
    marginTop: spacing.md,
  },
  qrContainer: {
    alignItems: 'center',
    marginBottom: spacing.xl,
  },
  qrWrapper: {
    padding: spacing.md,
    borderRadius: radii.lg,
  },
  addressContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md,
    borderRadius: radii.md,
    marginBottom: spacing.lg,
  },
  addressText: {
    ...typography.footnote,
    fontFamily: 'monospace',
    flex: 1,
  },
  copyButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: spacing.sm,
  },
  balanceSection: {
    alignItems: 'center',
    marginBottom: spacing.xl,
  },
  balanceLabel: {
    ...typography.subhead,
    marginBottom: spacing.xs,
  },
  balanceValue: {
    fontSize: 28,
    fontWeight: '700',
  },
  buttonRow: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  actionButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.md,
    borderRadius: radii.md,
    gap: spacing.sm,
  },
  actionButtonText: {
    ...typography.subhead,
    fontWeight: '600',
  },
  emptyText: {
    ...typography.body,
  },
  sendDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: spacing.xxxl,
    marginBottom: spacing.xl,
  },
  sendTitle: {
    ...typography.title3,
    marginBottom: spacing.md,
  },
  fieldGroup: {
    marginBottom: spacing.lg,
  },
  fieldLabel: {
    ...typography.footnote,
    fontWeight: '500',
    marginBottom: spacing.sm,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  textInput: {
    ...typography.body,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  sendButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.md,
    borderRadius: radii.md,
    gap: spacing.sm,
  },
  sendButtonText: {
    ...typography.subhead,
    fontWeight: '600',
  },
  resultBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    marginBottom: spacing.lg,
  },
  resultText: {
    ...typography.subhead,
    fontWeight: '500',
    flex: 1,
  },
  resultDismiss: {
    padding: spacing.xs,
  },
})
