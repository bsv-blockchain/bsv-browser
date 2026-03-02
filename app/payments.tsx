import React, { useState, useEffect, useCallback, useRef } from 'react'
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  StyleSheet,
  Keyboard,
  Image
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { router } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { toast } from 'react-toastify'
import { PeerPayClient, IncomingPayment } from '@bsv/message-box-client'
import { IdentityClient, PublicKey } from '@bsv/sdk'
import type { DisplayableIdentity } from '@bsv/sdk'

import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, typography, radii } from '@/context/theme/tokens'
import { useWallet } from '@/context/WalletContext'
import { BsvAmountInput } from '@/components/wallet/BsvAmountInput'

const MESSAGE_BOX_URL_KEY = 'message_box_url'

const unique = (results: DisplayableIdentity[]) => {
  return results.filter((identity, index) => {
    return results.findIndex(i => i.identityKey === identity.identityKey) === index
  })
}

export default function PaymentsScreen() {
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const { managers, adminOriginator } = useWallet()
  const wallet = managers?.permissionsManager || null

  // --- Config state ---
  const [messageBoxUrl, setMessageBoxUrl] = useState('')
  const [urlInput, setUrlInput] = useState('')
  const [isConfigured, setIsConfigured] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [showConfig, setShowConfig] = useState(false)

  // --- PeerPay state ---
  const peerPayClientRef = useRef<PeerPayClient | null>(null)
  const [payments, setPayments] = useState<IncomingPayment[]>([])
  const [loadingPayments, setLoadingPayments] = useState(false)
  const [acceptingId, setAcceptingId] = useState<string | null>(null)

  // --- Send state ---
  const [recipientKey, setRecipientKey] = useState('')
  const [sendAmount, setSendAmount] = useState('')
  const [isSending, setIsSending] = useState(false)
  const [sendResult, setSendResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<DisplayableIdentity[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [selectedIdentity, setSelectedIdentity] = useState<DisplayableIdentity | null>(null)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const identityClientRef = useRef<IdentityClient | null>(null)

  // --- Accept result state ---
  const [acceptResult, setAcceptResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  // --- Init IdentityClient ---
  useEffect(() => {
    if (!wallet) return
    try {
      identityClientRef.current = new IdentityClient(wallet as any, undefined, adminOriginator)
    } catch (e) {
      console.error('Failed to create IdentityClient:', e)
    }
  }, [wallet, adminOriginator])

  // --- Load saved URL on mount ---
  useEffect(() => {
    (async () => {
      const saved = await AsyncStorage.getItem(MESSAGE_BOX_URL_KEY)
      if (saved) {
        setMessageBoxUrl(saved)
        setUrlInput(saved)
        setIsConfigured(true)
      } else {
        setShowConfig(true)
      }
    })()
  }, [])

  // --- Init PeerPayClient ---
  useEffect(() => {
    if (!isConfigured || !messageBoxUrl || !wallet) {
      peerPayClientRef.current = null
      return
    }
    try {
      peerPayClientRef.current = new PeerPayClient({
        messageBoxHost: messageBoxUrl,
        walletClient: wallet as any,
        originator: adminOriginator,
      })
    } catch (error) {
      console.error('Failed to create PeerPayClient:', error)
      peerPayClientRef.current = null
    }
  }, [isConfigured, messageBoxUrl, wallet, adminOriginator])

  // --- Config handlers ---
  const handleSave = useCallback(async () => {
    const trimmed = urlInput.trim().replace(/\/+$/, '')
    if (!trimmed) {
      toast.error('Please enter a valid URL')
      return
    }
    setIsSaving(true)
    try {
      await AsyncStorage.setItem(MESSAGE_BOX_URL_KEY, trimmed)
      setMessageBoxUrl(trimmed)
      setIsConfigured(true)
      setShowConfig(false)
      toast.success('Message Box URL saved')
    } catch (error: any) {
      toast.error(`Failed to save: ${error.message || 'unknown error'}`)
    } finally {
      setIsSaving(false)
    }
  }, [urlInput])

  const handleRemove = useCallback(async () => {
    await AsyncStorage.removeItem(MESSAGE_BOX_URL_KEY)
    setMessageBoxUrl('')
    setUrlInput('')
    setIsConfigured(false)
    setShowConfig(true)
    peerPayClientRef.current = null
    setPayments([])
    toast.success('Message Box URL removed')
  }, [])

  // --- Fetch incoming payments ---
  const fetchPayments = useCallback(async () => {
    const client = peerPayClientRef.current
    if (!client || !messageBoxUrl) return
    setLoadingPayments(true)
    try {
      const list = await client.listIncomingPayments(messageBoxUrl)
      setPayments(list)
    } catch (error: any) {
      console.error('Failed to fetch payments:', error)
      toast.error(`Failed to load payments: ${error.message || 'unknown error'}`)
    } finally {
      setLoadingPayments(false)
    }
  }, [messageBoxUrl])

  // Auto-fetch when configured
  useEffect(() => {
    if (isConfigured && peerPayClientRef.current) {
      fetchPayments()
    }
  }, [isConfigured, fetchPayments])

  // --- Accept payment ---
  const handleAcceptPayment = useCallback(async (payment: IncomingPayment) => {
    const client = peerPayClientRef.current
    if (!client) return
    const id = String(payment.messageId)
    setAcceptingId(id)
    try {
      await client.acceptPayment(payment)
      setAcceptResult({
        type: 'success',
        message: 'Payment accepted successfully'
      })
      fetchPayments()
      setTimeout(() => setAcceptResult(null), 5000)
    } catch (e1) {
      try {
        const list = await client.listIncomingPayments(messageBoxUrl)
        const fresh = list.find(x => String(x.messageId) === id)
        if (!fresh) throw new Error('Payment not found on refresh')
        await client.acceptPayment(fresh)
        setAcceptResult({
          type: 'success',
          message: 'Payment accepted successfully'
        })
        fetchPayments()
        setTimeout(() => setAcceptResult(null), 5000)
      } catch (e2: any) {
        setAcceptResult({
          type: 'error',
          message: `Accept failed: ${e2.message || 'unknown error'}`
        })
        setTimeout(() => setAcceptResult(null), 5000)
      }
    } finally {
      setAcceptingId(null)
    }
  }, [messageBoxUrl, fetchPayments])

  // --- Identity search ---
  const handleSearchChange = useCallback((text: string) => {
    setSearchQuery(text)
    setSelectedIdentity(null)
    setRecipientKey('')

    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)

    if (!text.trim()) {
      setSearchResults([])
      setIsSearching(false)
      return
    }

    // Check if it's a direct public key
    try {
      PublicKey.fromString(text.trim())
      setRecipientKey(text.trim())
      setSearchResults([])
      setIsSearching(false)
      return
    } catch {}

    // Debounced identity search
    setIsSearching(true)
    searchTimerRef.current = setTimeout(async () => {
      const client = identityClientRef.current
      if (!client) {
        setIsSearching(false)
        return
      }
      try {
        const results = await client.resolveByAttributes({
          attributes: { any: text.trim() },
          limit: 5,
          seekPermission: false,
        })
        // deduplicate results by their identityKey / public key
        const uniqueResults = unique(results)
        setSearchResults(uniqueResults)
      } catch (error) {
        console.error('Identity search error:', error)
        setSearchResults([])
      } finally {
        setIsSearching(false)
      }
    }, 400)
  }, [])

  const handleSelectIdentity = useCallback((identity: DisplayableIdentity) => {
    setSelectedIdentity(identity)
    setRecipientKey(identity.identityKey)
    setSearchQuery(identity.name || identity.abbreviatedKey)
    setSearchResults([])
    Keyboard.dismiss()
  }, [])

  const clearRecipient = useCallback(() => {
    setSelectedIdentity(null)
    setRecipientKey('')
    setSearchQuery('')
    setSearchResults([])
  }, [])

  // --- Send payment ---
  const handleSend = useCallback(async () => {
    const client = peerPayClientRef.current
    if (!client || !recipientKey || !sendAmount) return

    const bsv = Number(sendAmount)
    if (isNaN(bsv) || bsv <= 0) {
      toast.error('Please enter a valid amount')
      return
    }
    const sats = Math.round(bsv * 100000000)

    setIsSending(true)
    try {
      await client.sendPayment({ recipient: recipientKey, amount: sats })
      setSendResult({
        type: 'success',
        message: `Sent ${bsv} BSV successfully`
      })
      setSendAmount('')
      clearRecipient()
      fetchPayments()
      setTimeout(() => setSendResult(null), 5000)
    } catch (error: any) {
      setSendResult({
        type: 'error',
        message: `Send failed: ${error.message || 'unknown error'}`
      })
      setTimeout(() => setSendResult(null), 5000)
    } finally {
      setIsSending(false)
    }
  }, [recipientKey, sendAmount, clearRecipient, fetchPayments])

  const canSend = recipientKey.length > 0 && Number(sendAmount) > 0 && !isSending && isConfigured

  return (
    <View style={[styles.container, { backgroundColor: colors.backgroundSecondary, paddingTop: insets.top }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.separator }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerButton}>
          <Ionicons name="chevron-back" size={24} color={colors.accent} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.textPrimary }]}>Identity Payments</Text>
        <TouchableOpacity
          onPress={() => setShowConfig(v => !v)}
          style={styles.headerButton}
        >
          <Ionicons
            name="settings-outline"
            size={22}
            color={showConfig ? colors.accent : colors.textSecondary}
          />
        </TouchableOpacity>
      </View>

      <ScrollView
        style={{ flex: 1, backgroundColor: colors.background }}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {/* --- Config panel (collapsible) --- */}
        {showConfig && (
          <View style={[styles.configPanel, { backgroundColor: colors.backgroundSecondary }]}>
            <Text style={[styles.configTitle, { color: colors.textPrimary }]}>
              Message Box Server
            </Text>
            <Text style={[styles.configSubtitle, { color: colors.textSecondary }]}>
              Required to send and receive identity-based payments.
            </Text>
            <TextInput
              value={urlInput}
              onChangeText={setUrlInput}
              placeholder="https://messagebox.example.com"
              placeholderTextColor={colors.textTertiary}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              returnKeyType="done"
              onSubmitEditing={handleSave}
              style={[
                styles.urlInput,
                {
                  color: colors.textPrimary,
                  backgroundColor: colors.background,
                  borderColor: colors.separator,
                }
              ]}
            />
            <View style={styles.configActions}>
              <TouchableOpacity
                onPress={handleSave}
                disabled={isSaving || !urlInput.trim()}
                style={[
                  styles.configButton,
                  {
                    backgroundColor: urlInput.trim() ? colors.accent : colors.backgroundSecondary,
                    opacity: urlInput.trim() ? 1 : 0.5
                  }
                ]}
              >
                {isSaving ? (
                  <ActivityIndicator size="small" color={urlInput.trim() ? colors.background : colors.textSecondary} />
                ) : (
                  <Text style={[styles.configButtonText, { color: urlInput.trim() ? colors.background : colors.textSecondary }]}>
                    Save
                  </Text>
                )}
              </TouchableOpacity>
              {isConfigured && (
                <>
                  <TouchableOpacity
                    onPress={() => { setShowConfig(false); setUrlInput(messageBoxUrl) }}
                    style={[styles.configButton, { borderColor: colors.separator, borderWidth: StyleSheet.hairlineWidth }]}
                  >
                    <Text style={[styles.configButtonText, { color: colors.textSecondary }]}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={handleRemove}
                    style={[styles.configButton, { borderColor: colors.error + '40', borderWidth: StyleSheet.hairlineWidth }]}
                  >
                    <Text style={[styles.configButtonText, { color: colors.error }]}>Remove</Text>
                  </TouchableOpacity>
                </>
              )}
            </View>
          </View>
        )}

        {/* Not configured prompt */}
        {!isConfigured && !showConfig && (
          <TouchableOpacity
            onPress={() => setShowConfig(true)}
            style={[styles.setupPrompt, { backgroundColor: colors.warning + '15' }]}
          >
            <Ionicons name="alert-circle" size={20} color={colors.warning} style={{ marginRight: spacing.sm }} />
            <Text style={[styles.setupPromptText, { color: colors.warning }]}>
              Tap to configure your Message Box server
            </Text>
          </TouchableOpacity>
        )}

        {/* --- Send Payment --- */}
        <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>
          Send Payment
        </Text>

        {/* Recipient search / direct key */}
        <View style={styles.fieldGroup}>
          <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>Recipient</Text>
          {selectedIdentity ? (
            <View style={[styles.selectedRecipient, { backgroundColor: colors.backgroundSecondary }]}>
              {selectedIdentity.avatarURL ? (
                <Image source={{ uri: selectedIdentity.avatarURL }} style={styles.avatar} />
              ) : (
                <View style={[styles.avatarPlaceholder, { backgroundColor: colors.accent }]}>
                  <Text style={[styles.avatarText, { color: colors.background }]}>
                    {(selectedIdentity.name || selectedIdentity.identityKey).slice(0, 2).toUpperCase()}
                  </Text>
                </View>
              )}
              <View style={styles.selectedInfo}>
                <Text style={[styles.selectedName, { color: colors.textPrimary }]} numberOfLines={1}>
                  {selectedIdentity.name || 'Unknown'}
                </Text>
                <Text style={[styles.selectedKey, { color: colors.textSecondary }]} numberOfLines={1}>
                  {selectedIdentity.abbreviatedKey || `${selectedIdentity.identityKey.slice(0, 10)}...`}
                </Text>
              </View>
              <TouchableOpacity onPress={clearRecipient} style={styles.clearButton}>
                <Ionicons name="close-circle" size={20} color={colors.textTertiary} />
              </TouchableOpacity>
            </View>
          ) : (
            <TextInput
              value={searchQuery}
              onChangeText={handleSearchChange}
              placeholder="Search name or enter identity key"
              placeholderTextColor={colors.textTertiary}
              autoCapitalize="none"
              autoCorrect={false}
              style={[
                styles.textInput,
                {
                  color: colors.textPrimary,
                  backgroundColor: colors.backgroundSecondary,
                  borderColor: recipientKey ? colors.success : colors.separator,
                  borderWidth: recipientKey ? 1 : StyleSheet.hairlineWidth,
                }
              ]}
            />
          )}

          {/* Direct key indicator */}
          {recipientKey && !selectedIdentity && (
            <View style={styles.directKeyRow}>
              <Ionicons name="key-outline" size={14} color={colors.success} />
              <Text style={[styles.directKeyText, { color: colors.success }]}>
                Valid identity key entered
              </Text>
            </View>
          )}

          {/* Search results dropdown */}
          {(isSearching || searchResults.length > 0) && !selectedIdentity && !recipientKey && (
            <View style={[styles.searchResults, { backgroundColor: colors.backgroundSecondary, borderColor: colors.separator }]}>
              {isSearching ? (
                <View style={styles.searchLoading}>
                  <ActivityIndicator size="small" color={colors.accent} />
                  <Text style={[styles.searchLoadingText, { color: colors.textSecondary }]}>Searching...</Text>
                </View>
              ) : (
                searchResults.map((identity, idx) => (
                  <TouchableOpacity
                    key={identity.identityKey + idx}
                    onPress={() => handleSelectIdentity(identity)}
                    style={[
                      styles.searchResultRow,
                      idx < searchResults.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator }
                    ]}
                  >
                    {identity.avatarURL ? (
                      <Image source={{ uri: identity.avatarURL }} style={styles.searchAvatar} />
                    ) : (
                      <View style={[styles.searchAvatarPlaceholder, { backgroundColor: colors.accent }]}>
                        <Text style={[styles.searchAvatarText, { color: colors.background }]}>
                          {(identity.name || identity.identityKey).slice(0, 2).toUpperCase()}
                        </Text>
                      </View>
                    )}
                    <View style={styles.searchResultInfo}>
                      <Text style={[styles.searchResultName, { color: colors.textPrimary }]} numberOfLines={1}>
                        {identity.name || 'Unknown'}
                      </Text>
                      <Text style={[styles.searchResultKey, { color: colors.textSecondary }]} numberOfLines={1}>
                        {identity.abbreviatedKey || `${identity.identityKey.slice(0, 20)}...`}
                      </Text>
                    </View>
                    {identity.badgeLabel ? (
                      <View style={[styles.badge, { backgroundColor: colors.accent + '20' }]}>
                        <Text style={[styles.badgeText, { color: colors.accent }]}>{identity.badgeLabel}</Text>
                      </View>
                    ) : null}
                  </TouchableOpacity>
                ))
              )}
            </View>
          )}
        </View>

        {/* Amount */}
        <View style={styles.fieldGroup}>
          <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>Amount (BSV)</Text>
          <BsvAmountInput value={sendAmount} onChangeText={setSendAmount} />
        </View>

        {/* Send button */}
        <TouchableOpacity
          onPress={handleSend}
          disabled={!canSend}
          style={[
            styles.sendButton,
            {
              backgroundColor: canSend ? colors.accent : colors.backgroundSecondary,
              opacity: canSend ? 1 : 0.5,
            }
          ]}
        >
          {isSending ? (
            <ActivityIndicator size="small" color={canSend ? colors.background : colors.textSecondary} />
          ) : (
            <>
              <Ionicons name="send" size={18} color={canSend ? colors.background : colors.textSecondary} />
              <Text style={[styles.sendButtonText, { color: canSend ? colors.background : colors.textSecondary }]}>
                Send Payment
              </Text>
            </>
          )}
        </TouchableOpacity>

        {/* Send result banner */}
        {sendResult && (
          <View style={[
            styles.resultBanner,
            {
              backgroundColor: sendResult.type === 'success' ? colors.success + '15' : colors.error + '15',
              borderColor: sendResult.type === 'success' ? colors.success : colors.error,
            }
          ]}>
            <Ionicons
              name={sendResult.type === 'success' ? 'checkmark-circle' : 'alert-circle'}
              size={20}
              color={sendResult.type === 'success' ? colors.success : colors.error}
            />
            <Text style={[
              styles.resultText,
              { color: sendResult.type === 'success' ? colors.success : colors.error }
            ]}>
              {sendResult.message}
            </Text>
            <TouchableOpacity
              onPress={() => setSendResult(null)}
              style={styles.resultDismiss}
            >
              <Ionicons
                name="close"
                size={18}
                color={sendResult.type === 'success' ? colors.success : colors.error}
              />
            </TouchableOpacity>
          </View>
        )}

        {/* --- Incoming Payments --- */}
        {isConfigured && (
          <>
            <View style={styles.incomingSectionHeader}>
              <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>
                Incoming Payments
              </Text>
              <TouchableOpacity onPress={fetchPayments} disabled={loadingPayments}>
                <Ionicons
                  name="refresh"
                  size={22}
                  color={loadingPayments ? colors.textQuaternary : colors.accent}
                />
              </TouchableOpacity>
            </View>

            {loadingPayments && payments.length === 0 ? (
              <View style={styles.centeredSmall}>
                <ActivityIndicator size="small" color={colors.accent} />
              </View>
            ) : payments.length === 0 ? (
              <View style={styles.centeredSmall}>
                <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
                  No pending payments
                </Text>
              </View>
            ) : (
              <View style={[styles.paymentsList, { backgroundColor: colors.backgroundSecondary, borderColor: colors.separator }]}>
                {payments.map((payment, idx) => {
                  const id = String(payment.messageId)
                  const isAccepting = acceptingId === id
                  return (
                    <View
                      key={id}
                      style={[
                        styles.paymentRow,
                        idx < payments.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator }
                      ]}
                    >
                      <View style={styles.paymentInfo}>
                        <View style={[styles.amountBadge, { backgroundColor: colors.success + '20' }]}>
                          <Text style={[styles.amountBadgeText, { color: colors.success }]}>
                            {payment.token.amount} sats
                          </Text>
                        </View>
                        <Text style={[styles.paymentSender, { color: colors.textSecondary }]} numberOfLines={1}>
                          From: {payment.sender?.slice(0, 16)}...
                        </Text>
                      </View>
                      <TouchableOpacity
                        onPress={() => handleAcceptPayment(payment)}
                        disabled={isAccepting}
                        style={[styles.acceptButton, { backgroundColor: colors.accent }]}
                      >
                        {isAccepting ? (
                          <ActivityIndicator size="small" color={colors.background} />
                        ) : (
                          <Text style={[styles.acceptButtonText, { color: colors.background }]}>Accept</Text>
                        )}
                      </TouchableOpacity>
                    </View>
                  )
                })}
              </View>
            )}

            {/* Accept result banner */}
            {acceptResult && (
              <View style={[
                styles.resultBanner,
                {
                  backgroundColor: acceptResult.type === 'success' ? colors.success + '15' : colors.error + '15',
                  borderColor: acceptResult.type === 'success' ? colors.success : colors.error,
                }
              ]}>
                <Ionicons
                  name={acceptResult.type === 'success' ? 'checkmark-circle' : 'alert-circle'}
                  size={20}
                  color={acceptResult.type === 'success' ? colors.success : colors.error}
                />
                <Text style={[
                  styles.resultText,
                  { color: acceptResult.type === 'success' ? colors.success : colors.error }
                ]}>
                  {acceptResult.message}
                </Text>
                <TouchableOpacity
                  onPress={() => setAcceptResult(null)}
                  style={styles.resultDismiss}
                >
                  <Ionicons
                    name="close"
                    size={18}
                    color={acceptResult.type === 'success' ? colors.success : colors.error}
                  />
                </TouchableOpacity>
              </View>
            )}
          </>
        )}

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
  headerButton: {
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

  // Config panel
  configPanel: {
    padding: spacing.lg,
    borderRadius: radii.md,
    marginBottom: spacing.xl,
  },
  configTitle: {
    ...typography.headline,
    marginBottom: spacing.xs,
  },
  configSubtitle: {
    ...typography.footnote,
    marginBottom: spacing.md,
  },
  urlInput: {
    ...typography.body,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: spacing.md,
  },
  configActions: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  configButton: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  configButtonText: {
    ...typography.subhead,
    fontWeight: '600',
  },

  // Setup prompt
  setupPrompt: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md,
    borderRadius: radii.md,
    marginBottom: spacing.xl,
  },
  setupPromptText: {
    ...typography.subhead,
    flex: 1,
  },

  // Section
  sectionTitle: {
    ...typography.title3,
    marginBottom: spacing.md,
  },

  // Field group
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

  // Selected recipient
  selectedRecipient: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md,
    borderRadius: radii.md,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
  },
  avatarPlaceholder: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    fontSize: 13,
    fontWeight: '700',
  },
  selectedInfo: {
    flex: 1,
    marginLeft: spacing.md,
  },
  selectedName: {
    ...typography.subhead,
    fontWeight: '600',
  },
  selectedKey: {
    ...typography.caption1,
    fontFamily: 'monospace',
  },
  clearButton: {
    padding: spacing.xs,
  },

  // Direct key
  directKeyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.sm,
  },
  directKeyText: {
    ...typography.caption1,
    fontWeight: '500',
  },

  // Search results
  searchResults: {
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: spacing.sm,
    overflow: 'hidden',
  },
  searchLoading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.md,
    gap: spacing.sm,
  },
  searchLoadingText: {
    ...typography.subhead,
  },
  searchResultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md,
  },
  searchAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    marginRight: spacing.md,
  },
  searchAvatarPlaceholder: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.md,
  },
  searchAvatarText: {
    fontSize: 11,
    fontWeight: '700',
  },
  searchResultInfo: {
    flex: 1,
  },
  searchResultName: {
    ...typography.subhead,
    fontWeight: '500',
  },
  searchResultKey: {
    ...typography.caption1,
    fontFamily: 'monospace',
  },
  badge: {
    paddingHorizontal: spacing.xs,
    paddingVertical: 1,
    borderRadius: 3,
    marginLeft: spacing.sm,
    flexShrink: 1,
  },
  badgeText: {
    ...typography.caption2,
    fontWeight: '600',
    fontSize: 10,
  },

  // Send button
  sendButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.md,
    borderRadius: radii.md,
    gap: spacing.sm,
    marginBottom: spacing.xxxl,
  },
  sendButtonText: {
    ...typography.subhead,
    fontWeight: '600',
  },

  // Incoming payments
  incomingSectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  centeredSmall: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xxl,
  },
  emptyText: {
    ...typography.body,
  },
  paymentsList: {
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  paymentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  paymentInfo: {
    flex: 1,
    marginRight: spacing.md,
  },
  amountBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: 4,
    marginBottom: spacing.xs,
  },
  amountBadgeText: {
    ...typography.footnote,
    fontWeight: '600',
  },
  paymentSender: {
    ...typography.caption1,
    fontFamily: 'monospace',
  },
  acceptButton: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.sm,
    minWidth: 80,
    alignItems: 'center',
  },
  acceptButtonText: {
    ...typography.footnote,
    fontWeight: '600',
  },

  // Result banners
  resultBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    marginTop: spacing.lg,
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
