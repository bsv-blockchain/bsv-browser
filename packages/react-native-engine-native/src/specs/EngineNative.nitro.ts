import type { HybridObject } from 'react-native-nitro-modules'

/**
 * Bytes-only seam over the `native-engine-ffi` Rust crate — the M5.1 promotion
 * of the M5.3-PASSED Tier-3 engine spike (docs/TIER3-ENGINE-DESIGN.md §3;
 * 200,000 differential cases vs the app's patched @bsv/sdk@2.1.6, 0
 * mismatches). ECDSA sign core = libsecp256k1 (the ratified #19 decision — the
 * same proven core as react-native-secp-native), sighash midstates computed
 * once per scope-class per tx in Rust.
 *
 * FRAMING CONVENTION (design doc §3 — documented here and in
 * native-engine-ffi/src/lib.rs, nowhere else):
 *   • inputsMeta: N fixed 73-byte records, concatenated —
 *     [u32 LE inputIndex][32B privkey][u64 LE satoshis][u32 LE sigScope]
 *     [25B P2PKH lockingScript].
 *     Outpoints + sequences are read from unsignedTx itself — never duplicated
 *     in meta (single source of truth).
 *   • batchSignP2pkhInputs result: framed per-record, meta order —
 *     [u32 LE inputIndex][u8 len][unlockingScript] where unlockingScript =
 *     push(DER‖scopeByte) push(pubkey33), byte-identical to the SDK P2PKH
 *     template's UnlockingScript for the same input.
 *   • Txids cross in INTERNAL byte order; JS converts at the hex boundary.
 *   • satoshis cross as JS number (SDK is number-bound ≤ 2^53; u64 is
 *     framing-internal on the Rust side).
 *   • Only FORKID, non-CHRONICLE scopes are accepted. ANY invalid element
 *     rejects the whole call (Promise rejection) → the JS seam falls back
 *     per-op to the pure-JS path (the M3 contract).
 */
export interface EngineNative extends HybridObject<{ ios: 'swift' }> {
  /** Probe + proof-artifact stamp: "bsv-rs <hash> / engine-ffi <ver> / sign-core ...". */
  version(): string

  /** Trivial FFI smoke round-trip (issue #19 exit proof): echoes payload unchanged. */
  ping(payload: ArrayBuffer): ArrayBuffer

  /**
   * Batch-sign all P2PKH inputs of one unsigned tx, off the JS thread — ONE
   * crossing for the whole tx. See the framing convention above. Rejects on
   * any invalid record (BadFraming / TxParse / NotP2pkh / UnsupportedScope /
   * IndexOutOfRange / Crypto) → caller falls back to the pure-JS sign path.
   */
  batchSignP2pkhInputs(unsignedTx: ArrayBuffer, inputsMeta: ArrayBuffer): Promise<ArrayBuffer>

  /**
   * Batch-verify all P2PKH inputs of one SIGNED tx, off the JS thread — ONE
   * crossing for the whole tx (the M5.B verify leg; consumes the batchEcdsaVerify
   * debt, caveat A7). Replaces the toolbox `verifyUnlockScripts` per-input fresh
   * `Spend` interpreter + n sync ECDSA crossings.
   *
   * FRAMING:
   *   • prevoutsMeta: N fixed 37-byte records, concatenated —
   *     [u32 LE inputIndex][u64 LE satoshis][25B P2PKH lockingScript].
   *     Every unlocking script, outpoint, sequence and the tx version are read
   *     from signedTx itself — the prevout satoshis + locking script are the only
   *     per-input facts the tx cannot carry.
   *   • result: N verdict bytes in meta order — 0x01 valid, 0x00 invalid. Each
   *     verdict equals the SDK `Spend` interpreter's default-flags CHECKSIG
   *     result (strict DER, low-S iff tx.version<=1, ECDSA accepts any s∈[1,n-1]),
   *     so a byte-for-byte shadow-mode comparison against the JS verdict is exact.
   *   • satoshis cross inside the framing as u64; JS is number-bound ≤ 2^53.
   *
   * Rejects (Promise rejection) on any input that is not the canonical P2PKH
   * template — non-`push(sig‖scope) push(pubkey33)` shape, `hash160(pubkey) !=
   * lock pkh`, non-FORKID / CHRONICLE scope, non-25B lock, or bad framing /
   * index — so the caller runs the full JS `Spend` on the whole tx. Reject-on-
   * any-invalid mirrors batchSignP2pkhInputs; never silently weakens validation.
   */
  batchVerifyP2pkhInputs(signedTx: ArrayBuffer, prevoutsMeta: ArrayBuffer): Promise<ArrayBuffer>

