import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import * as SecureStore from 'expo-secure-store'
import { WalletClient, PrivateKey, ProtoWallet, Utils } from '@bsv/sdk'
import type { WalletProtocol } from '@bsv/sdk'
import connectionStore from '@/stores/ConnectionStore'
import type { Connection } from '@/stores/ConnectionStore'

// ── Constants ─────────────────────────────────────────────────────────────────

export const IMPLEMENTED_METHODS = new Set([
  'getPublicKey', 'listOutputs', 'listCertificates', 'createAction', 'signAction',
  'listActions', 'internalizeAction', 'acquireCertificate',
  'relinquishCertificate', 'revealCounterpartyKeyLinkage', 'createHmac', 'verifyHmac',
  'encrypt', 'decrypt', 'createSignature', 'verifySignature',
])

const NAV_TIMEOUT_MS      = 5  * 60 * 1000  // 5 min  — navigated away from pair screen
const APP_STATE_TIMEOUT_MS = 12 * 60 * 1000  // 12 min — app backgrounded

export const lastSeqKey = (topic: string) => `wallet_pairing_lastseq_${topic}`

// ── Types ─────────────────────────────────────────────────────────────────────

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error'

type RpcRequest  = { id: string; seq: number; method: string; params: unknown }
type RpcResponse = { id: string; seq: number; result?: unknown; error?: { code: number; message: string } }
type WireEnvelope = { topic: string; ciphertext: string; mobileIdentityKey?: string }

export interface SessionMeta {
  topic:              string
  origin:             string
  relay:              string
  backendIdentityKey: string
  mobileIdentityKey:  string
  protocolID:         WalletProtocol
}

export interface ConnectParams {
  topic:              string
  backendIdentityKey: string
  protocolID:         string   // JSON-encoded WalletProtocol
  origin:             string
  expiry?:            string   // Unix seconds — required for signature verification
  sig?:               string   // base64url DER ECDSA signature
}

