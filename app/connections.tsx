import React, { useState } from 'react'
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
  Modal,
  ScrollView,
  Alert,
} from 'react-native'
import { observer } from 'mobx-react-lite'
import { router } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { WalletClient } from '@bsv/sdk'
import type { WalletProtocol } from '@bsv/sdk'
import * as SecureStore from 'expo-secure-store'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, radii, typography } from '@/context/theme/tokens'
import { GroupedSection } from '@/components/ui/GroupedList'
import { useWallet } from '@/context/WalletContext'
import connectionStore, { type Connection } from '@/stores/ConnectionStore'
import QRScanner from '@/components/QRScanner'
import { useWalletConnection } from '@/context/WalletConnectionContext'

interface PairingParams {
  [key: string]: string  // required by Expo Router's UnknownInputParams
  topic: string
  relay: string
  backendIdentityKey: string
  protocolID: string
  keyID: string
  origin: string
  expiry: string
}

type ParseResult =
  | { params: PairingParams; error: null }
  | { params: null; error: string }

function parsePairingUri(raw: string): ParseResult {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'wallet:') return { params: null, error: 'Not a wallet:// URI' }

    const g = (k: string) => url.searchParams.get(k) ?? ''
    const topic = g('topic')
    const relay = g('relay')
    const backendIdentityKey = g('backendIdentityKey')
    const protocolID = g('protocolID')
    const keyID = g('keyID')
    const origin = g('origin')
    const expiry = g('expiry')

    // All fields required
    if (!topic || !relay || !backendIdentityKey || !protocolID || !keyID || !origin || !expiry) {
      return { params: null, error: 'QR code is missing required fields' }
    }

    // Expiry check at scan boundary (before navigating to pair screen)
    if (Date.now() / 1000 > Number(expiry)) {
      return { params: null, error: 'This QR code has expired — ask the desktop to generate a new one' }
    }

    // relay must be ws:// or wss://
    let relayUrl: URL
    try { relayUrl = new URL(relay) } catch { return { params: null, error: 'Relay URL is not valid' } }
    if (relayUrl.protocol !== 'ws:' && relayUrl.protocol !== 'wss:') {
      return { params: null, error: 'Relay must use ws:// or wss://' }
    }

    // origin must be http:// or https://
    let originUrl: URL
    try { originUrl = new URL(origin) } catch { return { params: null, error: 'Origin URL is not valid' } }
    if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') {
      return { params: null, error: 'Origin must use http:// or https://' }
    }

    // M1: relay host must match origin host — prevents QR phishing to attacker relay.
    // Only enforced for wss:// (production). ws:// is local/dev only — browsers
    // already block ws:// from https:// pages via mixed content rules, so no
    // real-world attacker can exploit a non-SSL relay.
    if (relayUrl.protocol === 'wss:' && relayUrl.hostname !== originUrl.hostname) {
      return {
        params: null,
        error: `Relay host "${relayUrl.hostname}" doesn't match origin host "${originUrl.hostname}" — this QR may be malicious`,
      }
    }

    // backendIdentityKey must be a compressed secp256k1 public key (02/03 + 32 bytes hex)
    if (!/^0[23][0-9a-fA-F]{64}$/.test(backendIdentityKey)) {
      return { params: null, error: 'Backend identity key is not a valid public key' }
    }

    // protocolID must parse as [number, string]
    let proto: unknown
    try { proto = JSON.parse(protocolID) } catch { return { params: null, error: 'protocolID is not valid JSON' } }
    if (
      !Array.isArray(proto) ||
      proto.length !== 2 ||
      typeof proto[0] !== 'number' ||
      typeof proto[1] !== 'string'
    ) {
      return { params: null, error: 'protocolID must be a [number, string] tuple' }
    }

    // Per protocol spec: keyID must equal topic (sessionId doubles as keyID)
    if (keyID !== topic) {
      return { params: null, error: 'keyID must match topic — malformed QR code' }
    }

    return { params: { topic, relay, backendIdentityKey, protocolID, keyID, origin, expiry }, error: null }
  } catch {
    return { params: null, error: 'Could not read QR code' }
  }
}

function domainFromOrigin(origin: string): string {
  try { return new URL(origin).hostname } catch { return origin }
}

