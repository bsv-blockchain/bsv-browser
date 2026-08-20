/**
 * The expansion boundary: where compressed-at-rest bytes become real bytes.
 *
 * Two independent encodings can appear in a blob column, and they mean different
 * things:
 *
 *   0xfe — a TRANSACTION envelope (services/vault/txEnvelope.ts). Substituted
 *          R1-K1 script spans plus a literal remainder, carrying the real txid so
 *          expansion self-verifies.
 *   0xff — a compressed SCRIPT (services/vault/templateCodec.ts). One template
 *          instance, carrying its own checksum.
 *
 * Neither can begin a legitimate value of the column it sits in: a rawTx starts
 * with a version field (`01|02 00 00 00`), a BEEF with `01|02 00 be ef`, and a
 * real R1-K1 locking script with `76 00 9c`. That is what makes sniffing the
 * first byte safe HERE — and it is also why the two markers must never be
 * conflated, since they route to different reconstructors.
 *
 * WHY THIS IS A MODULE AND NOT INLINE CODE. The spec requires that "no
 * unexpanded bytes reach a consumer that needs full bytes" be provable by
 * inspecting a short list. Keeping every decision in one place makes the list
 * short, makes it testable without a device, and means a future read path that
 * forgets to expand is a missing call to a named function rather than a missing
 * `if`.
 *
 * FAILURE IS LOUD, DELIBERATELY. A blob that carries a marker but cannot be
 * reconstructed is not passed through: passing it through is exactly how wrong
 * bytes reach a hasher or a broadcaster. The one exception is documented on
 * `expandStoredScript`, where a page-supplied value can legitimately be
 * unreconstructable and erroring the whole query would be worse.
 */
import { expandScriptBytes, isCompressed } from '@/services/vault/templateCodec'
import {
  compressContainer,
  compressTransaction,
  expandTransaction,
  isEnvelope,
  readEnvelopeRange
} from '@/services/vault/txEnvelope'

const asBytes = (b: number[] | Uint8Array): Uint8Array => (b instanceof Uint8Array ? b : Uint8Array.from(b))

/**
 * Expand a stored transaction blob (`rawTx`, `inputBEEF`, `beef`).
 *
 * Self-verifying via the envelope's recorded txid. Anything that is not an
 * envelope is returned unchanged, so this is safe to call unconditionally on
 * every read — which is the point: an unconditional call cannot be forgotten in
 * one branch.
 */
export async function expandStoredTx<T extends number[] | Uint8Array | undefined>(bytes: T): Promise<T> {
  if (!bytes || bytes.length === 0) return bytes
  if (!isEnvelope(bytes)) return bytes
  const expanded = await expandTransaction(asBytes(bytes))
  // Preserve the caller's shape: inputBEEF is typed as a Uint8Array-backed BEEF
  // in places and number[] in others, and silently changing one for the other
  // would break a consumer in a way types would not catch at every seam.
  return (bytes instanceof Uint8Array ? expanded : Array.from(expanded)) as T
}

/**
 * Expand a byte range of a stored transaction without materialising the whole
 * thing.
 *
 * This is the path that would otherwise evict funds silently.
 * `outputs.scriptOffset`/`scriptLength` are absolute offsets into the
 * UNCOMPRESSED rawTx; slicing an envelope at them returns plausible-looking
 * wrong bytes with no error, `Services.hashOutputScript` hashes those, the chain
 * answers "not a UTXO", and three separate writers persist `spendable = false`.
 * So a range read over an envelope must be served from its span list, never by
 * slicing the stored bytes.
 */
export async function expandStoredRange(
  bytes: number[] | undefined,
  offset: number,
  length: number
): Promise<number[] | undefined> {
  if (!bytes || bytes.length === 0) return bytes
  if (!isEnvelope(bytes)) return bytes.slice(offset, offset + length)
  return Array.from(await readEnvelopeRange(asBytes(bytes), offset, length))
}

/**
 * Expand a stored script blob (`outputs.lockingScript`, `commissions.lockingScript`).
 *
 * Returns the bytes unchanged when reconstruction fails, and this is the one
 * place that swallows rather than throws. The reason is provenance: a script
 * column can hold bytes a PAGE supplied — `internalizeAction` writes attacker-
 * chosen output scripts with no `scriptLength`/`scriptOffset` fallback — so a
 * marker-led value there may be a forgery rather than something this wallet
 * wrote. Throwing would let one such row take down `listOutputs`, the vault
 * screen and the backup sweep for the whole wallet, since `findOutputs` maps
 * over its results with no per-row catch. Degrading to "one odd-looking output"
 * is strictly better than that, and the value is never used as a script without
 * being checked against `scriptLength` downstream.
 *
 * Transaction blobs get the opposite treatment (`expandStoredTx` throws),
 * because those are only ever written by this wallet and a failure there means
 * real corruption.
 */
