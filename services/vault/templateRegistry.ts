/**
 * Every R1-K1 template version this build can reconstruct.
 *
 * WHY THIS EXISTS. Before it, the codec knew exactly one version: a single
 * `TEMPLATE_VERSION` constant, one vendored artifact, and a `referenceBytesFor`
 * that refused every other version. That is fine while nothing is stored — and
 * catastrophic the moment something is. The first change to the vendored asset
 * would make every compressed record written by yesterday's binary permanently
 * unexpandable: in `proven_tx_reqs`, in `transactions`, in `proven_txs`, and in
 * every backup chunk already on the server, all at once. "No migration needed"
 * would have quietly become "migration impossible", with the current build's own
 * data as the victim.
 *
 * So this table is APPEND-ONLY. Compression always uses the newest entry;
 * expansion must keep working for every entry that has ever shipped, forever.
 * Removing or editing a historical entry orphans stored data, which is why
 * __tests__/vault/templateRegistry.test.ts pins a fingerprint over the whole
 * table: a mutation fails there rather than in someone's wallet.
 *
 * ADDING A VERSION. Mint a new number, vendor the new artifact alongside the old
 * one (do not replace it), append an entry, and update the pinned fingerprint in
 * the test in the same commit. Never renumber, never delete.
 */
import { VAULT_TEMPLATE_GZIP_BASE64, VAULT_TEMPLATE_RAW_LENGTH } from './vaultTemplateArtifact'

export interface TemplateRegistryEntry {
  /** Wire-format version, as written into a compressed record's header. */
  version: number
  /** Base64 gzip of the region-0x01 reference template. */
  gzipBase64: string
  /** Inflated length of that reference, asserted at load. */
  rawLength: number
  /**
   * Bytes `R1K1Wallet.unlockR1` drops from the FRONT of the locking script
   * before committing the remainder as the preimage's scriptCode. The one
   * load-bearing constant region 0x02 is derived from — its length, its variable
   * run and its constant hash all recompute from this.
   */
  preimageScriptCodeOffset: number
  /** Region-0x01 variable runs: the R1 commitment and the k1PublicKeyHash. */
  variableRuns: readonly { readonly offset: number; readonly length: number }[]
  /** SHA-256 of the reference with its variable runs masked to zero. */
  constantHash: string
  /** The same, for the region-0x02 slice. */
  constantHashScriptCode: string
}

/**
 * Version 2.
 *
 * The pinned hashes were computed from a real per-instance sample built by
 * `@bsv/templates` with its genuinely-random variable runs masked out, BEFORE
 * the template was vendored — which is what makes verifying against them a
 * cross-check rather than a tautology. Changing either literal is a deliberate
 * act that accompanies minting a new version, never a "make the assertion pass
 * again" edit.
 *
 * (There is no version 1 entry. The v1 header shape carried no integrity check
 * over its payload and no record of it was ever written outside a test.)
 */
const V2: TemplateRegistryEntry = {
  version: 2,
  gzipBase64: VAULT_TEMPLATE_GZIP_BASE64,
  rawLength: VAULT_TEMPLATE_RAW_LENGTH,
  preimageScriptCodeOffset: 60,
  variableRuns: [
    { offset: 17, length: 20 },
    { offset: 959609, length: 20 }
  ],
  constantHash: '41f6fcbbc46fe0eeb64a176fd66709694331b2327b1a63086105529e34a7493b',
  constantHashScriptCode: 'f759656aadfcdbd531531c9806b8bce89f7ed4363c7d3f07578455fb1b96a990'
}

/** Append-only. Oldest first. */
export const TEMPLATE_REGISTRY: readonly TemplateRegistryEntry[] = [V2]

/** The version new records are written with: always the newest registered. */
export const CURRENT_TEMPLATE_VERSION: number = TEMPLATE_REGISTRY.reduce(
  (newest, e) => (e.version > newest ? e.version : newest),
  0
)

export function entryForVersion(version: number): TemplateRegistryEntry | undefined {
  return TEMPLATE_REGISTRY.find(e => e.version === version)
}

export function currentEntry(): TemplateRegistryEntry {
  const entry = entryForVersion(CURRENT_TEMPLATE_VERSION)
  if (!entry) throw new Error('template registry is empty')
  return entry
}

/**
 * A stable fingerprint of the whole table, excluding the artifact bytes
 * themselves (those have their own per-entry `constantHash`).
 *
 * Pinned by a test so an entry cannot be silently removed, renumbered or
 * edited — the three ways this table could orphan stored records.
 */
export function registryFingerprint(): string {
  return TEMPLATE_REGISTRY.map(
    e =>
      [
        e.version,
        e.rawLength,
        e.preimageScriptCodeOffset,
        e.variableRuns.map(r => `${r.offset}:${r.length}`).join(','),
        e.constantHash,
        e.constantHashScriptCode
      ].join('|')
  ).join(';')
}