export default observer(function ConnectionsScreen() {
  const { colors } = useTheme()
  const { managers } = useWallet()
  const { reconnect } = useWalletConnection()
  const insets = useSafeAreaInsets()
  const [scanning, setScanning] = useState(false)

  function handleScan(data: string) {
    setScanning(false)
    const result = parsePairingUri(data)
    if (!result.params) {
      Alert.alert('Invalid QR Code', result.error)
      return
    }
    router.push({ pathname: '/pair', params: result.params })
  }

  async function handleDisconnect(conn: Connection) {
    // Optimistically mark disconnected — will hold even if WS send fails
    connectionStore.setStatus(conn.sessionId, 'disconnected')

    if (!managers.permissionsManager) return
    try {
      const protocolID = JSON.parse(conn.protocolID) as WalletProtocol
      const wallet = new WalletClient(managers.permissionsManager, domainFromOrigin(conn.origin))
      const ws = new WebSocket(`${conn.relay}/ws?topic=${conn.sessionId}&role=mobile`)

      ws.onopen = async () => {
        try {
          // Use lastSeq + 1 so this message isn't dropped by replay protection
          const storedSeq = await SecureStore.getItemAsync(`wallet_pairing_lastseq_${conn.sessionId}`)
          const seq = storedSeq ? Number(storedSeq) + 1 : 1
          const payload = JSON.stringify({
            id: crypto.randomUUID(),
            seq,
            method: 'session_revoke',
            params: {},
          })
          const plaintext = Array.from(new TextEncoder().encode(payload))
          const { ciphertext } = await wallet.encrypt({
            protocolID,
            keyID: conn.keyID,
            counterparty: conn.backendIdentityKey,
            plaintext,
          })
          ws.send(JSON.stringify({
            topic: conn.sessionId,
            ciphertext: Buffer.from(ciphertext).toString('base64url'),
          }))
        } finally {
          ws.close()
        }
      }
      ws.onerror = () => ws.close()
    } catch (e) {
      console.warn('[connections] session_revoke failed:', e)
    }
  }

  async function handleReconnect(conn: Connection) {
    if (!managers.permissionsManager) return
    const wallet = new WalletClient(managers.permissionsManager, domainFromOrigin(conn.origin))
    await reconnect(conn, wallet)
    router.push('/pair')
  }

  const active = connectionStore.connections.filter(c => c.status === 'active')
  const inactive = connectionStore.connections.filter(c => c.status !== 'active')

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.backgroundSecondary, paddingTop: insets.top }]}>
      <View style={[styles.header, { borderBottomColor: colors.separator }]}>
        <Text style={[styles.title, { color: colors.textPrimary }]}>Connections</Text>
        <TouchableOpacity style={styles.closeBtn} onPress={() => router.back()}>
          <Ionicons name="close" size={22} color={colors.textPrimary} />
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent}>
        {connectionStore.connections.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="wifi-outline" size={48} color={colors.textSecondary} style={{ marginBottom: spacing.md }} />
            <Text style={[styles.emptyTitle, { color: colors.textPrimary }]}>No connections yet</Text>
            <Text style={[styles.emptySubtitle, { color: colors.textSecondary }]}>
              Scan a QR code from a desktop app to connect your wallet
            </Text>
          </View>
        ) : (
          <>
            {active.length > 0 && (
              <GroupedSection header="Active">
                {active.map(item => (
                  <ConnectionCard
                    key={item.sessionId}
                    item={item}
                    onDisconnect={() => void handleDisconnect(item)}
                  />
                ))}
              </GroupedSection>
            )}
            {inactive.length > 0 && (
              <GroupedSection header="Disconnected">
                {inactive.map(item => (
                  <ConnectionCard
                    key={item.sessionId}
                    item={item}
                    onReconnect={() => void handleReconnect(item)}
                    onRemove={() => connectionStore.remove(item.sessionId)}
                  />
                ))}
              </GroupedSection>
            )}
          </>
        )}
      </ScrollView>

      <View style={[styles.footer, { borderTopColor: colors.separator }]}>
        <TouchableOpacity
          style={[styles.scanBtn, { backgroundColor: colors.info }]}
          onPress={() => setScanning(true)}
        >
          <Ionicons name="qr-code-outline" size={20} color={colors.textOnAccent} style={{ marginRight: spacing.sm }} />
          <Text style={[styles.scanBtnText, { color: colors.textOnAccent }]}>Scan QR Code</Text>
        </TouchableOpacity>
      </View>

      <Modal visible={scanning} animationType="slide" onRequestClose={() => setScanning(false)}>
        <QRScanner onScan={handleScan} onClose={() => setScanning(false)} />
      </Modal>
    </SafeAreaView>
  )
})

