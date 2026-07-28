/**
 * Identity search / scan state for the two handle cells.
 *
 * Moved verbatim out of app/payments.tsx (peerPayValidationMessage +
 * useIdentitySearch) so Pay → handle and Get paid → handle share one
 * implementation rather than drifting apart.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Keyboard } from 'react-native'
import { IdentityClient, PublicKey } from '@bsv/sdk'
import type { DisplayableIdentity } from '@bsv/sdk'
import { searchIdentities } from '@/utils/identity/resolveIdentity'
import { type PeerPayValidationResult, validatePeerPayURI } from '@/utils/parsePeerPayURI'

export function peerPayValidationMessage(result: PeerPayValidationResult | null) {
  if (!result || !result.isPeerPay) return null
  const messages = [result.errors.identityKey, result.errors.sats].filter(Boolean)
  return messages.length ? messages.join('. ') : null
}

export function useIdentitySearch(
  wallet: any,
  adminOriginator: string | undefined,
  initialIdentityKey?: string,
  onPeerPayAmount?: (sats: number) => void,
  onPeerPayError?: (message: string) => void
) {
  const identityClientRef = useRef<IdentityClient | null>(null)
  useEffect(() => {
    if (!wallet) return
    try {
      identityClientRef.current = new IdentityClient(wallet, undefined, adminOriginator)
    } catch {}
  }, [wallet, adminOriginator])

  const [searchQuery, setSearchQuery] = useState(initialIdentityKey ?? '')
  const [searchResults, setSearchResults] = useState<DisplayableIdentity[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [selectedIdentity, setSelectedIdentity] = useState<DisplayableIdentity | null>(null)
  const [recipientKey, setRecipientKey] = useState(initialIdentityKey ?? '')
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const setDirectRecipient = useCallback((identityKey: string) => {
    setSearchQuery(identityKey)
    setRecipientKey(identityKey)
    setSelectedIdentity(null)
    setSearchResults([])
  }, [])

  useEffect(() => {
    if (initialIdentityKey) setDirectRecipient(initialIdentityKey)
  }, [initialIdentityKey, setDirectRecipient])

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
  const handleQRScanned = useCallback(
    (data: string) => {
      const raw = data.trim()

      // Try peerpay: URI first
      if (raw.toLowerCase().startsWith('peerpay:')) {
        const validation = validatePeerPayURI(raw)
        const errorMessage = peerPayValidationMessage(validation)

        if (validation.identityKey) setDirectRecipient(validation.identityKey)
        if (validation.sats !== undefined) onPeerPayAmount?.(validation.sats)
        if (errorMessage) onPeerPayError?.(errorMessage)

        setScannerVisible(false)
        return
      }

      // Fall back to raw public key
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
    },
    [onPeerPayAmount, onPeerPayError, setDirectRecipient]
  )

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
