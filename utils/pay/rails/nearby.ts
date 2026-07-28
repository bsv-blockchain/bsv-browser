/**
 * The nearby rail — in-person, device-to-device over AWDL or QR.
 *
 * A pass-through, on purpose. utils/localpay/* is device-proven with 210 tests
 * behind it and its money-safety invariants were verified line by line, so this
 * rail adds NOTHING: no wrappers, no defaults, no convenience. Its only job is
 * to be the single import site for nearby, so a future change cannot quietly
 * grow a second implementation between the screen and the transport.
 *
 * If you find yourself wanting to add a function here, add it to the caller
 * instead.
 */
export { decodeSession, encodeSession, mintSession, type Session } from '@/utils/localpay/session'
export { MAX_FRAME_QR_CHARS, frameFromQr, frameToQr, type PaymentFrame } from '@/utils/localpay/codec'
export {
  isSessionSpent,
  markSessionSpent,
  processPending,
  savePending,
  type PendingPayment
} from '@/utils/localpay/pending'
export { buildPaymentFrame, finalizeDelivery } from '@/utils/localpay/build'
export { awdlTransport } from '@/utils/localpay/transport/awdl'
export { localSupportsAwdl, selectTransport } from '@/utils/localpay/transport/select'
export {
  isDeclineReason,
  type Ack,
  type ConfirmDelivery,
  type DeclineReason
} from '@/utils/localpay/transport/types'
