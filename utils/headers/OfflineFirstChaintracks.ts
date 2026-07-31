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
import type { ChaintracksClientApi } from '@bsv/wallet-toolbox-mobile/out/src/services/chaintracker/chaintracks/Api/ChaintracksClientApi'
import type { HeaderStore } from './headerStore'

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
    const local = this.store?.rootForHeight(height)
    if (local !== undefined) return local === root

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
      const remoteRoot = String(header.merkleRoot)
      await this.store?.putExtraRoot(height, remoteRoot)
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
