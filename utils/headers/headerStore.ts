/**
 * A validated window of block headers, on disk, plus an in-memory merkle-root
 * index.
 *
 * WHY THIS EXISTS: `Beef.verify` needs exactly one thing — a merkle root for a
 * block height (@bsv/sdk Beef.js:702-707). Everything else about offline
 * payments follows from being able to answer that with no network.
 *
 * SHAPE: `<chain>.bin` holds contiguous 80-byte headers starting at
 * `anchor.height + 1`; `<chain>.json` holds the metadata; `<chain>-extra.json`
 * holds roots resolved below the window while online. On open, one pass over
 * the .bin builds a packed Uint8Array of 32-byte roots — ~1.7 MB for a year,
 * versus ~3.4 MB if they were kept as hex strings — so a lookup is an array
 * slice and a hex encode rather than file I/O.
 *
 * VALIDATION is a single pass per appended chunk: link each header to the
 * previous hash, hash it once, check that hash against the target its own bits
 * declare, and keep the root. Doing it here rather than calling the toolbox's
 * `validateBufferOfHeaders` avoids hashing every header twice, since that
 * helper checks linkage but not difficulty.
 */
import { Utils } from '@bsv/sdk'
import {
  blockHash,
  deserializeBaseBlockHeader,
  validateHeaderDifficulty
} from '@bsv/wallet-toolbox-mobile/out/src/services/chaintracker/chaintracks/util/blockHeaderUtilities'
import type { HeaderCheckpoint } from './checkpoints'
import type { HeaderFs } from './fs'

const HEADER_BYTES = 80
const ROOT_BYTES = 32

interface StoredMeta {
  chain: string
  anchorHeight: number
  anchorHash: string
  count: number
  tipHash: string
}

export class HeaderStore {
  private roots: Uint8Array
  private extra: Record<string, string>
  private constructor(
    private readonly fs: HeaderFs,
    readonly chain: string,
    readonly anchor: HeaderCheckpoint,
    private headerCount: number,
    private currentTipHash: string,
    roots: Uint8Array,
    extra: Record<string, string>
  ) {
    this.roots = roots
    this.extra = extra
  }

  private get binPath(): string {
    return `${this.chain}.bin`
  }
  private get metaPath(): string {
    return `${this.chain}.json`
  }
  private get extraPath(): string {
    return `${this.chain}-extra.json`
  }

  /** First height held by the window. */
  get baseHeight(): number {
    return this.anchor.height + 1
  }
  get count(): number {
    return this.headerCount
  }
  /** Highest validated height, or the anchor height when the window is empty. */
  get tipHeight(): number {
    return this.anchor.height + this.headerCount
  }
  /** Hash of the highest validated header, or the anchor hash when empty. */
  get tipHash(): string {
    return this.currentTipHash
  }

  static async open(fs: HeaderFs, chain: string, anchor: HeaderCheckpoint): Promise<HeaderStore> {
    const extraRaw = await fs.readText(`${chain}-extra.json`)
    let extra: Record<string, string> = {}
    if (extraRaw) {
      try {
        const parsed = JSON.parse(extraRaw) as unknown
        if (parsed && typeof parsed === 'object') extra = parsed as Record<string, string>
      } catch {
        // A corrupt cache of roots is a cache miss, never a load failure.
      }
    }

    const metaRaw = await fs.readText(`${chain}.json`)
    let meta: StoredMeta | undefined
    if (metaRaw) {
      try {
        meta = JSON.parse(metaRaw) as StoredMeta
      } catch {
        meta = undefined
      }
    }

    const empty = new HeaderStore(fs, chain, anchor, 0, anchor.hash, new Uint8Array(0), extra)

    // A shipped checkpoint that moved (app update) invalidates the window: its
    // first header no longer links to anything we trust. Start over rather than
    // keep headers we can no longer justify.
    if (
      !meta ||
      meta.chain !== chain ||
      meta.anchorHeight !== anchor.height ||
      meta.anchorHash !== anchor.hash ||
      meta.count <= 0
    ) {
      await empty.writeMeta()
      return empty
    }

    const bin = await fs.readBytes(`${chain}.bin`)
    if (!bin || bin.length < meta.count * HEADER_BYTES) {
      await empty.writeMeta()
      return empty
    }

    const roots = new Uint8Array(meta.count * ROOT_BYTES)
    for (let i = 0; i < meta.count; i++) {
      // Merkle root occupies bytes 36..68 of a header, little-endian on the
      // wire and display order reversed.
      const src = bin.subarray(i * HEADER_BYTES + 36, i * HEADER_BYTES + 68)
      const display = src.slice().reverse()
      roots.set(display, i * ROOT_BYTES)
    }
    return new HeaderStore(fs, chain, anchor, meta.count, meta.tipHash, roots, extra)
  }