  /**
   * Conformance/debug sighash, off the JS thread — SIGNING order only (32
   * bytes, internal byte order, ready for ECDSA; display order is structurally
   * absent from the engine surface). Never routed in prod.
   *
   * NOTE: the parameter is named `subscriptScript` (not `subscript`) end-to-end
   * — `subscript` is a Swift KEYWORD, and both nitrogen and UniFFI emit it
   * unescaped as a parameter name, producing Swift that does not parse
   * (verified with swiftc; recorded in native-engine-poc/M5.1-RESULTS.md).
   */
  computeSighashSigningOrder(
    rawTx: ArrayBuffer,
    inputIndex: number,
    subscriptScript: ArrayBuffer,
    satoshis: number,
    scope: number
  ): Promise<ArrayBuffer>

  /**
   * M5.9 READ-ONLY BEEF leg (issue #27, design doc §M5.C). Structural BEEF
   * verification, off the JS thread: parse + `verify_valid`, returning the
   * per-block-height merkle roots for the caller's JS
   * `chainTracker.isValidRootForHeight` step. A "BEEF verified" claim is
   * structural + roots + JS-checked headers — this call delivers the first two.
   *
   * FRAMING (result): `[u32 LE count]([u32 LE blockHeight][32B merkleRoot,
   * display order])*`, roots in ASCENDING block height. Uses
   * `allowTxidOnly = false` (the internalizeAction / EF-conversion contract:
   * a fully-hydrated BEEF).
   *
   * Rejects (Promise rejection → JS falls back to the pure-JS BEEF path) on any
   * parse failure OR `verify_valid` = false — the single verdict the SDK's
   * `Beef.isValid(false)` boolean maps to. READ-ONLY: never re-emits BEEF.
   */
  beefVerifyStructure(beef: ArrayBuffer): Promise<ArrayBuffer>

  /**
   * M5.9 READ-ONLY BEEF leg (issue #27, design doc §M5.C). BEEF → Extended
   * Format (BRC-30) off the JS thread, replacing the
   * `services/arcadeBroadcastProvider.ts` serialize→reparse→toEF round-trip.
   * Byte-identical to the SDK's `Transaction.fromBEEF(beef, txid).toEF()`
   * (proven: the M5.9 `beef` fuzz class + the tx-003→tx-004 conformance anchor).
   *
   * `txid`: the subject transaction, INTERNAL byte order (32 bytes) — JS
   * converts at the hex boundary. An EMPTY `txid` selects the subject the SDK's
   * `fromAnyBeef` way: `atomicTxid ?? last tx`.
   *
   * NOTE: bsv-rs `from_beef` does NOT hydrate an input's source transaction
   * from the BEEF; this call hydrates the immediate parents itself (from the
   * BEEF's own txs) so `to_ef` can read each prevout's satoshis + locking
   * script. READ-ONLY: reads BEEF, emits EF; never re-emits BEEF.
   *
   * Rejects on parse failure, unknown/txid-only subject, or missing ancestry
   * that leaves an input without the source output EF requires.
   */
  beefToEf(beef: ArrayBuffer, txid: ArrayBuffer): Promise<ArrayBuffer>
}
