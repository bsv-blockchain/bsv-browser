import type { HybridObject } from 'react-native-nitro-modules'

/**
 * Bytes-only seam over the proven `secp-native` Rust crate
 * (native-secp-poc — rust-secp256k1 / bitcoin-core libsecp256k1).
 *
 * Mirrors the crate functions 1:1 (7 original + the M2 Tier-1 extension:
 * recover/recovery-factor, tweakMul, combine, and the two Schnorr ZK
 * proof-of-shared-secret flow calls — issues #5/#6). All byte parameters are
 * ArrayBuffers; no hex strings ever cross this boundary. Conformance vs
 * @bsv/sdk@2.1.6 is proven byte-exact in native-secp-poc/tests/conformance.rs.
 */
export interface SecpNative extends HybridObject<{ ios: 'swift' }> {
  /** RFC 6979 deterministic ECDSA sign over a 32-byte digest. Returns DER (always low-S). */
  ecdsaSign(msg32: ArrayBuffer, privkey32: ArrayBuffer): ArrayBuffer
  /** Verify DER signature (S normalized first — matches @bsv/sdk verify semantics). */
  ecdsaVerify(msg32: ArrayBuffer, derSig: ArrayBuffer, pubkey33: ArrayBuffer): boolean
  /** Compressed (33-byte) public key for a 32-byte private key. */
  pubkeyCreate(privkey32: ArrayBuffer): ArrayBuffer
  /** P + t·G — compressed in, compressed out. */
  pubkeyTweakAdd(pubkey33: ArrayBuffer, tweak32: ArrayBuffer): ArrayBuffer
  /** (k + t) mod n. */
  privkeyTweakAdd(privkey32: ArrayBuffer, tweak32: ArrayBuffer): ArrayBuffer
  /** ECDH shared POINT, compressed 33 bytes — NOT hashed. */
  ecdhSharedPoint(privkey32: ArrayBuffer, pubkey33: ArrayBuffer): ArrayBuffer
  /** BRC-42 composite: ECDH point → HMAC-SHA256(invoiceNumber) → (k + tweak) mod n. */
  brc42DeriveChild(
    privkey32: ArrayBuffer,
    counterpartyPubkey33: ArrayBuffer,
    invoiceNumber: string
  ): ArrayBuffer
  /**
   * Public-key recovery from a 65-byte SDK compact signature
   * ([compactByte 27..=34, r32, s32] — Signature.toCompact layout). Throws for
   * recid 2/3 with r + n >= p (SDK's Point.fromX mod-p asymmetry) → JS fallback.
   */
  ecdsaRecover(msg32: ArrayBuffer, compact65: ArrayBuffer): ArrayBuffer
  /** Signature.CalculateRecoveryFactor: first recid 0..=3 recovering pubkey33; throws if none. */
  ecdsaRecoveryFactor(msg32: ArrayBuffer, sig64: ArrayBuffer, pubkey33: ArrayBuffer): number
  /** t·P — compressed in/out. t must be in [1, n-1] (throws otherwise). */
  pubkeyTweakMul(pubkey33: ArrayBuffer, scalar32: ArrayBuffer): ArrayBuffer
  /** P + Q — compressed in/out (incl. doubling). Throws on the infinity result. */
  pubkeyCombine(pubkeyA33: ArrayBuffer, pubkeyB33: ArrayBuffer): ArrayBuffer
  /**
   * Schnorr.ts (ZK proof of DH shared secret — NOT BIP-340) generateProof with
   * the nonce r passed in (drawn JS-side from PrivateKey.fromRandom, exactly the
   * SDK's own source). Returns R33 ‖ S'33 ‖ z32 (98 bytes).
   */
  schnorrGenerateProof(
    a32: ArrayBuffer,
    aPub33: ArrayBuffer,
    bPub33: ArrayBuffer,
    sPoint33: ArrayBuffer,
    r32: ArrayBuffer
  ): ArrayBuffer
  /** Schnorr.ts verifyProof. z must be in [1, n-1] (caller guards; throws otherwise). */
  schnorrVerifyProof(
    aPub33: ArrayBuffer,
    bPub33: ArrayBuffer,
    sPoint33: ArrayBuffer,
    rPoint33: ArrayBuffer,
    sPrime33: ArrayBuffer,
    z32: ArrayBuffer
  ): boolean

