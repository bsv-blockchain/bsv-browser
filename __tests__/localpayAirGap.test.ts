/**
 * The animated-QR transport itself is `@bsv/air-gap`, which carries its own
 * unit, property and conformance-vector suites upstream — re-testing the Luby
 * transform here would pin someone else's internals.
 *
 * What IS ours, and what these tests pin: that a payment frame survives the
 * round trip through that transport unchanged, that the parts we ask it to
 * produce actually fit the symbol this app renders, and that the two app-side
 * guards either side of it — the size ceiling and the part-routing predicate —
 * agree with the library's own limits.
 */
import { AirGapDecoder, AirGapEncoder, MAX_MESSAGE_BYTES, estimatePartCharLength, isAirGapPart } from '@bsv/air-gap'
import {
  MAX_FRAME_QR_CHARS,
  decodeFrame,
  encodeFrame,
  frameBytesFromQr,
  frameToQr,
  type PaymentFrame
} from '@/utils/localpay/codec'

/** A frame whose AtomicBEEF is far too large for one symbol. */
function bigFrame(transactionBytes: number): PaymentFrame {
  const transaction = new Uint8Array(transactionBytes)
  for (let i = 0; i < transactionBytes; i++) transaction[i] = (i * 31 + 7) & 0xff
  return {
    version: 2,
    senderIdentityKey: '02' + 'ab'.repeat(32),
    outputIndex: 1,
    derivationPrefix: 'cHJlZml4',
    derivationSuffix: 'c3VmZml4',
    transaction
  }
}

/** Feed parts in order until the decoder completes, capped so a bug cannot hang. */
function drain(encoder: AirGapEncoder, decoder: AirGapDecoder, maxParts: number): Uint8Array | null {
  for (let seq = 0; seq < maxParts; seq++) {
    if (decoder.accept(encoder.partAt(seq)).done) return decoder.message()
  }
  return null
}

describe('payment frames over @bsv/air-gap', () => {
  it('round-trips a multi-symbol frame back to the identical frame', () => {
    const frame = bigFrame(6000)
    const wire = frameToQr(frame)
    expect(wire.length).toBeGreaterThan(MAX_FRAME_QR_CHARS) // genuinely needs the fountain

    const message = drain(new AirGapEncoder(frameBytesFromQr(wire)), new AirGapDecoder(), 200)
    expect(message).not.toBeNull()
    expect(Array.from(message!)).toEqual(Array.from(encodeFrame(frame)))

    const decoded = decodeFrame(message!)
    expect(decoded.senderIdentityKey).toBe(frame.senderIdentityKey)
    expect(decoded.outputIndex).toBe(frame.outputIndex)
    expect(decoded.derivationPrefix).toBe(frame.derivationPrefix)
    expect(decoded.derivationSuffix).toBe(frame.derivationSuffix)
    expect(Array.from(decoded.transaction)).toEqual(Array.from(frame.transaction))
  })

  it('recovers when the camera misses parts, which is the whole point of a fountain', () => {
    const frame = bigFrame(6000)
    const encoder = new AirGapEncoder(frameBytesFromQr(frameToQr(frame)))
    const decoder = new AirGapDecoder()
    let message: Uint8Array | null = null
    // Drop every third part: there is no back-channel to ask for a resend.
    for (let seq = 0; seq < 400 && !message; seq++) {
      if (seq % 3 === 2) continue
      if (decoder.accept(encoder.partAt(seq)).done) message = decoder.message()
    }
    expect(message).not.toBeNull()
    expect(Array.from(message!)).toEqual(Array.from(encodeFrame(frame)))
  })

  it('every part fits the symbol this app renders', () => {
    // The renderer hands parts to <QRCode ecl="M">, which THROWS OUT OF RENDER
    // past capacity and takes the app down through the error boundary. The
    // default block size must therefore stay inside our own ceiling.
    expect(estimatePartCharLength()).toBeLessThanOrEqual(MAX_FRAME_QR_CHARS)

    const encoder = new AirGapEncoder(frameBytesFromQr(frameToQr(bigFrame(40000))))
    for (const seq of [0, 1, encoder.blockCount, encoder.blockCount + 17]) {
      expect(encoder.partAt(seq).length).toBeLessThanOrEqual(MAX_FRAME_QR_CHARS)
    }
  })

  it('routes parts and non-parts the way the scanner does', () => {
    const part = new AirGapEncoder(new Uint8Array([1, 2, 3])).partAt(0)
    expect(isAirGapPart(part)).toBe(true)
    // The two other QR kinds this scanner sees must never enter the decoder.
    expect(isAirGapPart(frameToQr(bigFrame(10)))).toBe(false)
    expect(isAirGapPart('bsvpay1:c2Vzc2lvbg')).toBe(false)
  })

  it('refuses a message past the ceiling the send path checks against', () => {
    // NearbyFlow gates on encodeFrame(...).length > MAX_MESSAGE_BYTES before it
    // ever builds an encoder; this pins that the library agrees rather than
    // silently truncating.
    expect(() => new AirGapEncoder(new Uint8Array(MAX_MESSAGE_BYTES + 1))).toThrow()
  })
})
