/**
 * PDF design test script — NOT included in the mobile app build.
 *
 * Generates a random private key, splits it into 2-of-3 backup shares,
 * then renders the printable HTML to a local file and opens it in the
 * browser so you can use File → Print → Save as PDF to iterate on the design.
 *
 * Usage:  npm run pdf
 */

import { PrivateKey } from '@bsv/sdk'
import { execSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { generatePrintHTML } from '../utils/backupShares'

async function main() {
  // Generate a random private key
  const key = PrivateKey.fromRandom()

  // Split into 2-of-3 backup shares
  const shares = key.toBackupShares(2, 3)

  // Use a fake identity key (public key hex) for the print layout
  const identityKey = key.toPublicKey().toString()

  console.log('Generated shares:')
  shares.forEach((s, i) => console.log(`  Share ${i + 1}: ${s}`))
  console.log(`  Identity key: ${identityKey}`)

  // Render the HTML using the same function the app uses
  const html = await generatePrintHTML(shares, identityKey)

  // Write to a temp file and open in the default browser
  const outPath = path.join(os.tmpdir(), 'bsv-backup-shares.html')
  fs.writeFileSync(outPath, html, 'utf8')

  console.log(`\nHTML written to: ${outPath}`)
  console.log('Opening in browser — use File → Print → Save as PDF to export.\n')

  // Cross-platform open
  const platform = process.platform
  if (platform === 'darwin') {
    execSync(`open "${outPath}"`)
  } else if (platform === 'win32') {
    execSync(`start "" "${outPath}"`)
  } else {
    execSync(`xdg-open "${outPath}"`)
  }
}

main().catch(err => {
  console.error('Error:', err)
  process.exit(1)
})
