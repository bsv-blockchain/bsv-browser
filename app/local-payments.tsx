/**
 * Local Payments Screen — BLE P2P Payment Transfer
 *
 * Allows two nearby phones to exchange BSV payment data over Bluetooth LE.
 * - "Request Payment" → advertises as BLE peripheral, waits for sender
 * - "Send Payment" → scans for receiver, connects, sends payment
 */

import React, { useState, useCallback, useEffect, useRef } from 'react'
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator, Image, Platform } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { router } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTranslation } from 'react-i18next'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, typography, radii } from '@/context/theme/tokens'
import { useWallet } from '@/context/WalletContext'
import { SatsAmountInput } from '@/components/wallet/SatsAmountInput'
import AmountDisplay from '@/components/wallet/AmountDisplay'
import { useBLETransfer } from '@/hooks/useBLETransfer'
import { IdentityClient, createNonce, PublicKey, P2PKH } from '@bsv/sdk'

import type { BLEPaymentPayload, PeerDisplayIdentity } from '@/utils/ble/types'
import { PEERPAY_PROTOCOL_ID, PEERPAY_LABEL, PEERPAY_DESCRIPTION } from '@/utils/ble/constants'

// ── Payment Token Creation ──
// Mirrors PeerPayClient.createPaymentToken() from @bsv/message-box-client

async function createBLEPaymentToken(
  wallet: any,
  recipientKey: string,
  amount: number,
  senderIdentityKey: string,
  originator?: string
): Promise<BLEPaymentPayload> {
  // Generate derivation nonces (same as PeerPayClient)
  const derivationPrefix = await createNonce(wallet, 'self', originator)
  const derivationSuffix = await createNonce(wallet, 'self', originator)

  // Derive recipient's public key for the payment output
  const { publicKey: derivedKeyResult } = await wallet.getPublicKey(
    {
      protocolID: PEERPAY_PROTOCOL_ID,
      keyID: `${derivationPrefix} ${derivationSuffix}`,
      counterparty: recipientKey
    },
    originator
  )

  if (!derivedKeyResult?.trim()) {
    throw new Error('Failed to derive recipient public key')
  }

  // Create P2PKH locking script
  const lockingScript = new P2PKH().lock(PublicKey.fromString(derivedKeyResult).toAddress()).toHex()

  // Create the transaction
  const paymentAction = await wallet.createAction(
    {
      description: PEERPAY_DESCRIPTION,
      labels: [PEERPAY_LABEL],
      outputs: [
        {
          satoshis: amount,
          lockingScript,
          customInstructions: JSON.stringify({
            derivationPrefix,
            derivationSuffix,
            payee: recipientKey
          }),
          outputDescription: 'BLE local payment'
        }
      ],
      options: { randomizeOutputs: false }
    },
    originator
  )

  if (!paymentAction.tx) {
    throw new Error('Transaction creation failed')
  }

  return {
    version: 1,
    senderIdentityKey,
    token: {
      customInstructions: { derivationPrefix, derivationSuffix },
      transaction: Array.from(paymentAction.tx),
      amount
    }
  }
}

// ── Identity Resolution Helper ──

async function resolveIdentity(idClient: IdentityClient, identityKey: string): Promise<PeerDisplayIdentity | null> {
  try {
    const results = await idClient.resolveByIdentityKey({
      identityKey,
      seekPermission: false
    })
    if (results.length > 0) {
      const r = results[0]
      return {
        name: r.name,
        avatarURL: r.avatarURL,
        abbreviatedKey: r.abbreviatedKey,
        identityKey: r.identityKey,
        badgeIconURL: r.badgeIconURL,
        badgeLabel: r.badgeLabel
      }
    }
  } catch {
    // Identity resolution is best-effort
  }
  return null
}

// ── Main Screen ──

