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
export {
  FRAME_BLOCK_BYTES,
  SEAL_VERSION,
  frameBytesFromQr,
  frameToQr,
  sealFrame,
  unsealFrame,
  type PaymentFrame
} from '@/utils/localpay/codec'
/**
 * The animated-QR transport is `@bsv/air-gap` (BRC-141), not app code. It was
 * grown here first and upstreamed; the published library adds what a local
 * copy could not justify carrying — a wire version byte, per-stream session
 * ids with switch hysteresis so one stray frame cannot erase a scan in
 * progress, and explicit decoder resource budgets. Display cadence stays with
 * the renderer, because the library deliberately has no opinion on it.
 */
export {
  AIR_GAP_PREFIX,
  AirGapDecoder,
  AirGapEncoder,
  MAX_MESSAGE_BYTES,
  estimatePartCharLength,
  isAirGapPart
} from '@bsv/air-gap'
export {
  isSessionSpent,
  markSessionSpent,
  processPending,
  savePending,
  type PendingPayment
} from '@/utils/localpay/pending'
export { buildPaymentFrame, finalizeDelivery } from '@/utils/localpay/build'
export {
  FrameVerifyError,
  verifyFramePayment,
  type DerivingWallet,
  type FrameVerifyKind
} from '@/utils/localpay/verify'
export { holdSentPaymentOffline } from '@/utils/offline/payerHold'
export { awdlTransport } from '@/utils/localpay/transport/awdl'
export { nearbyTransport } from '@/utils/localpay/transport/nearby'
export {
  localSupportsAwdl,
  localSupportsNearby,
  selectTransport,
  type TransportKind
} from '@/utils/localpay/transport/select'
export { requestNearbyPermissions } from '@/utils/localpay/transport/nearbyPermissions'
export { isDeclineReason, type Ack, type ConfirmDelivery, type DeclineReason } from '@/utils/localpay/transport/types'
export { CAP_NEARBY } from '@/utils/localpay/session'
