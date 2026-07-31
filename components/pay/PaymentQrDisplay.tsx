/**
 * One payment code, whatever its size: air-gap fountain parts, always. A frame
 * that fits one source block — every ordinary single-input payment — is a still
 * QR, because one part carries the whole message and this renderer holds `seq`
 * at 0 for it. Anything larger animates: parts at 5/s, endlessly — the receiver
 * needs any ~K distinct parts, so there is no "start", no "end", and nothing to
 * coordinate. The decision is made from the payload alone so every caller (send
 * screen, re-show modal) behaves identically.
 */
import React, { useEffect, useMemo, useState } from 'react'
import QRCode from 'react-native-qrcode-svg'
import { AirGapEncoder, FRAME_BLOCK_BYTES, frameBytesFromQr } from '@/utils/pay/rails/nearby'

/**
 * Sender cadence: five parts a second. Lives here, not in `@bsv/air-gap` —
 * the library encodes and stops at the byte array, leaving display rate to
 * whoever is holding the phone up.
 */
const FRAME_MS = 200

/**
 * Where `seq` wraps. The library's own guidance: keep looping rather than
 * counting up forever, since recovery is probabilistic and the repeating
 * systematic prefix is what guarantees every receiver eventually finishes.
 * Sixty-four passes over the block set is far more than any hand-held scan
 * needs and keeps `seq` nowhere near its u32 ceiling.
 */
const SEQ_WRAP_CYCLES = 64

export default function PaymentQrDisplay({
  frameQr,
  size = 288,
  onError
}: {
  /** The stored bsvpayf1: frame envelope. */
  frameQr: string
  size?: number
  /** Backstop for an unrenderable payload — pass the screen's handler. */
  onError?: () => void
}) {
  const encoder = useMemo(() => {
    try {
      return new AirGapEncoder(frameBytesFromQr(frameQr), { blockBytes: FRAME_BLOCK_BYTES })
    } catch {
      return null // >64 KB, or a malformed envelope out of storage
    }
  }, [frameQr])

  const [part, setPart] = useState<string | null>(null)

  useEffect(() => {
    if (!encoder) {
      setPart(null)
      return
    }
    setPart(encoder.partAt(0))
    // One block IS the whole message, so a second part could add nothing and
    // there is no timer to run: the code sits still and scans on the first read.
    if (encoder.blockCount === 1) return
    const wrapAt = encoder.blockCount * SEQ_WRAP_CYCLES
    let seq = 0
    const id = setInterval(() => {
      seq = (seq + 1) % wrapAt
      setPart(encoder.partAt(seq))
    }, FRAME_MS)
    return () => clearInterval(id)
  }, [encoder])

  // An unrenderable payload used to reach the caller through <QRCode onError>.
  // It cannot any more — the failure now happens in the encoder, before there is
  // anything to render — so report it on the same channel, from an effect rather
  // than inline, since flipping caller state from a child's render is what
  // React's cross-component update warning is about.
  useEffect(() => {
    if (!encoder) onError?.()
  }, [encoder, onError])

  if (!part) return null
  return <QRCode value={part} size={size} ecl="M" color="#000" backgroundColor="#fff" onError={onError} />
}