export default function LocalPaymentsScreen() {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const { managers, adminOriginator } = useWallet()
  const wallet = managers?.permissionsManager

  const ble = useBLETransfer()
  const { state, logs } = ble

  const [sendAmount, setSendAmount] = useState('')
  const [identityKey, setIdentityKey] = useState('')
  const [showLogs, setShowLogs] = useState(false)
  const [isBuildingTx, setIsBuildingTx] = useState(false)
  const identityClientRef = useRef<IdentityClient | null>(null)

  // Fetch own identity key on mount
  useEffect(() => {
    wallet
      ?.getPublicKey({ identityKey: true }, adminOriginator)
      .then((r: any) => r && setIdentityKey(r.publicKey))
      .catch(() => {})
  }, [wallet, adminOriginator])

  // Initialize identity client
  useEffect(() => {
    if (!wallet) return
    try {
      identityClientRef.current = new IdentityClient(wallet as any, undefined, adminOriginator)
    } catch {
      /* ignore */
    }
  }, [wallet, adminOriginator])

  // Resolve peer identity when we get their key
  useEffect(() => {
    if (!state.peerIdentityKey || !identityClientRef.current) return
    resolveIdentity(identityClientRef.current, state.peerIdentityKey).then(identity => ble.setPeerIdentity(identity))
  }, [state.peerIdentityKey])

  // ── Handlers ──

  const handleRequestPayment = useCallback(async () => {
    if (!identityKey) return
    await ble.startReceiver(identityKey)
  }, [identityKey, ble])

  /**
   * Send Payment — Two-phase flow:
   * 1. Scan for a nearby receiver, extract their identity key from advertising
   * 2. Build a real BSV transaction targeting that receiver
   * 3. Hand off to the BLE hook for connection + chunked transfer
   */
  const handleSendPayment = useCallback(async () => {
    if (!wallet || !identityKey) return
    const sats = Math.round(Number(sendAmount))
    if (isNaN(sats) || sats <= 0) return

    setIsBuildingTx(true)

    try {
      const {
        addDeviceFoundListener,
        isBluetoothEnabled,
        requestBluetoothPermission,
        startScan: rawStartScan,
        stopScan: rawStopScan
      } = await import('munim-bluetooth')
      const { extractIdentityKey } = await import('@/utils/ble/central')
      const { BSV_PAYMENT_SERVICE_UUID: svcUUID } = await import('@/utils/ble/constants')

      // Check bluetooth permissions and state
      const granted = await requestBluetoothPermission()
      if (!granted) {
        setIsBuildingTx(false)
        return
      }
      const enabled = await isBluetoothEnabled()
      if (!enabled) {
        setIsBuildingTx(false)
        return
      }

      // Clean any previous BLE state
      ble.cancel()

      // Phase 1: Quick scan to discover the receiver's identity key
      const receiver = await new Promise<{ deviceId: string; key: string }>((resolve, reject) => {
        const timeout = setTimeout(() => {
          rawStopScan()
          reject(new Error('No receiver found nearby. Ensure the other device is in "Request Payment" mode.'))
        }, 20_000)

        const removeListener = addDeviceFoundListener(device => {
          const key = extractIdentityKey(device.advertisingData?.manufacturerData)
          if (key) {
            clearTimeout(timeout)
            removeListener()
            rawStopScan()
            resolve({ deviceId: device.id, key })
          }
        })

        rawStartScan({
          serviceUUIDs: [svcUUID],
          allowDuplicates: false,
          scanMode: 'balanced'
        })
      })

      // Phase 2: Build the real payment transaction using the receiver's key
      const payload = await createBLEPaymentToken(wallet, receiver.key, sats, identityKey, adminOriginator)

      setIsBuildingTx(false)

      // Phase 3: Use the hook for connection + chunked transfer
      // The hook will scan again briefly, rediscover the same device, and connect
      await ble.startSender(payload)
    } catch (error: any) {
      setIsBuildingTx(false)
      // Error is displayed by the hook's state
    }
  }, [wallet, identityKey, sendAmount, adminOriginator, ble])

  // ── Internalize received payment ──

  const handleAcceptPayment = useCallback(async () => {
    if (!wallet || !state.receivedPayload) return

    try {
      const payload = state.receivedPayload
      await wallet.internalizeAction(
        {
          tx: payload.token.transaction,
          outputs: [
            {
              paymentRemittance: {
                derivationPrefix: payload.token.customInstructions.derivationPrefix,
                derivationSuffix: payload.token.customInstructions.derivationSuffix,
                senderIdentityKey: payload.senderIdentityKey
              },
              outputIndex: payload.token.outputIndex ?? 0,
              protocol: 'wallet payment'
            }
          ],
          labels: [PEERPAY_LABEL],
          description: PEERPAY_DESCRIPTION
        },
        adminOriginator
      )
      // Payment accepted — show success
    } catch (error: any) {
      // Show error in UI
    }
  }, [wallet, state.receivedPayload, adminOriginator])

  // ── Render Helpers ──

  const isIdle = state.phase === 'idle'
  const isActive =
    !isIdle && state.phase !== 'error' && state.phase !== 'complete' && state.phase !== 'permission_denied'
  const canSend = sendAmount.length > 0 && Number(sendAmount) > 0 && isIdle && !!wallet

  return (
    <View style={[styles.container, { backgroundColor: colors.backgroundSecondary, paddingTop: insets.top }]}>
      {/* ── Header ── */}
      <View style={[styles.header, { borderBottomColor: colors.separator }]}>
        <TouchableOpacity
          onPress={() => {
            ble.cancel()
            router.back()
          }}
          style={styles.headerButton}
        >
          <Ionicons name="chevron-back" size={24} color={colors.accent} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.textPrimary }]}>{t('local_payments')}</Text>
        <TouchableOpacity onPress={() => setShowLogs(v => !v)} style={styles.headerButton}>
          <Ionicons name="bug-outline" size={20} color={showLogs ? colors.accent : colors.textSecondary} />
        </TouchableOpacity>
      </View>

      <ScrollView
        style={{ flex: 1, backgroundColor: colors.background }}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {/* ── Idle State: Action Buttons ── */}
        {isIdle && (
          <>
            {/* Proximity icon */}
            <View style={styles.iconContainer}>
              <View style={[styles.iconCircle, { backgroundColor: colors.accent + '15' }]}>
                <Ionicons name="bluetooth" size={48} color={colors.accent} />
              </View>
              <Text style={[styles.subtitle, { color: colors.textSecondary }]}>{t('local_payments_subtitle')}</Text>
            </View>

            {/* Amount input */}
            <View style={styles.fieldGroup}>
              <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>{t('amount_sats')}</Text>
              <SatsAmountInput value={sendAmount} onChangeText={setSendAmount} />
            </View>

            {/* Action buttons */}
            <View style={styles.buttonRow}>
              <TouchableOpacity
                style={[styles.actionButton, { backgroundColor: colors.accent }]}
                onPress={handleRequestPayment}
                disabled={!identityKey}
              >
                <Ionicons name="download-outline" size={22} color="#fff" />
                <Text style={styles.actionButtonText}>{t('request_payment')}</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.actionButton, { backgroundColor: canSend ? colors.success : colors.success + '40' }]}
                onPress={handleSendPayment}
                disabled={!canSend}
              >
                <Ionicons name="send-outline" size={22} color="#fff" />
                <Text style={styles.actionButtonText}>{t('send_payment')}</Text>
              </TouchableOpacity>
            </View>
          </>
        )}

        {/* ── Active States ── */}
        {state.phase === 'requesting_permission' && (
          <StatusDisplay
            icon="bluetooth"
            iconColor={colors.accent}
            title={t('checking_bluetooth')}
            subtitle={state.statusText}
            colors={colors}
            showSpinner
          />
        )}

        {state.phase === 'permission_denied' && (
          <StatusDisplay
            icon="close-circle"
            iconColor={colors.error}
            title={t('bluetooth_unavailable')}
            subtitle={state.errorMessage ?? ''}
            colors={colors}
          >
            <TouchableOpacity style={[styles.retryButton, { backgroundColor: colors.accent }]} onPress={ble.reset}>
              <Text style={styles.retryButtonText}>{t('go_back')}</Text>
            </TouchableOpacity>
          </StatusDisplay>
        )}

        {state.phase === 'advertising' && (
          <StatusDisplay
            icon="radio-outline"
            iconColor={colors.accent}
            title={t('waiting_for_sender')}
            subtitle={t('advertising_status')}
            colors={colors}
            showSpinner
          >
            <TouchableOpacity style={[styles.cancelButton, { borderColor: colors.separator }]} onPress={ble.cancel}>
              <Text style={[styles.cancelButtonText, { color: colors.textSecondary }]}>{t('cancel')}</Text>
            </TouchableOpacity>
          </StatusDisplay>
        )}

        {state.phase === 'scanning' && (
          <StatusDisplay
            icon="search"
            iconColor={colors.accent}
            title={t('searching_receiver')}
            subtitle={t('scanning_status')}
            colors={colors}
            showSpinner
          >
            <TouchableOpacity style={[styles.cancelButton, { borderColor: colors.separator }]} onPress={ble.cancel}>
              <Text style={[styles.cancelButtonText, { color: colors.textSecondary }]}>{t('cancel')}</Text>
            </TouchableOpacity>
          </StatusDisplay>
        )}

        {(state.phase === 'connecting' || (state.phase === 'connected' && isBuildingTx)) && (
          <StatusDisplay
            icon="link"
            iconColor={colors.accent}
            title={isBuildingTx ? t('building_transaction') : t('connecting_peer')}
            subtitle={state.statusText}
            colors={colors}
            showSpinner
            peerIdentity={state.peerIdentity}
          />
        )}

        {state.phase === 'connected' && !isBuildingTx && (
          <StatusDisplay
            icon="checkmark-circle"
            iconColor={colors.success}
            title={t('connected')}
            subtitle={state.statusText}
            colors={colors}
            peerIdentity={state.peerIdentity}
          />
        )}

        {state.phase === 'transferring' && (
          <StatusDisplay
            icon="swap-horizontal"
            iconColor={colors.accent}
            title={state.role === 'sender' ? t('sending_payment') : t('receiving_payment')}
            subtitle={`${state.progress}%`}
            colors={colors}
            peerIdentity={state.peerIdentity}
          >
            {/* Progress bar */}
            <View style={[styles.progressTrack, { backgroundColor: colors.separator }]}>
              <View style={[styles.progressFill, { backgroundColor: colors.accent, width: `${state.progress}%` }]} />
            </View>
            <TouchableOpacity
              style={[styles.cancelButton, { borderColor: colors.separator, marginTop: spacing.md }]}
              onPress={ble.cancel}
            >
              <Text style={[styles.cancelButtonText, { color: colors.textSecondary }]}>{t('cancel')}</Text>
            </TouchableOpacity>
          </StatusDisplay>
        )}

        {state.phase === 'complete' && (
          <StatusDisplay
            icon="checkmark-circle"
            iconColor={colors.success}
            title={state.role === 'sender' ? t('payment_sent') : t('payment_received')}
            subtitle=""
            colors={colors}
            peerIdentity={state.peerIdentity}
          >
            {state.amount != null && (
              <Text style={[styles.completedAmount, { color: colors.textPrimary }]}>
                <AmountDisplay>{state.amount}</AmountDisplay>
              </Text>
            )}
            {state.peerIdentityKey && (
              <Text
                style={[styles.peerKeyText, { color: colors.textSecondary }]}
                numberOfLines={1}
                ellipsizeMode="middle"
              >
                {state.role === 'sender' ? 'To: ' : 'From: '}
                {state.peerIdentityKey}
              </Text>
            )}

            {/* Accept button for receiver */}
            {state.role === 'receiver' && state.receivedPayload && (
              <TouchableOpacity
                style={[styles.acceptPaymentButton, { backgroundColor: colors.success }]}
                onPress={handleAcceptPayment}
              >
                <Ionicons name="wallet-outline" size={20} color="#fff" />
                <Text style={styles.acceptPaymentText}>{t('accept_to_wallet')}</Text>
              </TouchableOpacity>
            )}

            <TouchableOpacity
              style={[styles.retryButton, { backgroundColor: colors.accent, marginTop: spacing.md }]}
              onPress={ble.reset}
            >
              <Text style={styles.retryButtonText}>{t('done')}</Text>
            </TouchableOpacity>
          </StatusDisplay>
        )}

        {state.phase === 'error' && (
          <StatusDisplay
            icon="alert-circle"
            iconColor={colors.error}
            title={state.statusText || t('transfer_failed')}
            subtitle={state.errorMessage ?? ''}
            colors={colors}
          >
            <TouchableOpacity style={[styles.retryButton, { backgroundColor: colors.accent }]} onPress={ble.reset}>
              <Text style={styles.retryButtonText}>{t('try_again')}</Text>
            </TouchableOpacity>
          </StatusDisplay>
        )}

        {/* ── Debug Log Panel ── */}
        {showLogs && logs.length > 0 && (
          <View
            style={[styles.logPanel, { backgroundColor: colors.backgroundElevated, borderColor: colors.separator }]}
          >
            <Text style={[styles.logPanelTitle, { color: colors.textSecondary }]}>BLE Debug Log</Text>
            {logs.slice(-20).map((entry, i) => (
              <Text
                key={i}
                style={[
                  styles.logEntry,
                  {
                    color:
                      entry.direction === 'error'
                        ? colors.error
                        : entry.direction === 'tx'
                          ? colors.accent
                          : entry.direction === 'rx'
                            ? colors.success
                            : colors.textTertiary
                  }
                ]}
                numberOfLines={2}
              >
                {entry.direction.toUpperCase().padEnd(5)} {entry.message}
              </Text>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  )
}

// ── Status Display Component ──

function StatusDisplay({
  icon,
  iconColor,
  title,
  subtitle,
  colors,
  showSpinner,
  peerIdentity,
  children
}: {
  icon: keyof typeof Ionicons.glyphMap
  iconColor: string
  title: string
  subtitle: string
  colors: any
  showSpinner?: boolean
  peerIdentity?: PeerDisplayIdentity | null
  children?: React.ReactNode
}) {
  return (
    <View style={styles.statusContainer}>
      {/* Peer identity card (if available) */}
      {peerIdentity && (
        <View style={[styles.peerCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.separator }]}>
          {peerIdentity.avatarURL ? (
            <Image source={{ uri: peerIdentity.avatarURL }} style={styles.peerAvatar} />
          ) : (
            <View style={[styles.peerAvatarPlaceholder, { backgroundColor: colors.accent + '20' }]}>
              <Ionicons name="person" size={24} color={colors.accent} />
            </View>
          )}
          <View style={styles.peerInfo}>
            <Text style={[styles.peerName, { color: colors.textPrimary }]} numberOfLines={1}>
              {peerIdentity.name}
            </Text>
            <Text style={[styles.peerKey, { color: colors.textTertiary }]} numberOfLines={1} ellipsizeMode="middle">
              {peerIdentity.abbreviatedKey || peerIdentity.identityKey}
            </Text>
          </View>
          {peerIdentity.badgeIconURL ? (
            <Image source={{ uri: peerIdentity.badgeIconURL }} style={styles.peerBadge} />
          ) : null}
        </View>
      )}

      {/* Status icon */}
      <View style={[styles.statusIconCircle, { backgroundColor: iconColor + '15' }]}>
        {showSpinner ? (
          <ActivityIndicator size="large" color={iconColor} />
        ) : (
          <Ionicons name={icon} size={48} color={iconColor} />
        )}
      </View>

      <Text style={[styles.statusTitle, { color: colors.textPrimary }]}>{title}</Text>
      {subtitle ? <Text style={[styles.statusSubtitle, { color: colors.textSecondary }]}>{subtitle}</Text> : null}

      {children}
    </View>
  )
}

// ── Placeholder Payload ──

function createPlaceholderPayload(senderKey: string): BLEPaymentPayload {
  return {
    version: 1,
    senderIdentityKey: senderKey,
    token: {
      customInstructions: { derivationPrefix: '', derivationSuffix: '' },
      transaction: [],
      amount: 0
    }
  }
}

// ── Styles ──

const styles = StyleSheet.create({
  container: {
    flex: 1
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth
  },
  headerButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center'
  },
  headerTitle: {
    ...typography.headline,
    fontWeight: '600'
  },
  content: {
    padding: spacing.lg,
    paddingBottom: spacing.xxxl
  },

  // Idle state
  iconContainer: {
    alignItems: 'center',
    marginVertical: spacing.xl
  },
  iconCircle: {
    width: 96,
    height: 96,
    borderRadius: 48,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md
  },
  subtitle: {
    ...typography.subhead,
    textAlign: 'center',
    paddingHorizontal: spacing.xl
  },
  fieldGroup: {
    marginBottom: spacing.lg
  },
  fieldLabel: {
    ...typography.subhead,
    marginBottom: spacing.sm,
    fontWeight: '500'
  },
  buttonRow: {
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: spacing.sm
  },
  actionButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    borderRadius: radii.md
  },
  actionButtonText: {
    ...typography.body,
    color: '#fff',
    fontWeight: '600'
  },

  // Status display
  statusContainer: {
    alignItems: 'center',
    paddingVertical: spacing.xxl
  },
  statusIconCircle: {
    width: 96,
    height: 96,
    borderRadius: 48,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg
  },
  statusTitle: {
    ...typography.title3,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: spacing.xs
  },
  statusSubtitle: {
    ...typography.subhead,
    textAlign: 'center',
    marginBottom: spacing.lg
  },

  // Progress bar
  progressTrack: {
    height: 6,
    borderRadius: 3,
    width: '100%',
    maxWidth: 280,
    overflow: 'hidden'
  },
  progressFill: {
    height: '100%',
    borderRadius: 3
  },

  // Buttons
  cancelButton: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm,
    borderRadius: radii.md,
    borderWidth: 1,
    marginTop: spacing.lg
  },
  cancelButtonText: {
    ...typography.body,
    fontWeight: '500'
  },
  retryButton: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radii.md
  },
  retryButtonText: {
    ...typography.body,
    color: '#fff',
    fontWeight: '600'
  },

  // Completed state
  completedAmount: {
    fontSize: 34,
    fontWeight: '700',
    letterSpacing: 0.4,
    marginBottom: spacing.sm
  },
  peerKeyText: {
    ...typography.caption1,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    marginBottom: spacing.lg,
    maxWidth: 280
  },
  acceptPaymentButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xl,
    borderRadius: radii.md,
    marginTop: spacing.md
  },
  acceptPaymentText: {
    ...typography.body,
    color: '#fff',
    fontWeight: '600'
  },

  // Peer identity card
  peerCard: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: spacing.xl,
    gap: spacing.md,
    width: '100%',
    maxWidth: 320
  },
  peerAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22
  },
  peerAvatarPlaceholder: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center'
  },
  peerInfo: {
    flex: 1,
    minWidth: 0
  },
  peerName: {
    ...typography.body,
    fontWeight: '600'
  },
  peerKey: {
    ...typography.caption2,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace'
  },
  peerBadge: {
    width: 20,
    height: 20,
    borderRadius: 10
  },

  // Debug log panel
  logPanel: {
    marginTop: spacing.xl,
    padding: spacing.md,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth
  },
  logPanelTitle: {
    ...typography.caption1,
    fontWeight: '600',
    marginBottom: spacing.sm
  },
  logEntry: {
    ...typography.caption2,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    lineHeight: 16,
    marginBottom: 2
  }
})
