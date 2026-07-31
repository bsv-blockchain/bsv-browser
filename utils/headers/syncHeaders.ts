/**
 * Pulls headers from a chaintracks deployment into the local window.
 *
 * `getHeaders(height, count)` returns hex of concatenated 80-byte headers and is
 * the only header source that works on every chain we ship — there is no bulk
 * header CDN for teratest. Verified against both deployments on 2026-07-28.
 *
 * The default chunk of 2,000 headers is 320 KB of response body: about 26
 * requests per year of mainnet headers, small enough that a dropped connection
 * costs almost nothing and progress moves visibly.
 */
import { Utils } from '@bsv/sdk'
import type { HeaderStore } from './headerStore'

export interface HeaderSource {
  getHeaders(height: number, count: number): Promise<string>
  getPresentHeight(): Promise<number>
}

export interface SyncHeadersResult {
  added: number
  tipHeight: number
  presentHeight: number
}

export async function syncHeaders(args: {
  store: HeaderStore
  client: HeaderSource
  chunkSize?: number
  onProgress?: (tipHeight: number, presentHeight: number) => void
  shouldStop?: () => boolean
}): Promise<SyncHeadersResult> {
  const { store, client, chunkSize = 2000, onProgress, shouldStop } = args
  const presentHeight = await client.getPresentHeight()
  let added = 0

  while (store.tipHeight < presentHeight) {
    if (shouldStop?.()) break
    const from = store.tipHeight + 1
    const want = Math.min(chunkSize, presentHeight - store.tipHeight)
    const hex = await client.getHeaders(from, want)
    if (!hex) break
    const bytes = new Uint8Array(Utils.toArray(hex, 'hex'))
    if (bytes.length === 0) break
    // A validation failure must propagate. A truncated-but-silent sync would
    // leave a window that looks complete and quietly refuses real payments.
    added += await store.append(bytes, from)
    onProgress?.(store.tipHeight, presentHeight)
  }

  return { added, tipHeight: store.tipHeight, presentHeight }
}
