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
  Image,
  Modal,
  Platform
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { router } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import QRScanner from '@/components/QRScanner'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { toast } from 'react-toastify'
import { PeerPayClient, IncomingPayment } from '@bsv/message-box-client'
import { IdentityClient, PublicKey, StorageDownloader } from '@bsv/sdk'
import type { DisplayableIdentity } from '@bsv/sdk'

import { useTranslation } from 'react-i18next'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, typography, radii } from '@/context/theme/tokens'
import { useWallet } from '@/context/WalletContext'
import { AmountInput } from '@/components/wallet/AmountInput'
import AmountDisplay from '@/components/wallet/AmountDisplay'
import { formatAmount } from '@/utils/amountFormatHelpers'
import { ExchangeRateContext } from '@/context/ExchangeRateContext'

const MESSAGE_BOX_URL_KEY = 'message_box_url'
const DEFAULT_MESSAGE_BOX_URL = 'https://messagebox.babbage.systems'

const unique = (results: DisplayableIdentity[]) => {
  return results.filter((identity, index) => {
    return results.findIndex(i => i.identityKey === identity.identityKey) === index
  })
}

async function resolveAvatarURL(urls: (string | undefined)[]): Promise<string | undefined> {
  const defined = urls.filter((u): u is string => !!u)
  const httpUrl = defined.find(u => u.startsWith('http'))
  if (httpUrl) return httpUrl
  const nonHttp = defined.find(u => !!u)
  if (!nonHttp) return undefined
  try {
    const downloader = new StorageDownloader()
    const resolved = await downloader.resolve(nonHttp)
    return resolved[0] ?? nonHttp
  } catch {
    return nonHttp
  }
}

async function mergeIdentityRecords(records: DisplayableIdentity[]): Promise<DisplayableIdentity | null> {
  const merged = records.reduce<DisplayableIdentity | null>((acc, cur) => {
    if (!acc) return cur
    return {
      identityKey: acc.identityKey,
      name: acc.name || cur.name,
      avatarURL: acc.avatarURL || cur.avatarURL,
      abbreviatedKey: acc.abbreviatedKey || cur.abbreviatedKey,
      badgeIconURL: acc.badgeIconURL || cur.badgeIconURL,
      badgeLabel: acc.badgeLabel || cur.badgeLabel,
      badgeClickURL: acc.badgeClickURL || cur.badgeClickURL
    }
  }, null)
  if (!merged) return null
  const avatarURL = (await resolveAvatarURL(records.map(r => r.avatarURL))) || ''
  return { ...merged, avatarURL }
}

async function resolveIdentity(
  idClient: IdentityClient,
  sender: string
): Promise<readonly [string, DisplayableIdentity | null]> {
  try {
    const results = await idClient.resolveByIdentityKey({ identityKey: sender, seekPermission: false })
    return [sender, await mergeIdentityRecords(results)] as const
  } catch {
    return [sender, null] as const
  }
}

async function searchIdentities(idClient: IdentityClient, text: string): Promise<DisplayableIdentity[]> {
  const results = await idClient.resolveByAttributes({
    attributes: { any: text.trim() },
    limit: 5,
    seekPermission: false
  })
  return unique(results)
}