interface WalletConnectionContextValue {
  status:             ConnectionStatus
  sessionMeta:        SessionMeta | null
  errorMsg:           string | null
  connect:            (params: ConnectParams, wallet: WalletClient) => Promise<void>
  reconnect:          (connection: Connection, wallet: WalletClient) => Promise<void>
  disconnect:         () => void
  startNavTimer:      () => void
  cancelNavTimer:     () => void
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function encryptPayload(
  wallet: WalletClient,
  protocolID: WalletProtocol,
  keyID: string,
  counterparty: string,
  payload: string,
): Promise<string> {
  const plaintext = Array.from(new TextEncoder().encode(payload))
  const { ciphertext } = await wallet.encrypt({ protocolID, keyID, counterparty, plaintext })
  return Buffer.from(ciphertext).toString('base64url')
}

async function decryptPayload(
  wallet: WalletClient,
  protocolID: WalletProtocol,
  keyID: string,
  counterparty: string,
  ciphertextB64: string,
): Promise<string> {
  const ciphertext = Array.from(Buffer.from(ciphertextB64, 'base64url'))
  const { plaintext } = await wallet.decrypt({ protocolID, keyID, counterparty, ciphertext })
  return new TextDecoder().decode(new Uint8Array(plaintext))
}

async function verifyQrSignature(params: ConnectParams): Promise<void> {
  if (!params.sig) throw new Error('QR code is not signed — do not connect')
  const anyoneWallet = new ProtoWallet(new PrivateKey(1))
  const payload = Array.from(new TextEncoder().encode(
    `${params.topic}|${params.backendIdentityKey}|${params.origin}|${params.expiry}`
  ))
  const signature = Utils.toArray(params.sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64') as number[]
  const { valid } = await anyoneWallet.verifySignature({
    data:         payload,
    signature,
    protocolID:   [0, 'qr pairing'],
    keyID:        params.topic,
    counterparty: params.backendIdentityKey,
  })
  if (!valid) throw new Error('QR code signature is invalid — do not connect')
}

async function fetchRelay(origin: string, topic: string): Promise<string> {
  const res = await fetch(`${origin}/api/session/${topic}`)
  if (!res.ok) throw new Error(`Could not fetch session from origin: HTTP ${res.status}`)
  const data = await res.json() as { relay?: string }
  if (!data.relay) throw new Error('Origin server did not return a relay URL')
  return data.relay
}

// ── Context ───────────────────────────────────────────────────────────────────

const WalletConnectionContext = createContext<WalletConnectionContextValue | null>(null)

export function useWalletConnection() {
  const ctx = useContext(WalletConnectionContext)
  if (!ctx) throw new Error('useWalletConnection must be used within WalletConnectionProvider')
  return ctx
}

export function WalletConnectionProvider({ children }: { children: React.ReactNode }) {
  const [status,        setStatus]        = useState<ConnectionStatus>('idle')
  const [sessionMeta,   setSessionMeta]   = useState<SessionMeta | null>(null)
  const [errorMsg,      setErrorMsg]      = useState<string | null>(null)

  // Internal refs — changes here don't trigger re-renders
  const wsRef              = useRef<WebSocket | null>(null)
  const lastSeqRef         = useRef(0)
  const navTimerRef        = useRef<ReturnType<typeof setTimeout> | null>(null)
  const appStateTimerRef   = useRef<ReturnType<typeof setTimeout> | null>(null)
  const intentionalCloseRef = useRef(false)
  // Snapshot of sessionMeta for use inside async WS callbacks
  const sessionMetaRef   = useRef<SessionMeta | null>(null)
  useEffect(() => { sessionMetaRef.current = sessionMeta }, [sessionMeta])

  // ── Disconnect ─────────────────────────────────────────────────────────────

  const disconnect = useCallback(() => {
    const topic = sessionMetaRef.current?.topic
    if (topic) {
      void SecureStore.setItemAsync(lastSeqKey(topic), String(lastSeqRef.current))
      connectionStore.setStatus(topic, 'disconnected')
    }
    intentionalCloseRef.current = true
    const ws = wsRef.current
    wsRef.current = null
    ws?.close()
    if (navTimerRef.current)      { clearTimeout(navTimerRef.current);      navTimerRef.current      = null }
    if (appStateTimerRef.current) { clearTimeout(appStateTimerRef.current); appStateTimerRef.current = null }
    setSessionMeta(null)
    setStatus('idle')
  }, [])

  // ── Nav timer (pair screen lifecycle) ─────────────────────────────────────

  const startNavTimer = useCallback(() => {
    if (navTimerRef.current) clearTimeout(navTimerRef.current)
    navTimerRef.current = setTimeout(() => {
      navTimerRef.current = null
      if (wsRef.current) disconnect()
    }, NAV_TIMEOUT_MS)
  }, [disconnect])

  const cancelNavTimer = useCallback(() => {
    if (navTimerRef.current) { clearTimeout(navTimerRef.current); navTimerRef.current = null }
  }, [])

  // ── AppState timer (app backgrounded) ────────────────────────────────────

  useEffect(() => {
    const sub = AppState.addEventListener('change', nextState => {
      if (nextState === 'background' || nextState === 'inactive') {
        if (appStateTimerRef.current) clearTimeout(appStateTimerRef.current)
        appStateTimerRef.current = setTimeout(() => {
          appStateTimerRef.current = null
          if (wsRef.current) disconnect()
        }, APP_STATE_TIMEOUT_MS)
      } else if (nextState === 'active') {
        if (appStateTimerRef.current) { clearTimeout(appStateTimerRef.current); appStateTimerRef.current = null }
      }
    })
    return () => sub.remove()
  }, [disconnect])

  // ── RPC dispatch ──────────────────────────────────────────────────────────

  async function handleRpc(
    request: RpcRequest,
    meta: SessionMeta,
    ws: WebSocket,
    wallet: WalletClient,
  ): Promise<void> {
    const sendResponse = async (response: RpcResponse) => {
      try {
        const ciphertext = await encryptPayload(
          wallet, meta.protocolID, meta.topic, meta.backendIdentityKey, JSON.stringify(response),
        )
        ws.send(JSON.stringify({ topic: meta.topic, ciphertext } satisfies WireEnvelope))
      } catch (err) {
        console.warn('[WalletConnection] sendResponse failed:', err)
      }
    }

    if (!IMPLEMENTED_METHODS.has(request.method)) {
      await sendResponse({ id: request.id, seq: request.seq,
        error: { code: 501, message: `Method "${request.method}" is not implemented` } })
      return
    }

    // Call wallet method directly — WalletPermissionsManager handles all
    // permission prompts (spending, protocol, basket, certificate) via its
    // own callbacks and the existing wallet permission modals.
    let result: unknown
    let error: { code: number; message: string } | undefined
    try {
      type WFn = (p: unknown) => Promise<unknown>
      result = await (wallet as unknown as Record<string, WFn>)[request.method](request.params)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Wallet error'
      // WalletPermissionsManager throws when user denies — surface as rejection
      const code = message.includes('denied') || message.includes('rejected') ? 4001 : 500
      error = { code, message }
    }

    await sendResponse(error
      ? { id: request.id, seq: request.seq, error }
      : { id: request.id, seq: request.seq, result },
    )
  }

  // ── Shared WS message / event wiring ─────────────────────────────────────

  function wireSocket(
    ws: WebSocket,
    wallet: WalletClient,
    meta: SessionMeta,
    initialSeq: number,
    onFirstMessage: () => void,
  ) {
    wsRef.current      = ws
    lastSeqRef.current = initialSeq
    let firstMessageFired = false

    ws.onmessage = async event => {
      try {
        const envelope = JSON.parse(event.data as string) as WireEnvelope
        if (!envelope.ciphertext) return

        let plaintext: string
        try {
          plaintext = await decryptPayload(
            wallet, meta.protocolID, meta.topic, meta.backendIdentityKey, envelope.ciphertext,
          )
        } catch (err) {
          console.warn('[WalletConnection] decryptPayload failed:', err)
          return
        }

        const msg = JSON.parse(plaintext) as RpcRequest | RpcResponse
        if (typeof msg.seq !== 'number' || msg.seq <= lastSeqRef.current) {
          console.warn('[WalletConnection] dropping message: seq', msg.seq, '<= lastSeq', lastSeqRef.current)
          return
        }
        lastSeqRef.current = msg.seq

        if (!firstMessageFired) {
          firstMessageFired = true
          onFirstMessage()
        }

        if ('method' in msg && msg.method === 'pairing_ack') return
        if ('method' in msg && msg.id) {
          void handleRpc(msg as RpcRequest, meta, ws, wallet)
        }
      } catch {
        // malformed outer envelope — drop silently
      }
    }

    ws.onerror = () => {
      setErrorMsg('WebSocket connection failed')
      setStatus('error')
    }

    ws.onclose = () => {
      const wasIntentional = intentionalCloseRef.current
      intentionalCloseRef.current = false

      // Don't change the state if this is not the current ws
      if (!wasIntentional && wsRef.current !== null && wsRef.current !== ws) {
        return
      }

      if (!wasIntentional) {
        const topic = sessionMetaRef.current?.topic
        if (topic) {
          void SecureStore.setItemAsync(lastSeqKey(topic), String(lastSeqRef.current))
          connectionStore.setStatus(topic, 'disconnected')
        }
      }
      wsRef.current = null
      lastSeqRef.current = 0
      if (navTimerRef.current)      { clearTimeout(navTimerRef.current);      navTimerRef.current      = null }
      if (appStateTimerRef.current) { clearTimeout(appStateTimerRef.current); appStateTimerRef.current = null }
      setSessionMeta(null)
      // Don't override the 'idle' status that disconnect() already set
      if (!wasIntentional) {
        if (firstMessageFired) {
          setErrorMsg('Connection closed — the desktop session ended')
          setStatus('disconnected')
        } else {
          setErrorMsg('Could not reach the desktop — check that the browser tab is still open')
          setStatus('error')
        }
      }
    }
  }

  // ── connect (fresh pairing) ───────────────────────────────────────────────

  const connect = useCallback(async (params: ConnectParams, wallet: WalletClient) => {
    setStatus('connecting')
    setErrorMsg(null)

    let relay: string
    try {
      // Verify QR signature before trusting the origin or opening any connection
      await verifyQrSignature(params)

      // Fetch relay URL from origin over HTTPS — TLS cert is the trust anchor
      relay = await fetchRelay(params.origin, params.topic)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Connection failed')
      setStatus('error')
      throw err
    }

    const protocolID = JSON.parse(params.protocolID) as WalletProtocol
    const { publicKey: mobileIdentityKey } = await wallet.getPublicKey({ identityKey: true })

    const meta: SessionMeta = {
      topic: params.topic, origin: params.origin, relay,
      backendIdentityKey: params.backendIdentityKey, mobileIdentityKey,
      protocolID,
    }
    setSessionMeta(meta)

    const ws = new WebSocket(`${relay}/ws?topic=${params.topic}&role=mobile`)

    ws.onopen = async () => {
      try {
        const payload = JSON.stringify({
          id: crypto.randomUUID(), seq: 1, method: 'pairing_approved',
          params: {
            mobileIdentityKey,
            walletMeta: { name: 'BSV Browser', platform: 'mobile' },
            permissions: Array.from(IMPLEMENTED_METHODS),
          },
        })
        const ciphertext = await encryptPayload(wallet, protocolID, params.topic, params.backendIdentityKey, payload)
        ws.send(JSON.stringify({ topic: params.topic, mobileIdentityKey, ciphertext } satisfies WireEnvelope))
      } catch {
        setErrorMsg('Failed to send pairing message')
        setStatus('error')
      }
    }

    wireSocket(ws, wallet, meta, 0, () => {
      connectionStore.add({
        sessionId: params.topic, origin: params.origin, relay,
        backendIdentityKey: params.backendIdentityKey, mobileIdentityKey,
        protocolID: params.protocolID,
        connectedAt: Date.now(), status: 'active',
      })
      setStatus('connected')
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── reconnect (resume from stored session) ────────────────────────────────

  const reconnect = useCallback(async (connection: Connection, wallet: WalletClient) => {
    setStatus('connecting')
    setErrorMsg(null)

    // Fetch relay URL from origin over HTTPS — relay may have moved since last connection
    const relay = await fetchRelay(connection.origin, connection.sessionId)

    const protocolID = JSON.parse(connection.protocolID) as WalletProtocol
    const storedSeq  = await SecureStore.getItemAsync(lastSeqKey(connection.sessionId))
    const initialSeq = storedSeq ? Number(storedSeq) : 0

    const meta: SessionMeta = {
      topic: connection.sessionId, origin: connection.origin, relay,
      backendIdentityKey: connection.backendIdentityKey,
      mobileIdentityKey:  connection.mobileIdentityKey,
      protocolID,
    }
    setSessionMeta(meta)

    const ws = new WebSocket(`${relay}/ws?topic=${connection.sessionId}&role=mobile`)

    ws.onopen = async () => {
      try {
        const payload = JSON.stringify({
          id: crypto.randomUUID(), seq: initialSeq + 1, method: 'pairing_approved',
          params: {
            mobileIdentityKey: connection.mobileIdentityKey,
            walletMeta: { name: 'BSV Browser', platform: 'mobile' },
            permissions: Array.from(IMPLEMENTED_METHODS),
          },
        })
        const ciphertext = await encryptPayload(
          wallet, protocolID, connection.sessionId, connection.backendIdentityKey, payload,
        )
        ws.send(JSON.stringify({
          topic: connection.sessionId,
          mobileIdentityKey: connection.mobileIdentityKey,
          ciphertext,
        } satisfies WireEnvelope))
      } catch {
        setErrorMsg('Failed to send reconnect message')
        setStatus('error')
      }
    }

    wireSocket(ws, wallet, meta, initialSeq, () => {
      connectionStore.setStatus(connection.sessionId, 'active')
      setStatus('connected')
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Provider ──────────────────────────────────────────────────────────────

  return (
    <WalletConnectionContext.Provider value={{
      status, sessionMeta, errorMsg,
      connect, reconnect, disconnect,
      startNavTimer, cancelNavTimer,
    }}>
      {children}
    </WalletConnectionContext.Provider>
  )
}
