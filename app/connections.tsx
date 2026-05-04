import React, { useEffect, useState } from 'react'
import { View, Text, TouchableOpacity, StyleSheet, Modal, ScrollView, Alert } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { observer } from 'mobx-react-lite'
import { router, useLocalSearchParams } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { WalletClient } from '@bsv/sdk'
import type { WalletProtocol } from '@bsv/sdk'
import * as SecureStore from 'expo-secure-store'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '@/context/theme/ThemeContext'
import { useTranslation } from 'react-i18next'
import { spacing, radii, typography } from '@/context/theme/tokens'
import { GroupedSection } from '@/components/ui/GroupedList'
import { ListRow } from '@/components/ui/ListRow'
import { useWallet } from '@/context/WalletContext'
import connectionStore, { type Connection } from '@/stores/ConnectionStore'
import QRScanner from '@/components/QRScanner'
import { useWalletConnection, lastSeqKey } from '@/context/WalletConnectionContext'

interface PairingParams {
  [key: string]: string // required by Expo Router's UnknownInputParams
  topic: string
  backendIdentityKey: string
  protocolID: string
  origin: string
  expiry: string
  sig: string
}

type ParseResult = { params: PairingParams; error: null } | { params: null; error: string }

function parsePairingUri(raw: string): ParseResult {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'bsv-browser:') return { params: null, error: 'Not a bsv-browser:// URI' }

    const g = (k: string) => url.searchParams.get(k) ?? ''
    const topic = g('topic')
    const backendIdentityKey = g('backendIdentityKey')
    const protocolID = g('protocolID')
    const origin = g('origin')
    const expiry = g('expiry')
    const sig = g('sig')

    if (!topic || !backendIdentityKey || !protocolID || !origin || !expiry) {
      return { params: null, error: 'QR code is missing required fields' }
    }

    if (Date.now() / 1000 > Number(expiry)) {
      return { params: null, error: 'This QR code has expired — ask the desktop to generate a new one' }
    }

    let originUrl: URL
    try {
      originUrl = new URL(origin)
    } catch {
      return { params: null, error: 'Origin URL is not valid' }
    }
    if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') {
      return { params: null, error: 'Origin must use http:// or https://' }
    }

    if (!/^0[23][0-9a-fA-F]{64}$/.test(backendIdentityKey)) {
      return { params: null, error: 'Backend identity key is not a valid public key' }
    }

    let proto: unknown
    try {
      proto = JSON.parse(protocolID)
    } catch {
      return { params: null, error: 'protocolID is not valid JSON' }
    }
    if (!Array.isArray(proto) || proto.length !== 2 || typeof proto[0] !== 'number' || typeof proto[1] !== 'string') {
      return { params: null, error: 'protocolID must be a [number, string] tuple' }
    }

    return { params: { topic, backendIdentityKey, protocolID, origin, expiry, sig }, error: null }
  } catch {
    return { params: null, error: 'Could not read QR code' }
  }
}

function domainFromOrigin(origin: string): string {
  try {
    return new URL(origin).hostname
  } catch {
    return origin
  }
}