  rootForHeight(height: number): string | undefined {
    const index = height - this.baseHeight
    if (index >= 0 && index < this.headerCount) {
      return Utils.toHex(Array.from(this.roots.subarray(index * ROOT_BYTES, (index + 1) * ROOT_BYTES)))
    }
    return this.extra[String(height)]
  }

  /**
   * Validates and appends a chunk. Returns the number of headers added.
   *
   * Throws without mutating anything if the chunk is misaligned, starts at the
   * wrong height, fails to link, or contains a header whose hash does not meet
   * its declared target.
   */
  async append(bytes: Uint8Array, firstHeight: number): Promise<number> {
    if (bytes.length === 0) return 0
    if (bytes.length % HEADER_BYTES !== 0) {
      throw new Error(`header chunk must be a multiple of 80 bytes, got ${bytes.length}`)
    }
    if (firstHeight !== this.tipHeight + 1) {
      throw new Error(`header chunk starts at height ${firstHeight}, expected ${this.tipHeight + 1}`)
    }

    const added = bytes.length / HEADER_BYTES
    const newRoots = new Uint8Array(added * ROOT_BYTES)
    let prev = this.currentTipHash

    for (let i = 0; i < added; i++) {
      const offset = i * HEADER_BYTES
      const header = bytes.slice(offset, offset + HEADER_BYTES)
      const parsed = deserializeBaseBlockHeader(bytes, offset)
      if (parsed.previousHash !== prev) {
        throw new Error(
          `header at height ${firstHeight + i} names previous hash ${parsed.previousHash}, expected ${prev}`
        )
      }
      const hash = blockHash(header)
      // Throws on failure — a header that does not meet its own target is not a
      // header, and accepting it would let anyone mint merkle roots.
      // The upstream .d.ts types `hash` as Buffer, but the implementation only
      // ever does `asArray(hash)`, which accepts a display-order hex string
      // (what blockHash returns) identically to a Buffer — hence the cast.
      validateHeaderDifficulty(hash as unknown as Buffer, parsed.bits)
      newRoots.set(new Uint8Array(Utils.toArray(parsed.merkleRoot, 'hex')), i * ROOT_BYTES)
      prev = hash
    }

    await this.fs.appendBytes(this.binPath, bytes)
    const merged = new Uint8Array(this.roots.length + newRoots.length)
    merged.set(this.roots, 0)
    merged.set(newRoots, this.roots.length)
    this.roots = merged
    this.headerCount += added
    this.currentTipHash = prev
    await this.writeMeta()
    return added
  }

  async putExtraRoot(height: number, root: string): Promise<void> {
    if (this.extra[String(height)] === root) return
    this.extra = { ...this.extra, [String(height)]: root }
    await this.fs.writeText(this.extraPath, JSON.stringify(this.extra))
  }

  /**
   * Batch form of `putExtraRoot`. Merges every entry into the in-memory
   * `extra` map and writes the JSON file once, rather than once per entry —
   * `putExtraRoot` re-serializes and rewrites the whole file on every call,
   * so seeding it row-by-row from a proven_txs table is O(n) file writes for
   * n rows. Callers that resolve one miss at a time (OfflineFirstChaintracks)
   * should keep using `putExtraRoot`; callers seeding many roots at once
   * (prewarmOwnRoots) should use this instead. Returns how many entries were
   * newly added (i.e. not already present in the store with the same root).
   */
  async putExtraRoots(entries: { height: number; root: string }[]): Promise<number> {
    if (entries.length === 0) return 0
    const merged = { ...this.extra }
    let added = 0
    for (const { height, root } of entries) {
      const key = String(height)
      if (merged[key] === root) continue
      merged[key] = root
      added++
    }
    if (added === 0) return 0
    this.extra = merged
    await this.fs.writeText(this.extraPath, JSON.stringify(this.extra))
    return added
  }

  private async writeMeta(): Promise<void> {
    const meta: StoredMeta = {
      chain: this.chain,
      anchorHeight: this.anchor.height,
      anchorHash: this.anchor.hash,
      count: this.headerCount,
      tipHash: this.currentTipHash
    }
    await this.fs.writeText(this.metaPath, JSON.stringify(meta))
  }
}
