import { getLocalPayTransport } from 'react-native-localpay-transport'
import { decodeFrame, encodeFrame, type PaymentFrame } from '../codec'
import { instanceName, type Session } from '../session'
import { AckError, type Ack, type LocalPaymentTransport } from './types'

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

export const awdlTransport: LocalPaymentTransport = {
  kind: 'awdl',

  receive(session: Session, signal: AbortSignal): Promise<PaymentFrame> {
    const native = getLocalPayTransport()
    if (!native) return Promise.reject(new Error('AWDL transport unavailable'))
    if (signal.aborted) return Promise.reject(new Error('cancelled'))
    const name = instanceName(session.sessionId)

    return new Promise<PaymentFrame>((resolve, reject) => {
      let settled = false
      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        void native.stopListening().catch(() => {})
        fn()
      }
      const onAbort = () => finish(() => reject(new Error('cancelled')))
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
              frame = decodeFrame(fromBase64(frameBase64))
            } catch (e) {
              return finish(() => reject(e))
            }
            finish(() => resolve(frame))
          },
          message => finish(() => reject(new Error(message)))
        )
        .catch(e => finish(() => reject(e)))
    })
  },

  send(session: Session, frame: PaymentFrame, signal: AbortSignal): Promise<Ack> {
    const native = getLocalPayTransport()
    if (!native) return Promise.reject(new Error('AWDL transport unavailable'))
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
          toBase64(encodeFrame(frame)),
          SEND_TIMEOUT_MS
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