export async function expandStoredScript(bytes: number[] | undefined): Promise<number[] | undefined> {
  if (!bytes || bytes.length === 0) return bytes
  if (!isCompressed(bytes)) return bytes
  try {
    return Array.from(await expandScriptBytes(asBytes(bytes)))
  } catch (e) {
    console.warn(
      `[storage] a stored script carries the compressed-script marker but could not be expanded: ${
        (e as Error)?.message ?? 'unknown'
      }`
    )
    return bytes
  }
}

/**
 * Assert that bytes about to leave for somewhere that needs real ones are real.
 *
 * The last line of defence for the invariant, and the reason it is checkable
 * rather than merely intended: a branded type is erased the moment bytes cross
 * into `node_modules`, so a runtime assertion is the only thing that spans that
 * seam. Call it immediately before handing bytes to a broadcaster, a hasher or a
 * parser.
 */
export function assertExpanded(bytes: number[] | Uint8Array | undefined, what: string): void {
  if (!bytes || bytes.length === 0) return
  const first = bytes instanceof Uint8Array ? bytes[0] : bytes[0]
  if (first === 0xfe || first === 0xff) {
    throw new Error(
      `${what} still carries a compressed-at-rest marker (0x${first.toString(16)}) at the point where real ` +
        'bytes are required — a read path is missing its expansion hook'
    )
  }
}

/**
 * Compress a stored transaction blob on the way in.
 *
 * Idempotent and total: an envelope is returned as-is, a transaction with no
 * R1-K1 span is returned unchanged, and anything unparseable is returned
 * unchanged — so this is safe to call on every write, which is what keeps a
 * future write path from being a missing `if`.
 *
 * Idempotence is load-bearing rather than tidy: `processSyncChunk` feeds bytes
 * from a backup restore straight back through the insert methods, and those bytes
 * are in STORED form because getSyncChunk deliberately emits stored form. Without
 * the envelope guard, a restore would wrap an envelope in an envelope.
 *
 * @param txid the transaction's own txid. Required, because expansion verifies
 *   the reconstruction by hashing it and comparing — a blob with no single txid
 *   (a BEEF container) must not be routed here.
 */
export async function compressStoredTx<T extends number[] | Uint8Array | undefined>(
  bytes: T,
  txid: string | undefined
): Promise<T> {
  if (!bytes || bytes.length === 0) return bytes
  if (isEnvelope(bytes)) return bytes
  if (!txid || !/^[0-9a-fA-F]{64}$/.test(txid)) return bytes
  try {
    const compressed = await compressTransaction(asBytes(bytes), txid)
    if (compressed.length >= bytes.length) return bytes
    return (bytes instanceof Uint8Array ? compressed : Array.from(compressed)) as T
  } catch (e) {
    // Never fail a write because compression could not help. The uncompressed
    // bytes are always correct; the envelope is only ever an optimisation.
    console.warn(`[storage] could not compress rawTx for ${txid}: ${(e as Error)?.message ?? 'unknown'}`)
    return bytes
  }
}

/**
 * Whether `proven_txs.rawTx` may be stored compressed.
 *
 * OFF, and it must stay off until a device has run a full deposit -> withdrawal
 * -> proof cycle with the other columns compressed. That row is not like the
 * others: it IS the merkle evidence for a mined transaction, and
 * `Beef.verifyBumpIndexLeaves` binds `hash256(rawTx)` to a chain-committed BUMP
 * leaf inside @bsv/sdk, where no subclass can intercept it. A bug in the other
 * columns is recoverable by rewriting them from the network; a bug here makes
 * every later spend of that transaction's outputs fail `beef.verify()` with
 * nothing local able to repair it.
 *
 * Expansion (E6) is already unconditional, so flipping this on is a one-line,
 * reversible change once the evidence exists — and rows written while it was on
 * stay readable if it is turned back off.
 */
export const COMPRESS_PROVEN_TX_RAWTX = false

/**
 * Compress a stored BEEF container (`inputBEEF`, `beef`) on the way in.
 *
 * Separate from compressStoredTx because a container holds several transactions
 * and has no single txid: its envelope commits to a SHA-256 of the blob instead.
 * Routing one through the transaction path would produce an envelope whose
 * integrity check verified nothing.
 *
 * This is the column that matters for a WITHDRAWAL: inputBEEF carries ~1.83 MB
 * per vault input, several times the rawTx it accompanies, so a withdrawal's
 * backup chunk stays over the server's 1 MiB cap until this is compressed.
 *
 * Idempotent and total, for the same reasons as compressStoredTx.
 */
export async function compressStoredBeef<T extends number[] | Uint8Array | undefined>(bytes: T): Promise<T> {
  if (!bytes || bytes.length === 0) return bytes
  if (isEnvelope(bytes)) return bytes
  try {
    const compressed = await compressContainer(asBytes(bytes))
    if (compressed.length >= bytes.length) return bytes
    return (bytes instanceof Uint8Array ? compressed : Array.from(compressed)) as T
  } catch (e) {
    console.warn(`[storage] could not compress a BEEF blob: ${(e as Error)?.message ?? 'unknown'}`)
    return bytes
  }
}
