/**
 * Backup shares — Shamir 2-of-3 recovery paper.
 *
 * The secret being split is the MNEMONIC ENTROPY, per BRC-157, not the primary
 * key at m/0'/0'. That derivation is hardened and one-way, so shares of it can
 * restore spending authority but can never rebuild the phrase — and the vault
 * key needs the phrase. Splitting the entropy makes paper and phrase two
 * encodings of one secret.
 *
 * The split payload is always exactly 32 bytes:
 *
 *     entropy(16) || sha256(entropy)[0..16]
 *
 * The tag exists so recovery can tell new paper from old WITHOUT a version
 * marker on the printed page, which would break every sheet already in a
 * drawer. Length cannot do that job: PrivateKey is a BigNumber and drops
 * leading zero bytes (~1 payload in 256), and an imported 24-word phrase
 * yields 32 bytes of entropy — the exact width of a legacy primary key.
 *
 * Do NOT try to validate the entropy branch by rebuilding a mnemonic and
 * checking its BIP39 checksum. Mnemonic.fromEntropy COMPUTES that checksum, so
 * it accepts any 16 bytes and can never reject a misclassification.
 */

import { PrivateKey, Hash } from '@bsv/sdk'
import QRCode from 'qrcode'

// ── Payload framing ──────────────────────────────────────────────────────────

/** Entropy of a 12-word BIP39 phrase. The only width v2 shares support. */
export const ENTROPY_BYTES = 16
/** Fixed width of the split secret. Never varies, never inferred. */
export const PAYLOAD_BYTES = 32

/** What a recombined payload turned out to be. */
export type RecoveredSecret =
  | { kind: 'entropy'; entropy: number[] }
  | { kind: 'legacy'; primaryKey: number[] }

/** Wrap 16 bytes of entropy in the tagged 32-byte payload. */
export function frameEntropy(entropy: number[]): number[] {
  if (entropy.length !== ENTROPY_BYTES) {
    throw new Error(`frameEntropy: expected ${ENTROPY_BYTES} bytes, got ${entropy.length}`)
  }
  return [...entropy, ...Hash.sha256(entropy).slice(0, PAYLOAD_BYTES - ENTROPY_BYTES)]
}

/**
 * Restore a recombined payload to full width.
 *
 * Shamir recombination yields a PrivateKey, whose toArray() drops leading zero
 * bytes. Without this pad, roughly one payload in 256 decodes short and fails
 * to match anything.
 */
export function padPayload(bytes: number[]): number[] {
  if (bytes.length > PAYLOAD_BYTES) {
    throw new Error(`padPayload: payload exceeds ${PAYLOAD_BYTES} bytes`)
  }
  return [...new Array(PAYLOAD_BYTES - bytes.length).fill(0), ...bytes]
}

/** Decide whether a recombined payload is framed entropy or a legacy key. */
export function classifyPayload(raw: number[]): RecoveredSecret {
  const payload = padPayload(raw)
  const entropy = payload.slice(0, ENTROPY_BYTES)
  const tag = payload.slice(ENTROPY_BYTES)
  const expected = Hash.sha256(entropy).slice(0, PAYLOAD_BYTES - ENTROPY_BYTES)

  return tag.every((b, i) => b === expected[i])
    ? { kind: 'entropy', entropy }
    : { kind: 'legacy', primaryKey: payload }
}

// ── Share generation ─────────────────────────────────────────────────────────

/**
 * Split mnemonic entropy into backup shares (the current format).
 * @param entropy 16 bytes, from Mnemonic.toEntropy()
 * @returns Share strings in the format base58(x).base58(y).threshold.integrity
 */
export function generateEntropyShares(
  entropy: number[],
  threshold: number = 2,
  totalShares: number = 3
): string[] {
  return new PrivateKey(frameEntropy(entropy)).toBackupShares(threshold, totalShares)
}

/**
 * Split a raw private key (the legacy format).
 *
 * Still reachable for wallets that were themselves restored from legacy paper
 * and therefore have no mnemonic to frame. Removing it would leave that cohort
 * with no way to back up at all; the tag check routes their shares back to the
 * legacy branch on recovery, so this stays self-consistent.
 */
export function generateLegacyKeyShares(
  privateKeyBytes: number[],
  threshold: number = 2,
  totalShares: number = 3
): string[] {
  return new PrivateKey(privateKeyBytes).toBackupShares(threshold, totalShares)
}

// ── Share validation ─────────────────────────────────────────────────────────

export interface ParsedShare {
  raw: string
  x: string
  y: string
  threshold: number
  integrity: string
}

/**
 * Parse and validate a single backup share string.
 * @returns Parsed share or null if invalid format
 */
export function parseShare(shareString: string): ParsedShare | null {
  const parts = shareString.trim().split('.')
  if (parts.length !== 4) return null

  const [x, y, thresholdStr, integrity] = parts
  const threshold = Number(thresholdStr)

  if (!x || !y || isNaN(threshold) || threshold < 2 || !integrity) return null

  return { raw: shareString.trim(), x, y, threshold, integrity }
}

/**
 * Validate that a new share is compatible with previously collected shares.
 * @returns Error message string or null if valid
 */
export function validateShareCompatibility(newShare: ParsedShare, existingShares: ParsedShare[]): string | null {
  if (existingShares.length === 0) return null

  const first = existingShares[0]

  if (newShare.threshold !== first.threshold) {
    return 'Threshold does not match previous shares'
  }

  if (newShare.integrity !== first.integrity) {
    return 'Integrity hash does not match — shares are from different keys'
  }

  // Check for duplicate (same x.y point)
  const isDuplicate = existingShares.some(s => s.x === newShare.x && s.y === newShare.y)
  if (isDuplicate) {
    return 'This share has already been scanned'
  }

  return null
}

