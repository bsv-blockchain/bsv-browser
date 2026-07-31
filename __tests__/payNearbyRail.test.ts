import * as nearby from '@/utils/pay/rails/nearby'
import * as session from '@/utils/localpay/session'
import * as verify from '@/utils/localpay/verify'
import * as codec from '@/utils/localpay/codec'
import * as pending from '@/utils/localpay/pending'
import * as build from '@/utils/localpay/build'
import { awdlTransport } from '@/utils/localpay/transport/awdl'
import { localSupportsAwdl, selectTransport } from '@/utils/localpay/transport/select'

describe('nearby rail adapter', () => {
  it('re-exports the localpay functions by identity, so nothing is reimplemented', () => {
    expect(nearby.mintSession).toBe(session.mintSession)
    expect(nearby.encodeSession).toBe(session.encodeSession)
    expect(nearby.decodeSession).toBe(session.decodeSession)
    expect(nearby.frameToQr).toBe(codec.frameToQr)
    expect(nearby.frameBytesFromQr).toBe(codec.frameBytesFromQr)
    expect(nearby.FRAME_BLOCK_BYTES).toBe(codec.FRAME_BLOCK_BYTES)
    expect(nearby.verifyFramePayment).toBe(verify.verifyFramePayment)
    expect(nearby.FrameVerifyError).toBe(verify.FrameVerifyError)
    expect(nearby.savePending).toBe(pending.savePending)
    expect(nearby.processPending).toBe(pending.processPending)
    expect(nearby.isSessionSpent).toBe(pending.isSessionSpent)
    expect(nearby.markSessionSpent).toBe(pending.markSessionSpent)
    expect(nearby.buildPaymentFrame).toBe(build.buildPaymentFrame)
    expect(nearby.finalizeDelivery).toBe(build.finalizeDelivery)
    expect(nearby.awdlTransport).toBe(awdlTransport)
    expect(nearby.selectTransport).toBe(selectTransport)
    expect(nearby.localSupportsAwdl).toBe(localSupportsAwdl)
  })
})
