import { Directory, File, Paths } from 'expo-file-system'
import { shareAsync } from 'expo-sharing'
import type { WalletInterface, WalletAction } from '@bsv/sdk'
import type { StorageExpoSQLite } from '@/storage'

const PAGE = 200

function csvEscape(v: unknown): string {
  if (v == null) return ''
  const s = String(v)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

/**
 * Exports all wallet transactions as a CSV file via the OS share dialog.
 * Columns: txid, satoshis (signed), description, status, blockHeight,
 * tags (semi-colon), labels (semi-colon), outputDescriptions (semi-colon).
 *
 * Returns the number of rows exported.
 */
export async function exportTransactionsAsCsv(
  wallet: WalletInterface,
  storage: StorageExpoSQLite | null,
  adminOriginator: string
): Promise<number> {
  const actions: WalletAction[] = []
  let offset = 0
  let total = Infinity
  while (offset < total) {
    const r = await wallet.listActions(
      {
        labels: [],
        includeLabels: true,
        includeOutputs: true,
        limit: PAGE,
        offset
      },
      adminOriginator
    )
    total = r.totalActions
    if (r.actions.length === 0) break
    actions.push(...r.actions)
    offset += r.actions.length
  }

  if (actions.length === 0) return 0

  const heightMap = new Map<string, number>()
  if (storage) {
    const proven = await storage.findProvenTxs({ partial: {} })
    for (const p of proven) {
      if (p.txid && typeof p.height === 'number') heightMap.set(p.txid, p.height)
    }
  }

  const header = [
    'txid',
    'satoshis',
    'description',
    'status',
    'blockHeight',
    'tags',
    'labels',
    'outputDescriptions'
  ].join(',')

  const rows = actions.map(a => {
    const sats = a.isOutgoing ? -Math.abs(a.satoshis) : Math.abs(a.satoshis)
    const outputs = a.outputs || []
    const tagsSet = new Set<string>()
    for (const o of outputs) for (const t of (o as any).tags || []) tagsSet.add(t)
    const tags = Array.from(tagsSet).join(';')
    const labels = (a.labels || []).join(';')
    const outDescs = outputs
      .map((o: any) => o.outputDescription)
      .filter((d: string) => d && d.length > 0)
      .join(';')
    const height = heightMap.get(a.txid) ?? ''
    return [
      csvEscape(a.txid),
      csvEscape(sats),
      csvEscape(a.description),
      csvEscape(a.status),
      csvEscape(height),
      csvEscape(tags),
      csvEscape(labels),
      csvEscape(outDescs)
    ].join(',')
  })

  const csv = [header, ...rows].join('\n') + '\n'

  const ts = Math.floor(Date.now() / 1000)
  const outName = `bsv-transactions-${ts}.csv`
  const tempDir = new Directory(Paths.cache, 'bsv-tx-export')
  if (tempDir.exists) tempDir.delete()
  tempDir.create({ intermediates: true })

  try {
    const outFile = new File(tempDir, outName)
    outFile.write(csv)
    await shareAsync(outFile.uri, {
      mimeType: 'text/csv',
      dialogTitle: outName,
      UTI: 'public.comma-separated-values-text'
    })
  } finally {
    try {
      tempDir.delete()
    } catch {}
  }

  return actions.length
}