function useIdentitySearch(wallet: any, adminOriginator: string | undefined) {
  const identityClientRef = useRef<IdentityClient | null>(null)
  useEffect(() => {
    if (!wallet) return
    try {
      identityClientRef.current = new IdentityClient(wallet, undefined, adminOriginator)
    } catch {}
  }, [wallet, adminOriginator])

  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<DisplayableIdentity[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [selectedIdentity, setSelectedIdentity] = useState<DisplayableIdentity | null>(null)
  const [recipientKey, setRecipientKey] = useState('')
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── QR scanner state ────────────────────────────────────────────────────────
  const [scannerVisible, setScannerVisible] = useState(false)

  const handleSearchChange = useCallback(
    (text: string) => {
      setSearchQuery(text)
      setSelectedIdentity(null)
      setRecipientKey('')
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
      if (!text.trim()) {
        setSearchResults([])
        setIsSearching(false)
        return
      }
      try {
        PublicKey.fromString(text.trim())
        setRecipientKey(text.trim())
        setSearchResults([])
        setIsSearching(false)
        return
      } catch {}
      setIsSearching(true)
      searchTimerRef.current = setTimeout(async () => {
        const client = identityClientRef.current
        if (!client) {
          setIsSearching(false)
          return
        }
        try {
          setSearchResults(await searchIdentities(client, text))
        } catch (error) {
          console.error('Identity search error:', error)
          setSearchResults([])
        } finally {
          setIsSearching(false)
        }
      }, 400)
    },
    [identityClientRef]
  )

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

  // ── QR scanner handlers ─────────────────────────────────────────────────────
  const handleQRScanned = useCallback((data: string) => {
    const raw = data.trim()
    try {
      PublicKey.fromString(raw)
      setSearchQuery(raw)
      setRecipientKey(raw)
      setSelectedIdentity(null)
      setSearchResults([])
      setScannerVisible(false)
    } catch {
      // Not a valid compressed public key — QRScanner will auto-retry after delay
    }
  }, [])

  const openScanner = useCallback(() => {
    setScannerVisible(true)
  }, [])

  return {
    identityClientRef,
    searchQuery,
    searchResults,
    isSearching,
    selectedIdentity,
    recipientKey,
    handleSearchChange,
    handleSelectIdentity,
    clearRecipient,
    scannerVisible,
    setScannerVisible,
    handleQRScanned,
    openScanner
  }
}

async function sendPayment(client: PeerPayClient, recipientKey: string, sendAmount: string): Promise<{ sats: number }> {
  const sats = Math.round(Number(sendAmount))
  if (Number.isNaN(sats) || sats <= 0) throw new RangeError('invalid_amount')
  await client.sendPayment({ recipient: recipientKey, amount: sats })
  return { sats }
}

async function acceptWithRetry(
  client: PeerPayClient,
  messageBoxUrl: string,
  payment: IncomingPayment,
  description: string,
  internalize: (p: IncomingPayment, d: string) => Promise<void>
): Promise<void> {
  try {
    await internalize(payment, description)
  } catch {
    const list = await client.listIncomingPayments(messageBoxUrl)
    const fresh = list.find(x => String(x.messageId) === String(payment.messageId))
    if (!fresh) throw new Error('Payment not found on refresh')
    await internalize(fresh, description)
  }
}

function useMessageBoxConfig(t: ReturnType<typeof import('react-i18next').useTranslation>['t']) {
  const [messageBoxUrl, setMessageBoxUrl] = useState(DEFAULT_MESSAGE_BOX_URL)
  const [urlInput, setUrlInput] = useState(DEFAULT_MESSAGE_BOX_URL)
  const [isSaving, setIsSaving] = useState(false)
  const [showConfig, setShowConfig] = useState(false)

  useEffect(() => {
    AsyncStorage.getItem(MESSAGE_BOX_URL_KEY).then(saved => {
      if (saved) {
        setMessageBoxUrl(saved)
        setUrlInput(saved)
        if (saved === 'noMessageBox') setShowConfig(true)
      }
    })
  }, [])

  const handleSave = useCallback(
    async (input: string) => {
      const trimmed = input.trim().replace(/\/+$/, '')
      if (!trimmed) {
        toast.error(t('enter_valid_url'))
        return
      }
      setIsSaving(true)
      try {
        await AsyncStorage.setItem(MESSAGE_BOX_URL_KEY, trimmed)
        setMessageBoxUrl(trimmed)
        setShowConfig(false)
        toast.success(t('message_box_saved'))
      } catch (error: any) {
        toast.error(`Failed to save: ${error.message || 'unknown error'}`)
      } finally {
        setIsSaving(false)
      }
    },
    [t]
  )

  const handleReset = useCallback(async () => {
    await AsyncStorage.removeItem(MESSAGE_BOX_URL_KEY)
    setMessageBoxUrl(DEFAULT_MESSAGE_BOX_URL)
    setUrlInput(DEFAULT_MESSAGE_BOX_URL)
    setShowConfig(false)
    toast.success(t('message_box_removed'))
  }, [t])

  const handleNone = useCallback(async () => {
    const noneValue = 'noMessageBox'
    setIsSaving(true)
    try {
      await AsyncStorage.setItem(MESSAGE_BOX_URL_KEY, noneValue)
      setMessageBoxUrl(noneValue)
      setUrlInput(noneValue)
      setShowConfig(true)
      toast.success(t('message_box_removed'))
    } catch (error: any) {
      toast.error(`Failed to save: ${error.message || 'unknown error'}`)
    } finally {
      setIsSaving(false)
    }
  }, [t])

  return {
    messageBoxUrl,
    urlInput,
    setUrlInput,
    isSaving,
    showConfig,
    setShowConfig,
    handleSave,
    handleReset,
    handleNone
  }
}

interface ResultBannerProps {
  readonly result: { type: 'success' | 'error'; message: string }
  readonly onDismiss: () => void
  readonly colors: ReturnType<typeof import('@/context/theme/ThemeContext').useTheme>['colors']
}
function ResultBanner({ result, onDismiss, colors }: ResultBannerProps) {
  const isSuccess = result.type === 'success'
  const color = isSuccess ? colors.success : colors.error
  return (
    <View style={[styles.resultBanner, { backgroundColor: color + '15', borderColor: color }]}>
      <Ionicons name={isSuccess ? 'checkmark-circle' : 'alert-circle'} size={20} color={color} />
      <Text style={[styles.resultText, { color }]}>{result.message}</Text>
      <TouchableOpacity onPress={onDismiss} style={styles.resultDismiss}>
        <Ionicons name="close" size={18} color={color} />
      </TouchableOpacity>
    </View>
  )
}

interface IncomingPaymentsSectionProps {
  readonly isConfigured: boolean
  readonly loadingPayments: boolean
  readonly payments: IncomingPayment[]
  readonly senderIdentities: Record<string, DisplayableIdentity | null>
  readonly acceptingId: string | null
  readonly acceptingAll: boolean
  readonly editingNoteId: string | null
  readonly paymentNotes: Record<string, string>
  readonly acceptResult: { type: 'success' | 'error'; message: string } | null
  readonly colors: ReturnType<typeof import('@/context/theme/ThemeContext').useTheme>['colors']
  readonly t: ReturnType<typeof import('react-i18next').useTranslation>['t']
  readonly onRefresh: () => void
  readonly onAccept: (p: IncomingPayment) => void
  readonly onAcceptAll: () => void
  readonly onEditNote: (id: string) => void
  readonly onChangeNote: (id: string, text: string) => void
  readonly onSubmitNote: () => void
  readonly onDismissResult: () => void
}
function IncomingPaymentsSection({
  isConfigured,
  loadingPayments,
  payments,
  senderIdentities,
  acceptingId,
  acceptingAll,
  editingNoteId,
  paymentNotes,
  acceptResult,
  colors,
  t,
  onRefresh,
  onAccept,
  onAcceptAll,
  onEditNote,
  onChangeNote,
  onSubmitNote,
  onDismissResult
}: IncomingPaymentsSectionProps) {
  if (!isConfigured) return null
  return (
    <>
      <View style={styles.incomingSectionHeader}>
        <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>{t('incoming_payments')}</Text>
        <View style={styles.headerActions}>
          {payments.length > 0 && (
            <TouchableOpacity
              onPress={onAcceptAll}
              disabled={acceptingAll || loadingPayments}
              style={[styles.acceptAllButton, { opacity: acceptingAll || loadingPayments ? 0.5 : 1 }]}
            >
              {acceptingAll ? (
                <ActivityIndicator size="small" color={colors.accent} />
              ) : (
                <Text style={[styles.acceptAllButtonText, { color: colors.accent }]}>{t('accept_all')}</Text>
              )}
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={onRefresh} disabled={loadingPayments || acceptingAll}>
            <Ionicons
              name="refresh"
              size={22}
              color={loadingPayments || acceptingAll ? colors.textQuaternary : colors.accent}
            />
          </TouchableOpacity>
        </View>
      </View>

      {loadingPayments && payments.length === 0 && (
        <View style={styles.centeredSmall}>
          <ActivityIndicator size="small" color={colors.accent} />
        </View>
      )}
      {!loadingPayments && payments.length === 0 && (
        <View style={styles.centeredSmall}>
          <Text style={[styles.emptyText, { color: colors.textSecondary }]}>{t('no_pending_payments')}</Text>
        </View>
      )}
      {payments.length > 0 && (
        <View
          style={[styles.paymentsList, { backgroundColor: colors.backgroundSecondary, borderColor: colors.separator }]}
        >
          {payments.map((payment, idx) => {
            const id = String(payment.messageId)
            return (
              <PaymentRow
                key={id}
                payment={payment}
                identity={senderIdentities[payment.sender ?? '']}
                isLast={idx === payments.length - 1}
                isAccepting={acceptingId === id}
                isEditingNote={editingNoteId === id}
                note={paymentNotes[id] ?? ''}
                onAccept={() => onAccept(payment)}
                onEditNote={() => onEditNote(id)}
                onChangeNote={text => onChangeNote(id, text)}
                onSubmitNote={onSubmitNote}
                colors={colors}
                t={t}
              />
            )
          })}
        </View>
      )}
      {acceptResult && <ResultBanner result={acceptResult} onDismiss={onDismissResult} colors={colors} />}
    </>
  )
}

interface ConfigPanelProps {
  readonly urlInput: string
  readonly isSaving: boolean
  readonly colors: ReturnType<typeof import('@/context/theme/ThemeContext').useTheme>['colors']
  readonly t: ReturnType<typeof import('react-i18next').useTranslation>['t']
  readonly onChangeUrl: (v: string) => void
  readonly onSave: () => void
  readonly onCancel: () => void
  readonly onReset: () => void
  readonly onNone: () => void
}

function ConfigPanel({
  urlInput,
  isSaving,
  colors,
  t,
  onChangeUrl,
  onSave,
  onCancel,
  onReset,
  onNone
}: ConfigPanelProps) {
  const hasUrl = !!urlInput.trim()
  const isNone = urlInput === 'noMessageBox'
  return (
    <View style={[styles.configPanel, { backgroundColor: colors.backgroundSecondary }]}>
      <Text style={[styles.configTitle, { color: colors.textPrimary }]}>{t('message_box_server')}</Text>
      <Text style={[styles.configSubtitle, { color: colors.textSecondary }]}>{t('message_box_required')}</Text>
      <TextInput
        value={urlInput}
        onChangeText={onChangeUrl}
        placeholder={DEFAULT_MESSAGE_BOX_URL}
        placeholderTextColor={colors.textTertiary}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        returnKeyType="done"
        onSubmitEditing={onSave}
        style={[
          styles.urlInput,
          { color: colors.textPrimary, backgroundColor: colors.background, borderColor: colors.separator }
        ]}
      />
      <View style={styles.configActions}>
        <TouchableOpacity
          onPress={onSave}
          disabled={isSaving || !hasUrl}
          style={[
            styles.configButton,
            { backgroundColor: hasUrl ? colors.accent : colors.backgroundSecondary, opacity: hasUrl ? 1 : 0.5 }
          ]}
        >
          {isSaving ? (
            <ActivityIndicator size="small" color={hasUrl ? colors.background : colors.textSecondary} />
          ) : (
            <Text style={[styles.configButtonText, { color: hasUrl ? colors.background : colors.textSecondary }]}>
              {t('save')}
            </Text>
          )}
        </TouchableOpacity>
        <TouchableOpacity
          onPress={onCancel}
          style={[styles.configButton, { borderColor: colors.separator, borderWidth: StyleSheet.hairlineWidth }]}
        >
          <Text style={[styles.configButtonText, { color: colors.textSecondary }]}>{t('cancel')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={onReset}
          style={[styles.configButton, { borderColor: colors.success + '40', borderWidth: StyleSheet.hairlineWidth }]}
        >
          <Text style={[styles.configButtonText, { color: colors.success }]}>Reset</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={onNone}
          disabled={isSaving}
          style={[
            styles.configButton,
            { borderColor: colors.error + '40', borderWidth: StyleSheet.hairlineWidth, opacity: isSaving ? 0.5 : 1 }
          ]}
        >
          <Text style={[styles.configButtonText, { color: colors.error }]}>None</Text>
        </TouchableOpacity>
      </View>
    </View>
  )
}

interface RecipientFieldProps {
  readonly selectedIdentity: DisplayableIdentity | null
  readonly searchQuery: string
  readonly recipientKey: string
  readonly isSearching: boolean
  readonly searchResults: DisplayableIdentity[]
  readonly colors: ReturnType<typeof import('@/context/theme/ThemeContext').useTheme>['colors']
  readonly t: ReturnType<typeof import('react-i18next').useTranslation>['t']
  readonly onSearchChange: (v: string) => void
  readonly onSelectIdentity: (i: DisplayableIdentity) => void
  readonly onClear: () => void
  readonly onOpenScanner: () => void
}

function RecipientField({
  selectedIdentity,
  searchQuery,
  recipientKey,
  isSearching,
  searchResults,
  colors,
  t,
  onSearchChange,
  onSelectIdentity,
  onClear,
  onOpenScanner
}: RecipientFieldProps) {
  if (selectedIdentity) {
    return (
      <View style={[styles.selectedRecipient, { backgroundColor: colors.backgroundSecondary }]}>
        {selectedIdentity.avatarURL ? (
          <Image source={{ uri: selectedIdentity.avatarURL }} style={styles.avatar} />
        ) : (
          <View style={[styles.avatarPlaceholder, { backgroundColor: colors.accent }]}>
            <Ionicons name="person" size={20} color={colors.background} />
          </View>
        )}
        <View style={styles.selectedInfo}>
          <Text style={[styles.selectedName, { color: colors.textPrimary }]} numberOfLines={1}>
            {selectedIdentity.name || t('unknown')}
          </Text>
          <Text style={[styles.selectedKey, { color: colors.textSecondary }]} numberOfLines={1}>
            {selectedIdentity.abbreviatedKey || `${selectedIdentity.identityKey.slice(0, 10)}...`}
          </Text>
        </View>
        <TouchableOpacity onPress={onClear} style={styles.clearButton}>
          <Ionicons name="close-circle" size={20} color={colors.textTertiary} />
        </TouchableOpacity>
      </View>
    )
  }
  const showDropdown = (isSearching || searchResults.length > 0) && !recipientKey
  return (
    <>
      <View
        style={[
          styles.inputRow,
          {
            backgroundColor: colors.backgroundSecondary,
            borderColor: recipientKey ? colors.success : colors.separator,
            borderWidth: recipientKey ? 1 : StyleSheet.hairlineWidth
          }
        ]}
      >
        <TextInput
          value={searchQuery}
          onChangeText={onSearchChange}
          placeholder={t('search_name_or_key')}
          placeholderTextColor={colors.textTertiary}
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.recipientInput, { color: colors.textPrimary }]}
        />
        <TouchableOpacity onPress={onOpenScanner} style={styles.inputAction} accessibilityLabel="Scan QR code">
          <Ionicons name="qr-code-outline" size={20} color={colors.accent} />
        </TouchableOpacity>
      </View>
      {!!recipientKey && (
        <View style={styles.directKeyRow}>
          <Ionicons name="key-outline" size={14} color={colors.success} />
          <Text style={[styles.directKeyText, { color: colors.success }]}>{t('valid_identity_key')}</Text>
        </View>
      )}
      {showDropdown && (
        <View
          style={[styles.searchResults, { backgroundColor: colors.backgroundSecondary, borderColor: colors.separator }]}
        >
          {isSearching ? (
            <View style={styles.searchLoading}>
              <ActivityIndicator size="small" color={colors.accent} />
              <Text style={[styles.searchLoadingText, { color: colors.textSecondary }]}>{t('searching')}</Text>
            </View>
          ) : (
            searchResults.map((identity, idx) => (
              <TouchableOpacity
                key={identity.identityKey + idx}
                onPress={() => onSelectIdentity(identity)}
                style={[
                  styles.searchResultRow,
                  idx < searchResults.length - 1 && {
                    borderBottomWidth: StyleSheet.hairlineWidth,
                    borderBottomColor: colors.separator
                  }
                ]}
              >
                {identity.avatarURL ? (
                  <Image source={{ uri: identity.avatarURL }} style={styles.searchAvatar} />
                ) : (
                  <View style={[styles.searchAvatarPlaceholder, { backgroundColor: colors.accent }]}>
                    <Ionicons name="person" size={18} color={colors.background} />
                  </View>
                )}
                <View style={styles.searchResultInfo}>
                  <Text style={[styles.searchResultName, { color: colors.textPrimary }]} numberOfLines={1}>
                    {identity.name || t('unknown')}
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
    </>
  )
}

interface PaymentRowProps {
  readonly payment: IncomingPayment
  readonly identity: DisplayableIdentity | null | undefined
  readonly isLast: boolean
  readonly isAccepting: boolean
  readonly isEditingNote: boolean
  readonly note: string
  readonly onAccept: () => void
  readonly onEditNote: () => void
  readonly onChangeNote: (text: string) => void
  readonly onSubmitNote: () => void
  readonly colors: ReturnType<typeof import('@/context/theme/ThemeContext').useTheme>['colors']
  readonly t: ReturnType<typeof import('react-i18next').useTranslation>['t']
}

function PaymentRow({
  payment,
  identity,
  isLast,
  isAccepting,
  isEditingNote,
  note,
  onAccept,
  onEditNote,
  onChangeNote,
  onSubmitNote,
  colors,
  t
}: PaymentRowProps) {
  const senderKey = payment.sender ?? ''
  return (
    <View
      style={[
        styles.paymentRow,
        !isLast && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator }
      ]}
    >
      {/* Avatar */}
      {identity?.avatarURL ? (
        <Image source={{ uri: identity.avatarURL }} style={styles.paymentAvatar} />
      ) : (
        <View style={[styles.paymentAvatarPlaceholder, { backgroundColor: colors.accent + 'CC' }]}>
          <Ionicons name="person" size={24} color={colors.background} />
        </View>
      )}

      {/* Center: identity + note */}
      <View style={styles.paymentInfo}>
        <Text style={[styles.paymentSenderName, { color: colors.textPrimary }]} numberOfLines={1}>
          {identity?.name ?? t('unknown')}
        </Text>
        <Text style={[styles.paymentSender, { color: colors.textSecondary }]} numberOfLines={1}>
          {identity?.abbreviatedKey ?? `${senderKey.slice(0, 16)}…`}
        </Text>

        {isEditingNote ? (
          <TextInput
            value={note}
            onChangeText={onChangeNote}
            placeholder={t('payment_note_placeholder')}
            placeholderTextColor={colors.textTertiary}
            autoFocus
            returnKeyType="done"
            onSubmitEditing={onSubmitNote}
            style={[styles.noteInput, { color: colors.textPrimary, borderBottomColor: colors.accent }]}
          />
        ) : (
          <TouchableOpacity
            onPress={onEditNote}
            style={styles.noteTapTarget}
            hitSlop={{ top: 4, bottom: 4, left: 0, right: 8 }}
          >
            <Ionicons
              name="pencil"
              size={11}
              color={note ? colors.accent : colors.textQuaternary}
              style={{ marginRight: 4, marginTop: 1 }}
            />
            <Text style={[styles.noteText, { color: note ? colors.accent : colors.textQuaternary }]} numberOfLines={1}>
              {note || t('payment_note_placeholder')}
            </Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Right: amount + accept */}
      <View style={styles.paymentActions}>
        <Text style={[styles.paymentAmount, { color: colors.success }]}>
          <AmountDisplay>{payment.token.amount}</AmountDisplay>
        </Text>
        <TouchableOpacity
          onPress={onAccept}
          disabled={isAccepting}
          style={[styles.acceptButton, { backgroundColor: colors.accent }]}
        >
          {isAccepting ? (
            <ActivityIndicator size="small" color={colors.background} />
          ) : (
            <Text style={[styles.acceptButtonText, { color: colors.background }]}>{t('accept')}</Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
  )
}

export default function PaymentsScreen() {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const { managers, adminOriginator, settings } = useWallet()
  const wallet = managers?.permissionsManager || null
  const { satoshisPerUSD } = React.useContext(ExchangeRateContext)
  const currency = settings?.currency || 'BSV'

  const {
    messageBoxUrl,
    urlInput,
    setUrlInput,
    isSaving,
    showConfig,
    setShowConfig,
    handleSave: handleSaveUrl,
    handleReset,
    handleNone
  } = useMessageBoxConfig(t)
  const isConfigured = !!messageBoxUrl

  const {
    identityClientRef,
    searchQuery,
    searchResults,
    isSearching,
    selectedIdentity,
    recipientKey,
    handleSearchChange,
    handleSelectIdentity,
    clearRecipient,
    scannerVisible,
    setScannerVisible,
    handleQRScanned,
    openScanner
  } = useIdentitySearch(wallet as any, adminOriginator)

  // --- PeerPay state ---
  const peerPayClientRef = useRef<PeerPayClient | null>(null)
  const [payments, setPayments] = useState<IncomingPayment[]>([])
  const [loadingPayments, setLoadingPayments] = useState(false)
  const [acceptingId, setAcceptingId] = useState<string | null>(null)
  const [acceptingAll, setAcceptingAll] = useState(false)
  const [senderIdentities, setSenderIdentities] = useState<Record<string, DisplayableIdentity | null>>({})
  const [paymentNotes, setPaymentNotes] = useState<Record<string, string>>({})
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null)
  const handleChangeNote = useCallback((id: string, text: string) => {
    setPaymentNotes(prev => ({ ...prev, [id]: text }))
  }, [])

  // --- Send / accept result state ---
  const [sendAmount, setSendAmount] = useState('')
  const [isSending, setIsSending] = useState(false)
  const [sendResult, setSendResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const [acceptResult, setAcceptResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

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
        originator: adminOriginator
      })
    } catch {
      peerPayClientRef.current = null
    }
  }, [isConfigured, messageBoxUrl, wallet, adminOriginator])

  const handleSave = useCallback(async () => {
    const trimmed = urlInput.trim().replace(/\/+$/, '')
    if (!trimmed || !wallet) {
      await handleSaveUrl(urlInput)
      return
    }
    try {
      toast.info(t('checking_connection'))
      const tempClient = new PeerPayClient({
        messageBoxHost: trimmed,
        walletClient: wallet as any,
        originator: adminOriginator
      })
      await tempClient.init(trimmed)
      await handleSaveUrl(urlInput)
    } catch (error: any) {
      toast.error(`${t('connection_failed')}: ${error.message || 'unknown error'}`)
    }
  }, [handleSaveUrl, urlInput, wallet, adminOriginator, t])

  const handleRemove = useCallback(async () => {
    await handleReset()
    peerPayClientRef.current = null
  }, [handleReset])

  // --- Fetch incoming payments ---
  const fetchPayments = useCallback(async () => {
    const client = peerPayClientRef.current
    if (!client || !messageBoxUrl || messageBoxUrl === 'noMessageBox') return
    setLoadingPayments(true)
    try {
      const list = await client.listIncomingPayments(messageBoxUrl)
      setPayments(list)

      // Reverse-lookup identity for each unique sender
      const idClient = identityClientRef.current
      if (idClient) {
        const uniqueSenders = [...new Set(list.map(p => p.sender).filter(Boolean))] as string[]
        const entries = await Promise.all(uniqueSenders.map(s => resolveIdentity(idClient, s)))
        setSenderIdentities(Object.fromEntries(entries))
      }
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

  // --- Accept payment (with optional custom description) ---
  const internalizePayment = useCallback(
    async (payment: IncomingPayment, description: string) => {
      const client = peerPayClientRef.current
      if (!client || !wallet) throw new Error('Not ready')
      await wallet.internalizeAction(
        {
          tx: payment.token.transaction,
          outputs: [
            {
              paymentRemittance: {
                derivationPrefix: payment.token.customInstructions.derivationPrefix,
                derivationSuffix: payment.token.customInstructions.derivationSuffix,
                senderIdentityKey: payment.sender
              },
              outputIndex: payment.token.outputIndex ?? 0,
              protocol: 'wallet payment'
            }
          ],
          labels: ['peerpay'],
          description
        },
        adminOriginator
      )
      await client.acknowledgeMessage({ messageIds: [payment.messageId] })
    },
    [wallet, adminOriginator]
  )

  const handleAcceptPayment = useCallback(
    async (payment: IncomingPayment) => {
      const client = peerPayClientRef.current
      if (!client) return
      const id = String(payment.messageId)
      const description = paymentNotes[id]?.trim() || 'Identity Payment'
      setAcceptingId(id)
      setEditingNoteId(null)
      try {
        await acceptWithRetry(client, messageBoxUrl, payment, description, internalizePayment)
        setAcceptResult({ type: 'success', message: 'Payment accepted successfully' })
        fetchPayments()
      } catch (error_: any) {
        setAcceptResult({ type: 'error', message: `Accept failed: ${error_?.message || 'unknown error'}` })
      } finally {
        setAcceptingId(null)
        setTimeout(() => setAcceptResult(null), 5000)
      }
    },
    [messageBoxUrl, fetchPayments, internalizePayment, paymentNotes]
  )

  const handleAcceptAll = useCallback(async () => {
    const client = peerPayClientRef.current
    if (!client || payments.length === 0) return
    setAcceptingAll(true)
    setEditingNoteId(null)
    let successCount = 0
    let lastError: string | null = null

    for (const payment of payments) {
      const id = String(payment.messageId)
      const description = paymentNotes[id]?.trim() || 'Identity Payment'
      try {
        await acceptWithRetry(client, messageBoxUrl, payment, description, internalizePayment)
        successCount++
      } catch (error_: any) {
        lastError = error_?.message || 'unknown error'
      }
    }

    if (successCount > 0) {
      setAcceptResult({
        type: lastError ? 'error' : 'success',
        message: lastError
          ? `Accepted ${successCount} of ${payments.length} payments. Last error: ${lastError}`
          : `Accepted all ${successCount} payments successfully`
      })
      fetchPayments()
    } else if (lastError) {
      setAcceptResult({ type: 'error', message: `Failed to accept payments: ${lastError}` })
    }

    setAcceptingAll(false)
    setTimeout(() => setAcceptResult(null), 5000)
  }, [messageBoxUrl, payments, fetchPayments, internalizePayment, paymentNotes])

  // --- Send payment ---
  const handleSend = useCallback(async () => {
    const client = peerPayClientRef.current
    if (!client || !recipientKey || !sendAmount) return
    setIsSending(true)
    try {
      const { sats } = await sendPayment(client, recipientKey, sendAmount)
      setSendResult({ type: 'success', message: `Sent ${formatAmount(sats, currency, satoshisPerUSD)} successfully` })
      setSendAmount('')
      clearRecipient()
      fetchPayments()
    } catch (error: any) {
      const msg = error instanceof RangeError ? t('enter_valid_amount') : error.message || 'unknown error'
      setSendResult({ type: 'error', message: `Send failed: ${msg}` })
    } finally {
      setIsSending(false)
      setTimeout(() => setSendResult(null), 5000)
    }
  }, [recipientKey, sendAmount, clearRecipient, fetchPayments, t])

  const canSend = recipientKey.length > 0 && Number(sendAmount) > 0 && !isSending && isConfigured

  return (
    <View style={[styles.container, { backgroundColor: colors.backgroundSecondary, paddingTop: insets.top }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.separator }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerButton}>
          <Ionicons name="chevron-back" size={24} color={colors.accent} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.textPrimary }]}>{t('payments')}</Text>
        <TouchableOpacity
          onPress={() => setShowConfig(v => (messageBoxUrl === 'noMessageBox' ? true : !v))}
          style={styles.headerButton}
        >
          <Ionicons name="settings-outline" size={22} color={showConfig ? colors.accent : colors.textSecondary} />
        </TouchableOpacity>
      </View>

      <ScrollView
        style={{ flex: 1, backgroundColor: colors.background }}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {/* --- Active server indicator --- */}
        {messageBoxUrl !== 'noMessageBox' && (
          <View
            style={[
              styles.serverIndicator,
              { backgroundColor: colors.success + '15', borderColor: colors.success + '40' }
            ]}
          >
            <Ionicons name="checkmark-circle" size={14} color={colors.success} />
            <Text style={[styles.serverIndicatorText, { color: colors.success }]} numberOfLines={1}>
              {messageBoxUrl}
            </Text>
          </View>
        )}

        {/* --- Config panel (collapsible) --- */}
        {showConfig && (
          <ConfigPanel
            urlInput={urlInput}
            isSaving={isSaving}
            colors={colors}
            t={t}
            onChangeUrl={setUrlInput}
            onSave={handleSave}
            onCancel={() => {
              if (messageBoxUrl !== 'noMessageBox') setShowConfig(false)
              setUrlInput(messageBoxUrl)
            }}
            onReset={handleRemove}
            onNone={handleNone}
          />
        )}

        {messageBoxUrl === 'noMessageBox' ? (
          <View
            style={[styles.noServerWarning, { backgroundColor: colors.error + '15', borderColor: colors.error + '40' }]}
          >
            <Ionicons name="alert-circle" size={24} color={colors.error} style={{ marginBottom: spacing.sm }} />
            <Text style={[styles.noServerWarningText, { color: colors.error }]}>No Message Box Set</Text>
          </View>
        ) : (
          <>
            {/* --- Send Payment --- */}
            <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>{t('send_payment')}</Text>

            {/* Recipient search / direct key */}
            <View style={styles.fieldGroup}>
              <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>{t('recipient')}</Text>
              <RecipientField
                selectedIdentity={selectedIdentity}
                searchQuery={searchQuery}
                recipientKey={recipientKey}
                isSearching={isSearching}
                searchResults={searchResults}
                colors={colors}
                t={t}
                onSearchChange={handleSearchChange}
                onSelectIdentity={handleSelectIdentity}
                onClear={clearRecipient}
                onOpenScanner={openScanner}
              />
            </View>

            {/* Amount */}
            <View style={styles.fieldGroup}>
              <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>{t('amount')}</Text>
              <AmountInput value={sendAmount} onChangeText={setSendAmount} />
            </View>

            {/* Send button */}
            <TouchableOpacity
              onPress={handleSend}
              disabled={!canSend}
              style={[
                styles.sendButton,
                {
                  backgroundColor: canSend ? colors.accent : colors.backgroundSecondary,
                  opacity: canSend ? 1 : 0.5
                }
              ]}
            >
              {isSending ? (
                <ActivityIndicator size="small" color={canSend ? colors.background : colors.textSecondary} />
              ) : (
                <>
                  <Ionicons name="send" size={18} color={canSend ? colors.background : colors.textSecondary} />
                  <Text style={[styles.sendButtonText, { color: canSend ? colors.background : colors.textSecondary }]}>
                    {t('send_payment')}
                  </Text>
                </>
              )}
            </TouchableOpacity>

            {sendResult && <ResultBanner result={sendResult} onDismiss={() => setSendResult(null)} colors={colors} />}

            <IncomingPaymentsSection
              isConfigured={isConfigured}
              loadingPayments={loadingPayments}
              payments={payments}
              senderIdentities={senderIdentities}
              acceptingId={acceptingId}
              acceptingAll={acceptingAll}
              editingNoteId={editingNoteId}
              paymentNotes={paymentNotes}
              acceptResult={acceptResult}
              colors={colors}
              t={t}
              onRefresh={fetchPayments}
              onAccept={handleAcceptPayment}
              onAcceptAll={handleAcceptAll}
              onEditNote={setEditingNoteId}
              onChangeNote={handleChangeNote}
              onSubmitNote={() => setEditingNoteId(null)}
              onDismissResult={() => setAcceptResult(null)}
            />
          </>
        )}

        <View style={{ height: insets.bottom + 40 }} />
      </ScrollView>

      {/* ── QR Scanner Modal ─────────────────────────────────────────── */}
      <Modal
        visible={scannerVisible}
        animationType="slide"
        onRequestClose={() => setScannerVisible(false)}
        statusBarTranslucent
      >
        <StatusBar style="light" />
        <QRScanner
          multiScan
          onScan={handleQRScanned}
          onClose={() => setScannerVisible(false)}
          hintText={t('scan_identity_key_hint')}
        />
      </Modal>
    </View>
  )
}

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
  content: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg
  },

  // Config panel
  configPanel: {
    padding: spacing.lg,
    borderRadius: radii.md,
    marginBottom: spacing.xl
  },
  configTitle: {
    ...typography.headline,
    marginBottom: spacing.xs
  },
  configSubtitle: {
    ...typography.footnote,
    marginBottom: spacing.md
  },
  urlInput: {
    ...typography.body,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: spacing.md
  },
  configActions: {
    flexDirection: 'row',
    gap: spacing.sm
  },
  configButton: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.sm,
    alignItems: 'center',
    justifyContent: 'center'
  },
  configButtonText: {
    ...typography.subhead,
    fontWeight: '600'
  },

  // Active server indicator
  serverIndicator: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: spacing.xs,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginBottom: spacing.lg
  },
  serverIndicatorText: {
    ...typography.caption1,
    flex: 1
  },

  // No server warning
  noServerWarning: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    padding: spacing.xl,
    alignItems: 'center' as const,
    marginTop: spacing.xl
  },
  noServerWarningText: {
    ...typography.subhead,
    textAlign: 'center' as const
  },

  // Section
  sectionTitle: {
    ...typography.title3,
    marginBottom: spacing.md
  },

  // Field group
  fieldGroup: {
    marginBottom: spacing.lg
  },
  fieldLabel: {
    ...typography.footnote,
    fontWeight: '500',
    marginBottom: spacing.sm,
    textTransform: 'uppercase',
    letterSpacing: 0.5
  },
  // Selected recipient
  selectedRecipient: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md,
    borderRadius: radii.md
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18
  },
  avatarPlaceholder: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center'
  },
  selectedInfo: {
    flex: 1,
    marginLeft: spacing.md
  },
  selectedName: {
    ...typography.subhead,
    fontWeight: '600'
  },
  selectedKey: {
    ...typography.caption1,
    fontFamily: 'monospace'
  },
  clearButton: {
    padding: spacing.xs
  },

  // Direct key
  directKeyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.sm
  },
  directKeyText: {
    ...typography.caption1,
    fontWeight: '500'
  },

  // Search results
  searchResults: {
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: spacing.sm,
    overflow: 'hidden'
  },
  searchLoading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.md,
    gap: spacing.sm
  },
  searchLoadingText: {
    ...typography.subhead
  },
  searchResultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md
  },
  searchAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    marginRight: spacing.md
  },
  searchAvatarPlaceholder: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.md
  },
  searchResultInfo: {
    flex: 1
  },
  searchResultName: {
    ...typography.subhead,
    fontWeight: '500'
  },
  searchResultKey: {
    ...typography.caption1,
    fontFamily: 'monospace'
  },
  badge: {
    paddingHorizontal: spacing.xs,
    paddingVertical: 1,
    borderRadius: 3,
    marginLeft: spacing.sm,
    flexShrink: 1
  },
  badgeText: {
    ...typography.caption2,
    fontWeight: '600',
    fontSize: 10
  },

  // Send button
  sendButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.md,
    borderRadius: radii.md,
    gap: spacing.sm,
    marginBottom: spacing.xxxl
  },
  sendButtonText: {
    ...typography.subhead,
    fontWeight: '600'
  },

  // Incoming payments
  incomingSectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },

  acceptAllButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.sm
  },
  acceptAllButtonText: {
    ...typography.subhead,
    fontWeight: '600'
  },
  centeredSmall: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xxl
  },
  emptyText: {
    ...typography.body
  },
  paymentsList: {
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden'
  },
  paymentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    gap: spacing.md
  },
  paymentAvatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    flexShrink: 0
  },
  paymentAvatarPlaceholder: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0
  },
  paymentInfo: {
    flex: 1,
    minWidth: 0
  },
  paymentSenderName: {
    ...typography.subhead,
    fontWeight: '600',
    marginBottom: 1
  },
  paymentSender: {
    ...typography.caption1,
    fontFamily: 'monospace',
    marginBottom: spacing.xs
  },
  noteTapTarget: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 2
  },
  noteText: {
    ...typography.caption2,
    flex: 1,
    fontStyle: 'italic'
  },
  noteInput: {
    ...typography.caption1,
    marginTop: 4,
    paddingVertical: 3,
    borderBottomWidth: 1,
    paddingHorizontal: 0
  },
  paymentActions: {
    alignItems: 'flex-end',
    gap: spacing.xs,
    flexShrink: 0
  },
  paymentAmount: {
    ...typography.footnote,
    fontWeight: '700'
  },
  acceptButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.sm,
    alignItems: 'center',
    minWidth: 70
  },
  acceptButtonText: {
    ...typography.footnote,
    fontWeight: '600'
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
    marginBottom: spacing.lg
  },
  resultText: {
    ...typography.subhead,
    fontWeight: '500',
    flex: 1
  },
  resultDismiss: {
    padding: spacing.xs
  },

  // Recipient input row (text field + QR scan button)
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden'
  },
  recipientInput: {
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
  }
})
