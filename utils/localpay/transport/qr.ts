import { QrHandoffRequired, type LocalPaymentTransport } from './types'

/**
 * The QR path has no socket: the payer renders a frame and the payee scans it.
 * The screen drives both halves directly, so these entry points exist only to
 * satisfy the interface and must not be called.
 */
export const qrTransport: LocalPaymentTransport = {
  kind: 'qr',
  receive() {
    return Promise.reject(new QrHandoffRequired())
  },
  send() {
    return Promise.reject(new QrHandoffRequired())
  },
}
