/**
 * Backup shares utilities for Shamir's Secret Sharing based wallet backup.
 *
 * Splits the wallet's primary key (m/0'/0') into 2-of-3 backup shares and
 * generates printable HTML with QR codes for each share page.
 */

import { PrivateKey } from '@bsv/sdk'
import QRCode from 'qrcode'

// ── Share generation ─────────────────────────────────────────────────────────

/**
 * Split a primary key into backup shares using Shamir's Secret Sharing.
 * @param primaryKeyBytes The primary key as a number[] (from m/0'/0' derivation)
 * @param threshold Minimum shares required to recover (default 2)
 * @param totalShares Total number of shares to generate (default 3)
 * @returns Array of share strings in format: base58(x).base58(y).threshold.integrity
 */
export function generateBackupShares(
  primaryKeyBytes: number[],
  threshold: number = 2,
  totalShares: number = 3
): string[] {
  const key = new PrivateKey(primaryKeyBytes)
  return key.toBackupShares(threshold, totalShares)
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
 * Recover a PrivateKey from collected backup shares.
 * @param shareStrings Raw share strings (must have at least `threshold` shares)
 * @returns The recovered PrivateKey
 * @throws If shares are invalid or integrity check fails
 */
export function recoverKeyFromShares(shareStrings: string[]): PrivateKey {
  return PrivateKey.fromBackupShares(shareStrings)
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
export async function generatePrintHTML(shares: string[], identityKey: string): Promise<string> {
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
        <div class="qr-container">
          ${shareQRs[i]}
        </div>
        <div class="data-label">Backup Share</div>
        <div class="data-value share-text">${share}</div>
      </div>

      <div class="divider"></div>

      <div class="section">
        <div class="qr-container identity-qr">
          ${identityQR}
        </div>
        <div class="data-label">Identity Key</div>
        <div class="data-value">${identityKey}</div>
      </div>

      <div class="divider"></div>

      <div class="instructions">
        <strong>Recovery Instructions</strong>
        <p>This is 1 of ${shares.length} backup shares. You need any ${shares[0].split('.')[2]} shares to recover your wallet key.</p>
        <p>Store each share in a separate, secure location. Do not store shares together.</p>
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
          font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
          color: #1a1a1a;
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
          color: #666;
          font-family: 'Courier New', monospace;
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
          font-weight: 600;
          color: #333;
          margin-bottom: 1.5mm;
        }
        .data-value {
          font-size: 7pt;
          font-family: 'Courier New', monospace;
          color: #444;
          word-break: break-all;
          line-height: 1.4;
        }
        .share-text {
          font-size: 6.5pt;
        }

        .divider {
          border-top: 1px solid #e0e0e0;
          margin: 4mm 0;
        }

        .instructions {
          margin-top: 4mm;
          padding: 3mm;
          background: #f8f8f8;
          border: 1px solid #e0e0e0;
          border-radius: 2mm;
          font-size: 8pt;
          line-height: 1.5;
          color: #555;
        }
        .instructions strong {
          display: block;
          font-size: 9pt;
          color: #333;
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
