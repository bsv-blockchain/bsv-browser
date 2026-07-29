/**
 * One payment code, whatever its size. A frame that fits a single symbol
 * renders as today's static QR. A larger one animates: FountainEncoder parts
 * at 5/s, endlessly — the receiver needs any ~K distinct parts, so there is
 * no "start", no "end", and nothing to coordinate. The decision is made from
 * the payload alone so every caller (send screen, re-show modal) behaves
 * identically.
 */
import React, { useEffect, useMemo, useState } from 'react'
import QRCode from 'react-native-qrcode-svg'
import { FOUNTAIN_FRAME_MS, FountainEncoder, MAX_FRAME_QR_CHARS, frameBytesFromQr } from '@/utils/pay/rails/nearby'

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
      return new FountainEncoder(frameBytesFromQr(frameQr))
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
    let seq = 0
    setPart(encoder.partAt(0))
    const id = setInterval(() => {
      seq += 1
      setPart(encoder.partAt(seq))
    }, FOUNTAIN_FRAME_MS)
    return () => clearInterval(id)
  }, [encoder])

  const value = encoder ? part : frameQr
  if (!value) return null
  return <QRCode value={value} size={size} ecl="M" color="#000" backgroundColor="#fff" onError={onError} />
}