  // ── M3 Tier-2 (issues #8/#9): uncompressed outputs + async batch flows ──────
  //
  // The *Uncompressed variants return 65-byte 0x04‖x‖y SEC1 points (byte-equal
  // to @bsv/sdk encode(false)) so the JS seam never pays the Point.fromX BigInt
  // modular-sqrt decompression (~450–550µs/point on release Hermes — the M2
  // ranked seam lever). The batch fns are Promise-returning: the work runs on a
  // background DispatchQueue (Nitro async hybrid method), keeping the JS thread
  // free for the whole crossing — the Tier-2 "one crossing, off-thread" flow API.

  /** 65-byte uncompressed public key for a private key. */
  pubkeyCreateUncompressed(privkey32: ArrayBuffer): ArrayBuffer
  /** 65-byte uncompressed ECDH shared POINT (NOT hashed). */
  ecdhSharedPointUncompressed(privkey32: ArrayBuffer, pubkey33: ArrayBuffer): ArrayBuffer
  /** 65-byte uncompressed P + t·G. */
  pubkeyTweakAddUncompressed(pubkey33: ArrayBuffer, tweak32: ArrayBuffer): ArrayBuffer
  /** 65-byte uncompressed recovered public key (same compact65 layout/fallbacks as ecdsaRecover). */
  ecdsaRecoverUncompressed(msg32: ArrayBuffer, compact65: ArrayBuffer): ArrayBuffer
  /** BRC-42 PUBLIC-side deriveChild composite → 65-byte uncompressed child pubkey. */
  brc42DeriveChildPubUncompressed(
    privkey32: ArrayBuffer,
    pubkey33: ArrayBuffer,
    invoiceNumber: string
  ): ArrayBuffer

  /**
   * Batch ECDSA sign, off the JS thread — ONE crossing for a whole transaction.
   * msgs/keys are N×32 concatenations; resolves to per-element
   * [1-byte derLen][DER][33-byte compressed pubkey] (element i ==
   * ecdsaSign(msg_i, key_i) ‖ pubkeyCreate(key_i), fuzz-proven element-wise).
   * Rejects on ANY invalid element → caller falls back to the per-op path.
   */
  batchEcdsaSign(msgs32Cat: ArrayBuffer, privkeys32Cat: ArrayBuffer): Promise<ArrayBuffer>
  /**
   * Batch ECDSA verify, off the JS thread. sigsFramed = per element
   * [1-byte derLen][DER]; resolves to N bytes of 0/1 verdicts (S normalized,
   * same accept-any-s semantics as ecdsaVerify). Rejects on malformed input.
   */
  batchEcdsaVerify(
    msgs32Cat: ArrayBuffer,
    sigsFramed: ArrayBuffer,
    pubkeys33Cat: ArrayBuffer
  ): Promise<ArrayBuffer>
  /**
   * Batch BRC-42 PRIVATE-side deriveChild, off the JS thread — ONE crossing for
   * a whole flow's derivations against one counterparty (ECDH computed once).
   * Resolves to N×32 child private keys, cat.
   */
  batchBrc42DeriveChild(
    privkey32: ArrayBuffer,
    counterpartyPubkey33: ArrayBuffer,
    invoiceNumbers: string[]
  ): Promise<ArrayBuffer>
  /**
   * Batch BRC-42 PUBLIC-side deriveChild, uncompressed, off the JS thread.
   * Resolves to N×65 uncompressed child public keys, cat.
   */
  batchBrc42DeriveChildPubUncompressed(
    privkey32: ArrayBuffer,
    pubkey33: ArrayBuffer,
    invoiceNumbers: string[]
  ): Promise<ArrayBuffer>
}
