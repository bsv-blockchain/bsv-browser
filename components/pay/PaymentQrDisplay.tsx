/**
 * One payment code, whatever its size. A frame that fits a single symbol
 * renders as today's static QR. A larger one animates: air-gap fountain parts
 * at 5/s, endlessly — the receiver needs any ~K distinct parts, so there is
 * no "start", no "end", and nothing to coordinate. The decision is made from
 * the payload alone so every caller (send screen, re-show modal) behaves
 * identically.
 */
import React, { useEffect, useMemo, useState } from 'react'
import QRCode from 'react-native-qrcode-svg'
import { AirGapEncoder, MAX_FRAME_QR_CHARS, frameBytesFromQr } from '@/utils/pay/rails/nearby'

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
  /** The full bsvpayf1: payload. */
  frameQr: string
  size?: number
  /** Backstop for the encoder throwing out of render — pass the screen's handler. */
  onError?: () => void
}) {
  const encoder = useMemo(() => {
    if (frameQr.length <= MAX_FRAME_QR_CHARS) return null
    try {
      return new AirGapEncoder(frameBytesFromQr(frameQr))
    } catch {
      return null // >64 KB or malformed: let the static path hit onError
    }
  }, [frameQr])

  const [part, setPart] = useState<string | null>(null)

  useEffect(() => {
    if (!encoder) {
      setPart(null)
      return
    }
    const wrapAt = encoder.blockCount * SEQ_WRAP_CYCLES
    let seq = 0
    setPart(encoder.partAt(0))
    const id = setInterval(() => {
      seq = (seq + 1) % wrapAt
      setPart(encoder.partAt(seq))
    }, FRAME_MS)
    return () => clearInterval(id)
  }, [encoder])

  const value = encoder ? part : frameQr
  if (!value) return null
  return <QRCode value={value} size={size} ecl="M" color="#000" backgroundColor="#fff" onError={onError} />
}