// ── Connection card ────────────────────────────────────────────────────────────

function ConnectionCard({
  item,
  onDisconnect,
  onReconnect,
  onRemove,
}: {
  item: Connection
  onDisconnect?: () => void
  onReconnect?: () => void
  onRemove?: () => void
}) {
  const { colors } = useTheme()
  const isActive = item.status === 'active'
  const dateStr = new Date(item.connectedAt).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
  })

  return (
    <View style={[styles.card, { borderBottomColor: colors.separator }]}>
      <View style={styles.cardTop}>
        <View style={[styles.statusDot, { backgroundColor: isActive ? colors.success : colors.textTertiary }]} />
        <View style={styles.cardInfo}>
          <Text style={[styles.cardOrigin, { color: colors.textPrimary }]} numberOfLines={1}>
            {item.origin}
          </Text>
          <Text style={[styles.cardMeta, { color: colors.textSecondary }]}>
            {isActive ? 'Active' : 'Disconnected'} · {dateStr}
          </Text>
        </View>
      </View>

      <View style={[styles.cardActions, { borderTopColor: colors.separator }]}>
        {isActive ? (
          <TouchableOpacity
            style={[styles.actionBtn, { borderColor: colors.separator }]}
            onPress={onDisconnect}
            activeOpacity={0.6}
          >
            <Ionicons name="wifi-outline" size={15} color={colors.error} style={{ marginRight: spacing.xs }} />
            <Text style={[styles.actionBtnText, { color: colors.error }]}>Disconnect</Text>
          </TouchableOpacity>
        ) : (
          <>
            <TouchableOpacity
              style={[styles.actionBtn, { borderColor: colors.separator, flex: 1 }]}
              onPress={onReconnect}
              activeOpacity={0.6}
            >
              <Ionicons name="refresh-outline" size={15} color={colors.info} style={{ marginRight: spacing.xs }} />
              <Text style={[styles.actionBtnText, { color: colors.info }]}>Reconnect</Text>
            </TouchableOpacity>
            <View style={[styles.actionDivider, { backgroundColor: colors.separator }]} />
            <TouchableOpacity
              style={[styles.actionBtn, { borderColor: colors.separator, flex: 1 }]}
              onPress={onRemove}
              activeOpacity={0.6}
            >
              <Ionicons name="trash-outline" size={15} color={colors.textSecondary} style={{ marginRight: spacing.xs }} />
              <Text style={[styles.actionBtnText, { color: colors.textSecondary }]}>Remove</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </View>
  )
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: {
    ...typography.headline,
  },
  closeBtn: {
    padding: spacing.xs,
  },
  scrollContent: {
    paddingTop: spacing.xxl,
    paddingBottom: spacing.xxxl,
    flexGrow: 1,
  },
  empty: {
    alignItems: 'center',
    paddingTop: 80,
    paddingHorizontal: spacing.xxxl,
  },
  emptyTitle: {
    ...typography.headline,
    marginBottom: spacing.sm,
  },
  emptySubtitle: {
    ...typography.subhead,
    textAlign: 'center',
    lineHeight: 20,
  },
  footer: {
    padding: spacing.xl,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  scanBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.lg,
    borderRadius: radii.lg,
  },
  scanBtnText: {
    ...typography.callout,
    fontWeight: '600',
  },
  // Card
  card: {
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  cardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: spacing.md,
  },
  cardInfo: {
    flex: 1,
  },
  cardOrigin: {
    ...typography.subhead,
    fontWeight: '600',
  },
  cardMeta: {
    ...typography.caption1,
    marginTop: 2,
  },
  cardActions: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  actionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.md,
  },
  actionBtnText: {
    ...typography.footnote,
    fontWeight: '600',
  },
  actionDivider: {
    width: StyleSheet.hairlineWidth,
    alignSelf: 'stretch',
  },
})
