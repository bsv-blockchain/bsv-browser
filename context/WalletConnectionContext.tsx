import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import * as SecureStore from 'expo-secure-store'
import { WalletClient } from '@bsv/sdk'
import type { WalletProtocol } from '@bsv/sdk'
import connectionStore from '@/stores/ConnectionStore'
import type { Connection } from '@/stores/ConnectionStore'

// ── Constants ─────────────────────────────────────────────────────────────────

export const IMPLEMENTED_METHODS = new Set([
  'getPublicKey', 'listOutputs', 'createAction', 'signAction',
  'listActions', 'internalizeAction', 'acquireCertificate',
  'relinquishCertificate', 'revealCounterpartyKeyLinkage',
])
const AUTO_APPROVE_METHODS = new Set(['getPublicKey'])

const NAV_TIMEOUT_MS      = 5  * 60 * 1000  // 5 min  — navigated away from pair screen
const APP_STATE_TIMEOUT_MS = 12 * 60 * 1000  // 12 min — app backgrounded

const lastSeqKey = (topic: string) => `wallet_pairing_lastseq_${topic}`

// ── Types ─────────────────────────────────────────────────────────────────────

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error'

type RpcRequest  = { id: string; seq: number; method: string; params: unknown }
type RpcResponse = { id: string; seq: number; result?: unknown; error?: { code: number; message: string } }
type WireEnvelope = { topic: string; ciphertext: string; mobileIdentityKey?: string }

export interface ApprovalItem {
  method: string
  params: unknown
  resolve: (approved: boolean) => void
  reject:  (err: Error) => void
}

export interface SessionMeta {
  topic:              string
  origin:             string
  relay:              string
  backendIdentityKey: string
  mobileIdentityKey:  string
  protocolID:         WalletProtocol
  keyID:              string
}

export interface ConnectParams {
  topic:              string
  relay:              string
  backendIdentityKey: string
  protocolID:         string   // JSON-encoded WalletProtocol
  keyID:              string
  origin:             string
}

interface WalletConnectionContextValue {
  status:             ConnectionStatus
  sessionMeta:        SessionMeta | null
  errorMsg:           string | null
  currentApproval:    ApprovalItem | null
  connect:            (params: ConnectParams, wallet: WalletClient) => Promise<void>
  reconnect:          (connection: Connection, wallet: WalletClient) => Promise<void>
  disconnect:         () => void
  approveCurrentRpc:  () => void
  rejectCurrentRpc:   () => void
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
  const [approvalQueue, setApprovalQueue] = useState<ApprovalItem[]>([])

  const currentApproval = approvalQueue[0] ?? null

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
    setApprovalQueue(prev => {
      prev.forEach(item => item.reject(new Error('Session disconnected')))
      return []
    })
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

  // ── Approval queue ────────────────────────────────────────────────────────

  const approveCurrentRpc = useCallback(() => {
    setApprovalQueue(prev => {
      prev[0]?.resolve(true)
      return prev.slice(1)
    })
  }, [])

  const rejectCurrentRpc = useCallback(() => {
    setApprovalQueue(prev => {
      prev[0]?.resolve(false)
      return prev.slice(1)
    })
  }, [])

  function requestApproval(method: string, params: unknown): Promise<boolean> {
    return new Promise((resolve, reject) => {
      setApprovalQueue(prev => [...prev, { method, params, resolve, reject }])
    })
  }

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
          wallet, meta.protocolID, meta.keyID, meta.backendIdentityKey, JSON.stringify(response),
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

    let approved = true
    if (!AUTO_APPROVE_METHODS.has(request.method)) {
      try {
        approved = await requestApproval(request.method, request.params)
      } catch {
        return  // session disconnected while waiting for user input
      }
    }

    if (!approved) {
      await sendResponse({ id: request.id, seq: request.seq,
        error: { code: 4001, message: 'User rejected' } })
      return
    }

    let result: unknown
    let error: { code: number; message: string } | undefined
    try {
      type WFn = (p: unknown) => Promise<unknown>
      result = await (wallet as unknown as Record<string, WFn>)[request.method](request.params)
    } catch (err) {
      error = { code: 500, message: err instanceof Error ? err.message : 'Wallet error' }
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
            wallet, meta.protocolID, meta.keyID, meta.backendIdentityKey, envelope.ciphertext,
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
        setApprovalQueue(prev => {
          prev.forEach(item => item.reject(new Error('Session disconnected')))
          return []
        })
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
      setApprovalQueue(prev => {
        prev.forEach(item => item.reject(new Error('Session disconnected')))
        return []
      })
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

    const protocolID = JSON.parse(params.protocolID) as WalletProtocol
    const { publicKey: mobileIdentityKey } = await wallet.getPublicKey({ identityKey: true })

    const meta: SessionMeta = {
      topic: params.topic, origin: params.origin, relay: params.relay,
      backendIdentityKey: params.backendIdentityKey, mobileIdentityKey,
      protocolID, keyID: params.keyID,
    }
    setSessionMeta(meta)

    const ws = new WebSocket(`${params.relay}/ws?topic=${params.topic}&role=mobile`)

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
        const ciphertext = await encryptPayload(wallet, protocolID, params.keyID, params.backendIdentityKey, payload)
        ws.send(JSON.stringify({ topic: params.topic, mobileIdentityKey, ciphertext } satisfies WireEnvelope))
      } catch {
        setErrorMsg('Failed to send pairing message')
        setStatus('error')
      }
    }

    wireSocket(ws, wallet, meta, 0, () => {
      connectionStore.add({
        sessionId: params.topic, origin: params.origin, relay: params.relay,
        backendIdentityKey: params.backendIdentityKey, mobileIdentityKey,
        protocolID: params.protocolID, keyID: params.keyID,
        connectedAt: Date.now(), status: 'active',
      })
      setStatus('connected')
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── reconnect (resume from stored session) ────────────────────────────────

  const reconnect = useCallback(async (connection: Connection, wallet: WalletClient) => {
    setStatus('connecting')
    setErrorMsg(null)

    const protocolID = JSON.parse(connection.protocolID) as WalletProtocol
    const storedSeq  = await SecureStore.getItemAsync(lastSeqKey(connection.sessionId))
    const initialSeq = storedSeq ? Number(storedSeq) : 0

    const meta: SessionMeta = {
      topic: connection.sessionId, origin: connection.origin, relay: connection.relay,
      backendIdentityKey: connection.backendIdentityKey,
      mobileIdentityKey:  connection.mobileIdentityKey,
      protocolID, keyID: connection.keyID,
    }
    setSessionMeta(meta)

    const ws = new WebSocket(`${connection.relay}/ws?topic=${connection.sessionId}&role=mobile`)

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
          wallet, protocolID, connection.keyID, connection.backendIdentityKey, payload,
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
      status, sessionMeta, errorMsg, currentApproval,
      connect, reconnect, disconnect,
      approveCurrentRpc, rejectCurrentRpc,
      startNavTimer, cancelNavTimer,
    }}>
      {children}
    </WalletConnectionContext.Provider>
  )
}
