/**
 * The pre-encrypt size gate must see strings.
 *
 * With blob columns compressed at rest, the remaining way a single record goes
 * oversize is a string — a pre-scrub proven_tx_reqs.history carrying megabytes
 * of EF hex in provider error notes. The original walk priced only byte
 * arrays, so such a chunk estimated at ~0, sailed past the gate, and hit the
 * exact ~50 s encrypt-then-413 loop the gate exists to prevent.
 */
import { estimateEncodedBytes } from '@/utils/backup/codec'
import { MAX_BLOB_BYTES } from '@/utils/backup/constants'
import type { SyncChunk } from '@bsv/wallet-toolbox-mobile/out/src/sdk/WalletStorage.interfaces'

const chunk = (over: Record<string, unknown>): SyncChunk =>
  ({ fromStorageIdentityKey: '', toStorageIdentityKey: '', userIdentityKey: '', ...over }) as unknown as SyncChunk

describe('estimateEncodedBytes and strings', () => {
  it('counts a giant history string against the cap', () => {
    const history = 'ab'.repeat(700_000) // 1.4 MB of EF hex in an error note
    const estimate = estimateEncodedBytes(chunk({ provenTxReqs: [{ txid: 'aa', history }] }))
    expect(estimate).toBeGreaterThan(MAX_BLOB_BYTES)
  })

  it('remains a lower bound for ordinary small chunks', () => {
    const estimate = estimateEncodedBytes(
      chunk({ transactions: [{ txid: 'aa', description: 'coffee', rawTx: new Array(400).fill(1) }] })
    )
    expect(estimate).toBeGreaterThan(400)
    expect(estimate).toBeLessThan(10_000)
  })

  it('still prices byte arrays at their base64 cost', () => {
    const estimate = estimateEncodedBytes(chunk({ provenTxs: [{ rawTx: new Array(900_000).fill(0xaa) }] }))
    expect(estimate).toBeGreaterThanOrEqual(Math.ceil(900_000 / 3) * 4)
  })
})
