/**
 * The chain tracker the wallet uses. Answers merkle roots from the local header
 * window first, the network second, and nothing at all when offline and the
 * height is outside the window.
 *
 * This is the single seam that makes offline payments possible: both BEEF
 * verification call sites — `signer/methods/internalizeAction.js:96` and
 * `storage/methods/createAction.js:495` — reach it through
 * `Services.getChainTracker()`, which wraps whatever sits in
 * `options.chaintracks` (`services/Services.js:149-154`).
 *
 * On a miss it calls `findHeaderForHeight` rather than the remote's own
 * `isValidRootForHeight`, because we want the root itself to cache — a coin
 * whose ancestry we resolved once should verify offline forever after.
 */
import { Utils } from '@bsv/sdk'
import type { ChaintracksClientApi } from '@bsv/wallet-toolbox-mobile/out/src/services/chaintracker/chaintracks/Api/ChaintracksClientApi'
import type { HeaderStore } from './headerStore'

/** A merkle root as display-order hex, whether the source gave us a hex string
 * or raw bytes. The remote's `findHeaderForHeight` may return either; plain
 * `String(bytes)` yields "1,2,3,…" which never matches a real root — the source
 * of a chain-tracker that rejects valid proofs. Mirrors the toolbox's own
 * `asString(merkleRoot)`. */
function rootHex(v: unknown): string {
  return typeof v === 'string' ? v : Utils.toHex(Array.from(v as ArrayLike<number>))
}

export class OfflineFirstChaintracks implements ChaintracksClientApi {
  private store: HeaderStore | undefined
  /**
   * Height of the most recent root we could not resolve. The UI reads it to
   * explain a refusal ("this coin's history is older than the headers on this
   * device") instead of showing a bare verification failure.
   */
  lastMissHeight: number | undefined

  constructor(
    private readonly remote: ChaintracksClientApi,
    private readonly online: () => Promise<boolean>
  ) {}

  setStore(store: HeaderStore): void {
    this.store = store
  }

  async isValidRootForHeight(root: string, height: number): Promise<boolean> {
    // Fast path: a local root that AGREES is trusted offline forever (validated
    // window headers, or a previously-resolved root). We do NOT trust a local
    // DISAGREEMENT — it can be a stale/poisoned cache entry or an index error —
    // so a miss OR a mismatch both fall through to the authoritative network.
    const local = this.store?.rootForHeight(height)
    if (local === root) return true

    if (!(await this.online())) {
      this.lastMissHeight = height
      return false
    }

    try {
      const header = await this.remote.findHeaderForHeight(height)
      if (!header) {
        this.lastMissHeight = height
        return false
      }
      const remoteRoot = rootHex(header.merkleRoot)
      // Refresh the cache with the authoritative value (self-heals a poisoned
      // extra entry from an earlier bad conversion).
      await this.store?.putExtraRoot(height, remoteRoot)
      if (local !== undefined && local !== remoteRoot) {
        console.warn(
          `[OfflineFirstChaintracks] local root disagreed with network at height ${height} (local=${local} network=${remoteRoot}); healed`
        )
      }
      return remoteRoot === root
    } catch (e: any) {
      // A verification path must never throw a network error at the caller:
      // `Beef.verify` treats false as "not proven", which is the truth here.
      console.warn('[OfflineFirstChaintracks] isValidRootForHeight lookup failed:', e?.message)
      this.lastMissHeight = height
      return false
    }
  }

  async currentHeight(): Promise<number> {
    if (await this.online()) return await this.remote.currentHeight()
    return this.store?.tipHeight ?? 0
  }

  // ── Everything below is pure delegation ───────────────────────────────────
  getChain() {
    return this.remote.getChain()
  }
  getInfo() {
    return this.remote.getInfo()
  }
  getPresentHeight() {
    return this.remote.getPresentHeight()
  }
  getHeaders(height: number, count: number) {
    return this.remote.getHeaders(height, count)
  }
  findChainTipHeader() {
    return this.remote.findChainTipHeader()
  }
  findChainTipHash() {
    return this.remote.findChainTipHash()
  }
  findHeaderForHeight(height: number) {
    return this.remote.findHeaderForHeight(height)
  }
  findHeaderForBlockHash(hash: string) {
    return this.remote.findHeaderForBlockHash(hash)
  }
  addHeader(header: Parameters<ChaintracksClientApi['addHeader']>[0]) {
    return this.remote.addHeader(header)
  }
  startListening() {
    return this.remote.startListening()
  }
  listening() {
    return this.remote.listening()
  }
  isListening() {
    return this.remote.isListening()
  }
  isSynchronized() {
    return this.remote.isSynchronized()
  }
  subscribeHeaders(listener: Parameters<ChaintracksClientApi['subscribeHeaders']>[0]) {
    return this.remote.subscribeHeaders(listener)
  }
  subscribeReorgs(listener: Parameters<ChaintracksClientApi['subscribeReorgs']>[0]) {
    return this.remote.subscribeReorgs(listener)
  }
  unsubscribe(subscriptionId: string) {
    return this.remote.unsubscribe(subscriptionId)
  }
}