export default observer(function ConnectionsScreen() {
  const { colors } = useTheme()
  const { t } = useTranslation()
  const { managers } = useWallet()
  const { connect, reconnect } = useWalletConnection()
  const insets = useSafeAreaInsets()
  const [scanning, setScanning] = useState(false)
  const deepLinkParams = useLocalSearchParams<PairingParams>()

  // Auto-connect when navigated here with deep link pairing params
  useEffect(() => {
    if (!deepLinkParams.topic || !managers.permissionsManager) return
    const uri = `bsv-browser://pair?topic=${deepLinkParams.topic}&backendIdentityKey=${deepLinkParams.backendIdentityKey}&protocolID=${encodeURIComponent(deepLinkParams.protocolID)}&origin=${encodeURIComponent(deepLinkParams.origin)}&expiry=${deepLinkParams.expiry}&sig=${deepLinkParams.sig}`
    handleScan(uri)
  }, [deepLinkParams.topic, managers.permissionsManager]) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleScan(data: string) {
    setScanning(false)
    const result = parsePairingUri(data)
    if (!result.params) {
      Alert.alert(t('invalid_qr_code'), result.error)
      return
    }
    if (!managers.permissionsManager) {
      Alert.alert(t('wallet_not_ready'), t('please_log_in_first'))
      return
    }
    const originator = domainFromOrigin(result.params.origin)
    const wallet = new WalletClient(managers.permissionsManager, originator)
    try {
      await connect(result.params, wallet)
    } catch (err) {
      Alert.alert(t('connection_failed'), err instanceof Error ? err.message : t('unknown_error'))
    }
  }

  async function handleDisconnect(conn: Connection) {
    connectionStore.setStatus(conn.sessionId, 'disconnected')

    if (!managers.permissionsManager) return
    try {
      const protocolID = JSON.parse(conn.protocolID) as WalletProtocol
      const wallet = new WalletClient(managers.permissionsManager, domainFromOrigin(conn.origin))
      const ws = new WebSocket(`${conn.relay}/ws?topic=${conn.sessionId}&role=mobile`)

      ws.onopen = async () => {
        try {
          const storedSeq = await SecureStore.getItemAsync(lastSeqKey(conn.sessionId))
          const seq = storedSeq ? Number(storedSeq) + 1 : 1
          const payload = JSON.stringify({
            id: crypto.randomUUID(),
            seq,
            method: 'session_revoke',
            params: {}
          })
          const plaintext = Array.from(new TextEncoder().encode(payload))
          const { ciphertext } = await wallet.encrypt({
            protocolID,
            keyID: conn.sessionId,
            counterparty: conn.backendIdentityKey,
            plaintext
          })
          ws.send(
            JSON.stringify({
              topic: conn.sessionId,
              ciphertext: Buffer.from(ciphertext).toString('base64url')
            })
          )
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
    try {
      await reconnect(conn, wallet)
    } catch (err) {
      Alert.alert(t('reconnect_failed'), err instanceof Error ? err.message : t('unknown_error'))
    }
  }

  const active = connectionStore.connections.filter(c => c.status === 'active')
  const inactive = connectionStore.connections.filter(c => c.status !== 'active')

  return (
    <View style={[styles.container, { backgroundColor: colors.backgroundSecondary, paddingTop: insets.top }]}>
      {/* Header — matches settings/payments pattern */}
      <View style={[styles.header, { borderBottomColor: colors.separator }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerButton}>
          <Ionicons name="chevron-back" size={24} color={colors.accent} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.textPrimary }]}>{t('connections')}</Text>
        <View style={styles.headerButton} />
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent}>
        {connectionStore.connections.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="wifi-outline" size={48} color={colors.textSecondary} style={{ marginBottom: spacing.md }} />
            <Text style={[styles.emptyTitle, { color: colors.textPrimary }]}>{t('no_connections_yet')}</Text>
            <Text style={[styles.emptySubtitle, { color: colors.textSecondary }]}>
              {t('no_connections_subtitle')}
            </Text>
          </View>
        ) : (
          <>
            {active.length > 0 && (
              <GroupedSection header={t('connections_active')}>
                {active.map((item, idx) => (
                  <ListRow
                    key={item.sessionId}
                    label={domainFromOrigin(item.origin)}
                    value={new Date(item.connectedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                    icon="wifi-outline"
                    iconColor={colors.success}
                    showChevron={false}
                    isLast={idx === active.length - 1}
                    trailing={
                      <TouchableOpacity
                        onPress={() => void handleDisconnect(item)}
                        style={styles.trailingAction}
                        activeOpacity={0.6}
                      >
                        <Text style={[styles.trailingActionText, { color: colors.error }]}>{t('disconnect')}</Text>
                      </TouchableOpacity>
                    }
                  />
                ))}
              </GroupedSection>
            )}
            {inactive.length > 0 && (
              <GroupedSection header={t('connections_disconnected')}>
                {inactive.map((item, idx) => (
                  <ListRow
                    key={item.sessionId}
                    label={domainFromOrigin(item.origin)}
                    icon="wifi-outline"
                    iconColor={colors.textTertiary}
                    showChevron={false}
                    isLast={idx === inactive.length - 1}
                    trailing={
                      <View style={styles.trailingRow}>
                        <TouchableOpacity
                          onPress={() => void handleReconnect(item)}
                          style={styles.trailingAction}
                          activeOpacity={0.6}
                        >
                          <Text style={[styles.trailingActionText, { color: colors.info }]}>{t('reconnect')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          onPress={() => {
                            void SecureStore.deleteItemAsync(lastSeqKey(item.sessionId))
                            connectionStore.remove(item.sessionId)
                          }}
                          style={[styles.trailingAction, { marginLeft: spacing.md }]}
                          activeOpacity={0.6}
                        >
                          <Ionicons name="trash-outline" size={16} color={colors.textTertiary} />
                        </TouchableOpacity>
                      </View>
                    }
                  />
                ))}
              </GroupedSection>
            )}
          </>
        )}

      </ScrollView>

      <View style={[styles.footer, { borderTopColor: colors.separator }]}>
        <TouchableOpacity style={[styles.scanBtn, { backgroundColor: colors.info }]} onPress={() => setScanning(true)}>
          <Ionicons name="qr-code-outline" size={20} color={colors.textOnAccent} style={{ marginRight: spacing.sm }} />
          <Text style={[styles.scanBtnText, { color: colors.textOnAccent }]}>{t('scan_qr_code')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.pasteBtn, { borderColor: colors.separator }]}
          onPress={async () => {
            const text = await Clipboard.getStringAsync()
            if (text) handleScan(text.trim())
          }}
        >
          <Ionicons name="clipboard-outline" size={18} color={colors.textSecondary} style={{ marginRight: spacing.xs }} />
          <Text style={[styles.pasteBtnText, { color: colors.textSecondary }]}>{t('paste_uri')}</Text>
        </TouchableOpacity>
      </View>

      <Modal visible={scanning} animationType="slide" onRequestClose={() => setScanning(false)}>
        <QRScanner onScan={handleScan} onClose={() => setScanning(false)} hintText={t('scan_wallet_qr_hint')} />
      </Modal>
    </View>
  )
})

// ── Styles ─────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.md,
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
  scrollContent: {
    paddingTop: spacing.xxl,
    paddingBottom: spacing.xxxl,
    flexGrow: 1
  },
  empty: {
    alignItems: 'center',
    paddingTop: 80,
    paddingHorizontal: spacing.xxxl
  },
  emptyTitle: {
    ...typography.headline,
    marginBottom: spacing.sm
  },
  emptySubtitle: {
    ...typography.subhead,
    textAlign: 'center',
    lineHeight: 20
  },
  trailingRow: {
    flexDirection: 'row',
    alignItems: 'center'
  },
  trailingAction: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm
  },
  trailingActionText: {
    ...typography.footnote,
    fontWeight: '600'
  },
  footer: {
    padding: spacing.xl,
    borderTopWidth: StyleSheet.hairlineWidth
  },
  scanBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.lg,
    borderRadius: radii.lg
  },
  scanBtnText: {
    ...typography.callout,
    fontWeight: '600'
  },
  pasteBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.md,
    marginTop: spacing.sm,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth
  },
  pasteBtnText: {
    ...typography.footnote,
    fontWeight: '500'
  }
})
