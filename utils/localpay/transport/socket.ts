import { getLocalPayTransport, type LocalPayTransport } from 'react-native-localpay-transport'
import { sealFrame, unsealFrame, type PaymentFrame } from '../codec'
import { instanceName, type Session } from '../session'
import {
  AckError,
  type Ack,
  type ConfirmDelivery,
  type DeclineReason,
  type LocalPaymentTransport,
  type ReceivedFrame
} from './types'

const SEND_TIMEOUT_MS = 20_000

function toBase64(b: Uint8Array): string {
  let s = ''
  for (const byte of b) s += String.fromCharCode(byte)
  return globalThis.btoa(s)
}

function fromBase64(s: string): Uint8Array {
  return Uint8Array.from(globalThis.atob(s), c => c.charCodeAt(0))
}

/**
 * Decode and validate an ack payload. Throws AckError for anything that
 * isn't a well-formed { ok: boolean, error?: string } object — a genuine
 * peer decline (ok: false) is not an error and must be returned normally.
 */
function parseAck(ackBase64: string): Ack {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(fromBase64(ackBase64)))
  } catch {
    throw new AckError('malformed ack: invalid base64 or JSON')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new AckError('malformed ack: expected an object')
  }
  const { ok, error } = parsed as Record<string, unknown>
  if (typeof ok !== 'boolean') {
    throw new AckError('malformed ack: missing boolean "ok"')
  }
  if (error !== undefined && typeof error !== 'string') {
    throw new AckError('malformed ack: "error" must be a string')
  }
  return error === undefined ? { ok } : { ok, error }
}

/**
 * Wraps the native `confirmFrame` in the contract ConfirmDelivery promises:
 * at most one ack per delivery, and never a rejection.
 *
 * The latch is defence in depth against a second ack contradicting the first:
 * `settleReceived` has many exits and each one confirms, so a missed `return`
 * would otherwise let a decline follow an acceptance for the same payment. The
 * swallow matters because the payee's copy is already durable by the time a
 * positive ack is sent — a socket error here is a payer-side retry problem,
 * not a reason to tell the payee its payment failed.
 */
function makeConfirm(native: LocalPayTransport): ConfirmDelivery {
  let acked = false
  return (accepted, reason) => {
    if (acked) return Promise.resolve()
    acked = true
    try {
      return native.confirmFrame(accepted, reason ?? '').catch(warnAckFailure)
    } catch (e) {
      warnAckFailure(e)
      return Promise.resolve()
    }
  }
}

function warnAckFailure(e: unknown): void {
  console.warn('[localpay] confirmFrame failed:', e instanceof Error ? e.message : String(e))
}

/**
 * Decline without a handle, from inside a native callback. Cannot throw: a
 * throw here would unwind into Swift's `onFrame` invocation rather than into
 * any JS caller.
 */
function declineQuietly(native: LocalPayTransport, reason: DeclineReason): void {
  try {
    void native.confirmFrame(false, reason).catch(warnAckFailure)
  } catch (e) {
    warnAckFailure(e)
  }
}

/**
 * The socketed transport wrapper, shared by both radio backends. The native
 * surface is identical on both platforms (one Nitro spec): iOS implements it
 * over AWDL/Network.framework, Android over Google Nearby Connections. Which
 * one getLocalPayTransport() returns is decided by the platform at build
 * time, so `kind` here is attribution, not dispatch.
 */
