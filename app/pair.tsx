import React, { useEffect, useRef, useState } from 'react'
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  SafeAreaView,
  ActivityIndicator,
} from 'react-native'
import { useLocalSearchParams, router } from 'expo-router'
import { WalletClient } from '@bsv/sdk'
import { useWallet } from '@/context/WalletContext'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, radii, typography } from '@/context/theme/tokens'
import { useWalletConnection } from '@/context/WalletConnectionContext'

function domainFromOrigin(origin: string): string {
  try { return new URL(origin).hostname } catch { return origin }
}

export default function PairScreen() {
  const { colors } = useTheme()
  const { managers } = useWallet()
  const params = useLocalSearchParams<{
    topic: string
    backendIdentityKey: string
    protocolID: string
    origin: string
    expiry: string
    sig?: string
    reconnect?: string
  }>()

  const {
    status, sessionMeta, errorMsg,
    connect, disconnect,
    startNavTimer, cancelNavTimer,
  } = useWalletConnection()

  // Pre-connection validation error (before connect() is called)
  const [preConnectError, setPreConnectError] = useState<string | null>(null)

  // Whether this mount is a reconnect (explicitly passed from connections screen)
  const isReconnect = params.reconnect === 'true'

  // Track current status for unmount cleanup without re-running the effect
  const statusRef = useRef(status)
  useEffect(() => { statusRef.current = status }, [status])

  // Reset error state when leaving this screen so the next scan starts fresh
  useEffect(() => {
    return () => {
      if (statusRef.current === 'error' || statusRef.current === 'disconnected') {
        disconnect()
      }
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Validate QR params on mount — only for fresh pairings
  useEffect(() => {
    if (isReconnect) return

    const { topic, backendIdentityKey, protocolID, origin, expiry } = params
    if (!topic || !backendIdentityKey || !protocolID || !origin || !expiry) {
      setPreConnectError('Invalid or missing pairing parameters')
      return
    }
    if (Date.now() / 1000 > Number(expiry)) {
      setPreConnectError('QR code has expired')
      return
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Nav timer — start when leaving this screen, cancel when returning
  useEffect(() => {
    cancelNavTimer()
    return () => { if (status === 'connected') startNavTimer() }
  }, [status]) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleApprove() {
    if (!managers.permissionsManager) {
      setPreConnectError('Wallet not ready — please log in first')
      return
    }
    const originator = domainFromOrigin(params.origin)
    const wallet = new WalletClient(managers.permissionsManager, originator)
    try {
      await connect({
        topic:              params.topic,
        backendIdentityKey: params.backendIdentityKey,
        protocolID:         params.protocolID,
        origin:             params.origin,
        expiry:             params.expiry,
        sig:                params.sig,
      }, wallet)
    } catch (err) {
      setPreConnectError(err instanceof Error ? err.message : 'Connection failed')
    }
  }

  function handleReject() {
    disconnect()
    router.back()
  }

  const styles = makeStyles(colors)
  const displayOrigin = sessionMeta?.origin ?? params.origin ?? ''

  function renderContent() {
    // Pre-connect validation errors
    if (preConnectError) {
      return (
        <View style={styles.centered}>
          <Text style={styles.errorTitle}>Connection Failed</Text>
          <Text style={styles.errorMsg}>{preConnectError}</Text>
          <TouchableOpacity style={styles.secondaryBtn} onPress={() => { disconnect(); router.back() }}>
            <Text style={styles.secondaryBtnText}>Go Back</Text>
          </TouchableOpacity>
        </View>
      )
    }

    // Post-connect errors (from context)
    if (status === 'error' || status === 'disconnected') {
      return (
        <View style={styles.centered}>
          <Text style={styles.errorTitle}>Connection Failed</Text>
          <Text style={styles.errorMsg}>{errorMsg ?? 'Something went wrong'}</Text>
          <TouchableOpacity style={styles.secondaryBtn} onPress={() => { disconnect(); router.back() }}>
            <Text style={styles.secondaryBtnText}>Go Back</Text>
          </TouchableOpacity>
        </View>
      )
    }

    // Fresh pairing — waiting for user approval
    if (status === 'idle' && !isReconnect) {
      return (
        <View style={styles.card}>
          <Text style={styles.title}>Connect Wallet</Text>
          <Text style={styles.subtitle}>A site wants to connect to your wallet</Text>

          <View style={styles.infoBox}>
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Origin</Text>
              <Text style={styles.infoValue} numberOfLines={1}>{params.origin}</Text>
            </View>
            <View style={styles.divider} />
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Permissions</Text>
              <Text style={styles.infoValue}>getPublicKey, listOutputs + more</Text>
            </View>
          </View>

          <View style={styles.buttonRow}>
            <TouchableOpacity style={styles.rejectBtn} onPress={handleReject}>
              <Text style={styles.rejectBtnText}>Reject</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.approveBtn} onPress={() => void handleApprove()}>
              <Text style={styles.approveBtnText}>Approve</Text>
            </TouchableOpacity>
          </View>
        </View>
      )
    }

    // Connected
    if (status === 'connected') {
      return (
        <View style={styles.centered}>
          <View style={styles.successIcon}>
            <Text style={styles.successCheck}>✓</Text>
          </View>
          <Text style={styles.title}>Wallet Connected</Text>
          <Text style={styles.subtitle}>
            Ready to sign requests from{'\n'}
            <Text style={{ fontWeight: '600', color: colors.textPrimary }}>{displayOrigin}</Text>
          </Text>
          <Text style={styles.sessionId} numberOfLines={1}>
            Session: {(sessionMeta?.topic ?? params.topic)?.slice(0, 16)}…
          </Text>
        </View>
      )
    }

    // Connecting spinner (both fresh and reconnect flows)
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.info} />
        <Text style={[styles.subtitle, { marginTop: spacing.lg }]}>Connecting…</Text>
      </View>
    )
  }

  return (
    <SafeAreaView style={styles.container}>
      {renderContent()}
    </SafeAreaView>
  )
}

function makeStyles(colors: ReturnType<typeof import('@/context/theme/ThemeContext').useTheme>['colors']) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.backgroundSecondary,
      justifyContent: 'center',
      padding: spacing.xxl,
    },
    centered:  { alignItems: 'center' },
    card: {
      backgroundColor: colors.backgroundElevated,
      borderRadius: radii.xl,
      padding: spacing.xxl,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.separator,
      shadowColor: '#000',
      shadowOpacity: 0.08,
      shadowRadius: 12,
      elevation: 3,
    },
    title:    { ...typography.title2,   color: colors.textPrimary, marginBottom: spacing.xs },
    subtitle: { ...typography.subhead,  color: colors.textSecondary, marginBottom: spacing.xxl, textAlign: 'center' },
    infoBox: {
      backgroundColor: colors.backgroundSecondary,
      borderRadius: radii.lg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.separator,
      marginBottom: spacing.xxl,
    },
    infoRow:   { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: spacing.md },
    divider:   { height: StyleSheet.hairlineWidth, backgroundColor: colors.separator },
    infoLabel: { ...typography.footnote, color: colors.textSecondary },
    infoValue: { ...typography.footnote, fontWeight: '500', color: colors.textPrimary, maxWidth: '60%', textAlign: 'right' },
    buttonRow: { flexDirection: 'row', gap: spacing.md },
    rejectBtn: {
      flex: 1, paddingVertical: spacing.md + 2, borderRadius: radii.lg,
      borderWidth: StyleSheet.hairlineWidth, borderColor: colors.separator,
      backgroundColor: colors.fillSecondary, alignItems: 'center',
    },
    rejectBtnText:  { ...typography.callout, fontWeight: '500', color: colors.textPrimary },
    approveBtn:     { flex: 1, paddingVertical: spacing.md + 2, borderRadius: radii.lg, backgroundColor: colors.info, alignItems: 'center' },
    approveBtnText: { ...typography.callout, fontWeight: '600', color: colors.textOnAccent },
    secondaryBtn: {
      marginTop: spacing.xxl, paddingVertical: spacing.md, paddingHorizontal: spacing.xxl,
      borderRadius: radii.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.separator,
    },
    secondaryBtnText: { ...typography.subhead, color: colors.textSecondary },
    errorTitle:  { ...typography.title3, color: colors.error, marginBottom: spacing.sm },
    errorMsg:    { ...typography.subhead, color: colors.textSecondary, textAlign: 'center' },
    successIcon: {
      width: 64, height: 64, borderRadius: 32,
      backgroundColor: colors.fillTertiary,
      justifyContent: 'center', alignItems: 'center', marginBottom: spacing.lg,
    },
    successCheck: { fontSize: 28, color: colors.success, fontWeight: '700' },
    sessionId: { marginTop: spacing.lg, ...typography.caption2, color: colors.textTertiary },
  })
}