/**
 * Recombine shares and say what came out.
 * @param shareStrings At least `threshold` raw share strings
 * @throws If the shares are invalid or their integrity hashes disagree
 */
export function recoverSecretFromShares(shareStrings: string[]): RecoveredSecret {
  return classifyPayload(Array.from(PrivateKey.fromBackupShares(shareStrings).toArray()))
}

// ── Print HTML generation ────────────────────────────────────────────────────

/**
 * Generate a QR code as an inline SVG string.
 * Uses the `qrcode` package which does pure-JS SVG string generation.
 */
async function generateQRCodeSVG(data: string, size: number = 180): Promise<string> {
  const svgString = await QRCode.toString(data, {
    type: 'svg',
    width: size,
    margin: 1,
    errorCorrectionLevel: 'M'
  })
  return svgString
}

/**
 * Generate printable HTML with one page per backup share.
 *
 * Layout matches the reference implementation (secure-key-backup-and-recovery):
 *   - Header: "Share N of M" + date stamp
 *   - Share QR code + share text
 *   - Identity Key QR code + identity key text
 *   - Recovery instructions footer
 *
 * Pages are separated by CSS page-break-after for print dialogue.
 */
export async function generatePrintHTML(
  shares: string[],
  identityKey: string,
  format: 'entropy' | 'legacy' = 'entropy'
): Promise<string> {
  const now = new Date()
  const date = now.toISOString().split('T')[0]
  const time = now.toISOString().split('T')[1].split('.')[0]
  const dateStamp = `${date} ${time}`

  // Pre-generate all QR codes
  const shareQRs = await Promise.all(shares.map(s => generateQRCodeSVG(s, 180)))
  const identityQR = await generateQRCodeSVG(identityKey, 150)

  const pages = shares.map(
    (share, i) => `
    <div class="page${i < shares.length - 1 ? '' : ' last'}">
      <div class="header">
        <span class="share-label">Share ${i + 1} of ${shares.length}</span>
        <span class="date-stamp">${dateStamp}</span>
      </div>

      <div class="section">
        <div class="qr-container identity-qr">
          ${identityQR}
        </div>
        <div class="data-label">Identity Key</div>
        <div class="data-value">${identityKey}</div>
        <div class="identity-caption">Scan this QR code to send BSV payments to this wallet.</div>
      </div>

      <div class="divider"></div>

      <div class="section">
        <div class="qr-container">
          ${shareQRs[i]}
        </div>
        <div class="data-label">Backup Share</div>
        <div class="data-value share-text">${share}</div>
      </div>

      <div class="divider"></div>

      <div class="instructions">
        <strong>Recovery Instructions</strong>
        <p>This is 1 of ${shares.length} backup shares. You need any ${shares[0].split('.')[2]} shares to recover your wallet.</p>
        <p>Store each share in a separate, secure location. Do not store shares together.</p>
        <p>${
          format === 'entropy'
            ? 'Any two of these pages rebuild your twelve-word recovery phrase, and therefore your entire wallet — everyday balance and vault alike. Treat two pages together as you would the phrase itself.'
            : 'These shares are an older format. They restore your everyday balance but cannot open a vault.'
        }</p>
        <p>To recover: In BSV Browser, go to Enable Web3 &rarr; Import Existing Wallet &rarr; Scan Backup Shares.</p>
      </div>
    </div>
  `
  )

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }

        body {
          font-family: 'Courier New', Courier, monospace;
          font-weight: 700;
          color: #000;
          background: #fff;
        }

        .page {
          width: 100%;
          padding: 12mm 15mm;
          page-break-after: always;
        }
        .page.last {
          page-break-after: auto;
        }

        .header {
          display: flex;
          justify-content: space-between;
          align-items: baseline;
          margin-bottom: 6mm;
          padding-bottom: 3mm;
          border-bottom: 1px solid #ccc;
        }
        .share-label {
          font-size: 16pt;
          font-weight: 700;
        }
        .date-stamp {
          font-size: 9pt;
          color: #444;
        }

        .section {
          margin-bottom: 4mm;
        }
        .qr-container {
          margin-bottom: 3mm;
        }
        .qr-container svg {
          width: 50mm;
          height: 50mm;
        }
        .identity-qr svg {
          width: 40mm;
          height: 40mm;
        }

        .data-label {
          font-size: 11pt;
          font-weight: 700;
          color: #000;
          margin-bottom: 1.5mm;
        }
        .data-value {
          font-size: 7pt;
          font-weight: 700;
          word-break: break-all;
          line-height: 1.4;
          color: #000;
        }
        .share-text {
          font-size: 8.2pt;
          word-break: normal;
          white-space: nowrap;
        }

        .identity-caption {
          margin-top: 2mm;
          font-size: 9pt;
          font-weight: 700;
          color: #000;
        }

        .divider {
          border-top: 1px solid #e0e0e0;
          margin: 4mm 0;
        }

        .instructions {
          margin-top: 4mm;
          font-size: 10pt;
          font-weight: 700;
          line-height: 1.6;
          color: #000;
        }
        .instructions strong {
          display: block;
          font-size: 11pt;
          margin-bottom: 2mm;
        }
        .instructions p {
          margin-bottom: 1.5mm;
        }

        @media print {
          body { background: #fff; }
          .page { padding: 10mm 12mm; }
        }
      </style>
    </head>
    <body>
      ${pages.join('\n')}
    </body>
    </html>
  `
}
