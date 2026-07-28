import type { PaymentFrame } from '../codec'
import type { Session } from '../session'

export interface Ack {
  ok: boolean
  error?: string
}

export interface LocalPaymentTransport {
  readonly kind: 'awdl' | 'qr'
  receive(session: Session, signal: AbortSignal): Promise<PaymentFrame>
  send(session: Session, frame: PaymentFrame, signal: AbortSignal): Promise<Ack>
}

export class QrHandoffRequired extends Error {
  constructor() {
    super('QR transport is driven by the UI, not by this interface')
    this.name = 'QrHandoffRequired'
  }
}

/** Thrown when an ack cannot be decoded or does not have the shape of a valid Ack. */
export class AckError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AckError'
  }
}
