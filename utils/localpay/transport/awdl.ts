import { getLocalPayTransport } from 'react-native-localpay-transport'
import { decodeFrame, encodeFrame, type PaymentFrame } from '../codec'
import { instanceName, type Session } from '../session'
import type { Ack, LocalPaymentTransport } from './types'

const SEND_TIMEOUT_MS = 20_000

function toBase64(b: Uint8Array): string {
  let s = ''
  for (const byte of b) s += String.fromCharCode(byte)
  return globalThis.btoa(s)
}

function fromBase64(s: string): Uint8Array {
  return Uint8Array.from(globalThis.atob(s), c => c.charCodeAt(0))
}

export const awdlTransport: LocalPaymentTransport = {
  kind: 'awdl',

  receive(session: Session, signal: AbortSignal): Promise<PaymentFrame> {
    const native = getLocalPayTransport()
    if (!native) return Promise.reject(new Error('AWDL transport unavailable'))
    const name = instanceName(session.sessionId)

    return new Promise<PaymentFrame>((resolve, reject) => {
      let settled = false
      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        void native.stopListening()
        fn()
      }
      signal.addEventListener('abort', () => finish(() => reject(new Error('cancelled'))))

      native
        .startListening(
          name,
          toBase64(session.psk),
          frameBase64 => {
            try {
              finish(() => resolve(decodeFrame(fromBase64(frameBase64))))
            } catch (e) {
              finish(() => reject(e))
            }
          },
          message => finish(() => reject(new Error(message)))
        )
        .catch(e => finish(() => reject(e)))
    })
  },

  async send(session: Session, frame: PaymentFrame): Promise<Ack> {
    const native = getLocalPayTransport()
    if (!native) throw new Error('AWDL transport unavailable')
    const ackBase64 = await native.sendFrame(
      instanceName(session.sessionId),
      toBase64(session.psk),
      toBase64(encodeFrame(frame)),
      SEND_TIMEOUT_MS
    )
    try {
      return JSON.parse(new TextDecoder().decode(fromBase64(ackBase64))) as Ack
    } catch {
      return { ok: false, error: 'malformed ack' }
    }
  },
}