export function makeSocketTransport(kind: 'awdl' | 'nearby'): LocalPaymentTransport {
  /**
   * Connect-phase budget before the payer gives up and falls back to the QR.
   * Radio-specific: AWDL's Bonjour discovery over an already-established
   * Wi-Fi link resolves (or doesn't) inside ~4s, but Nearby has to do BLE
   * discovery and then a Wi-Fi/hotspot upgrade before a connection even
   * exists — 4s there would false-positive "no route to peer" on a link
   * that just needed more time to come up.
   */
  const CONNECT_TIMEOUT_MS = kind === 'awdl' ? 4_000 : 10_000
  return {
    kind,

    receive(session: Session, signal: AbortSignal): Promise<ReceivedFrame> {
      const native = getLocalPayTransport()
      if (!native) return Promise.reject(new Error(`${kind} transport unavailable`))
      if (signal.aborted) return Promise.reject(new Error('cancelled'))
      const name = instanceName(session.sessionId)

      return new Promise<ReceivedFrame>((resolve, reject) => {
        let settled = false
        /**
         * `teardown` says whether settling should also tear the native listener
         * down. It must be FALSE on the success path: the native side already
         * cancelled the listener itself the instant it accepted (first-success-
         * wins), and it is now holding the payer's connection open waiting for
         * confirmFrame(). stopListening() cancels held connections, so calling
         * it here would destroy the very socket the ack has to travel back over
         * — the payer would time out on a payment the payee successfully saved.
         */
        const finish = (teardown: boolean, fn: () => void) => {
          if (settled) return
          settled = true
          signal.removeEventListener('abort', onAbort)
          if (teardown) void native.stopListening().catch(() => {})
          fn()
        }
        const onAbort = () => finish(true, () => reject(new Error('cancelled')))
        signal.addEventListener('abort', onAbort)

        native
          .startListening(
            name,
            toBase64(session.psk),
            frameBase64 => {
              // Decode BEFORE finish(). `finish` latches `settled` and tears the
              // listener down before it invokes its callback, so a throw from
              // inside that callback can never be recovered by a second finish() —
              // the guard returns early and the promise never settles at all,
              // leaving the payee spinning against a listener that is already gone.
              // Any version skew, truncation or trailing bytes reaches this path.
              let frame: PaymentFrame
              try {
                frame = unsealFrame(fromBase64(frameBase64), session.psk)
              } catch (e) {
                // The only decline the caller can never issue itself: receive()
                // rejects here, so no ReceivedFrame — and therefore no confirm
                // handle — ever reaches the screen. Declining from inside the
                // transport is what stops the payer sitting on a green "Sent"
                // until its own timeout. Nothing was persisted, so this is a
                // provable "queued nothing" and the payer may release its inputs.
                //
                // teardown is false here for the same reason as on success:
                // stopListening() would cancel the connection the decline has
                // to go out on. confirmFrame does the full teardown itself, and
                // the native listener was already cancelled at accept time.
                declineQuietly(native, 'decode_failed')
                return finish(false, () => reject(e))
              }
              finish(false, () => resolve({ frame, confirm: makeConfirm(native) }))
            },
            message => finish(true, () => reject(new Error(message)))
          )
          .catch(e => finish(true, () => reject(e)))
      })
    },

    send(session: Session, frame: PaymentFrame, signal: AbortSignal): Promise<Ack> {
      const native = getLocalPayTransport()
      if (!native) return Promise.reject(new Error(`${kind} transport unavailable`))
      if (signal.aborted) return Promise.reject(new Error('cancelled'))

      return new Promise<Ack>((resolve, reject) => {
        let settled = false
        const cleanup = () => signal.removeEventListener('abort', onAbort)
        const onAbort = () => {
          if (settled) return
          settled = true
          cleanup()
          reject(new Error('cancelled'))
        }
        signal.addEventListener('abort', onAbort)

        native
          .sendFrame(
            instanceName(session.sessionId),
            toBase64(session.psk),
            toBase64(sealFrame(frame, session.psk)),
            SEND_TIMEOUT_MS,
            CONNECT_TIMEOUT_MS
          )
          .then(
            ackBase64 => {
              if (settled) return
              settled = true
              cleanup()
              try {
                resolve(parseAck(ackBase64))
              } catch (e) {
                reject(e)
              }
            },
            e => {
              if (settled) return
              settled = true
              cleanup()
              reject(e)
            }
          )
      })
    },
  }
}
