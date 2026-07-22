///
/// HybridSecpNative.swift
/// Nitro HybridObject implementation over the UniFFI-generated bindings
/// (ios/uniffi/SecpNative.swift), which call the Rust staticlib inside
/// SecpNative.xcframework (crate: native-secp-poc/src/lib.rs — the frozen,
/// M1-conformance-proven surface; see native-secp-poc/RESULTS.md).
///
/// Bytes-only seam: ArrayBuffer <-> Data at this layer, nothing else.
/// Errors (SecpError) propagate to JS as thrown exceptions; the patched
/// @bsv/sdk seam catches them and falls back to the pure-JS implementation.
///

import Foundation
import NitroModules

// File-scope aliases to the UniFFI-generated global functions. Inside the class,
// unqualified names would collide with the HybridSecpNativeSpec method names, and
// `SecpNative.`-qualified lookup resolves to a type (C++ interop) rather than the
// module — so bind the globals here, where no shadowing exists.
private let ffiEcdsaSign: (Data, Data) throws -> Data = ecdsaSign(msg32:privkey32:)
private let ffiEcdsaVerify: (Data, Data, Data) throws -> Bool = ecdsaVerify(msg32:derSig:pubkey33:)
private let ffiPubkeyCreate: (Data) throws -> Data = pubkeyCreate(privkey32:)
private let ffiPubkeyTweakAdd: (Data, Data) throws -> Data = pubkeyTweakAdd(pubkey33:tweak32:)
private let ffiPrivkeyTweakAdd: (Data, Data) throws -> Data = privkeyTweakAdd(privkey32:tweak32:)
private let ffiEcdhSharedPoint: (Data, Data) throws -> Data = ecdhSharedPoint(privkey32:pubkey33:)
private let ffiBrc42DeriveChild: (Data, Data, String) throws -> Data =
  brc42DeriveChild(privkey32:counterpartyPubkey33:invoiceNumber:)
private let ffiEcdsaRecover: (Data, Data) throws -> Data = ecdsaRecover(msg32:compact65:)
private let ffiEcdsaRecoveryFactor: (Data, Data, Data) throws -> UInt32 =
  ecdsaRecoveryFactor(msg32:sig64:pubkey33:)
private let ffiPubkeyTweakMul: (Data, Data) throws -> Data = pubkeyTweakMul(pubkey33:scalar32:)
private let ffiPubkeyCombine: (Data, Data) throws -> Data =
  pubkeyCombine(pubkey33A:pubkey33B:)
private let ffiSchnorrGenerateProof: (Data, Data, Data, Data, Data) throws -> Data =
  schnorrGenerateProof(a32:aPub33:bPub33:sPoint33:r32:)
private let ffiSchnorrVerifyProof: (Data, Data, Data, Data, Data, Data) throws -> Bool =
  schnorrVerifyProof(aPub33:bPub33:sPoint33:rPoint33:sPrime33:z32:)
// M3 Tier-2 (issues #8/#9): uncompressed outputs + batch flow fns
private let ffiPubkeyCreateUncompressed: (Data) throws -> Data =
  pubkeyCreateUncompressed(privkey32:)
private let ffiEcdhSharedPointUncompressed: (Data, Data) throws -> Data =
  ecdhSharedPointUncompressed(privkey32:pubkey33:)
private let ffiPubkeyTweakAddUncompressed: (Data, Data) throws -> Data =
  pubkeyTweakAddUncompressed(pubkey33:tweak32:)
private let ffiEcdsaRecoverUncompressed: (Data, Data) throws -> Data =
  ecdsaRecoverUncompressed(msg32:compact65:)
private let ffiBrc42DeriveChildPubUncompressed: (Data, Data, String) throws -> Data =
  brc42DeriveChildPubUncompressed(privkey32:pubkey33:invoiceNumber:)
private let ffiBatchEcdsaSign: (Data, Data) throws -> Data =
  batchEcdsaSign(msgs32Cat:privkeys32Cat:)
private let ffiBatchEcdsaVerify: (Data, Data, Data) throws -> Data =
  batchEcdsaVerify(msgs32Cat:sigsFramed:pubkeys33Cat:)
private let ffiBatchBrc42DeriveChild: (Data, Data, [String]) throws -> Data =
  batchBrc42DeriveChild(privkey32:counterpartyPubkey33:invoiceNumbers:)
private let ffiBatchBrc42DeriveChildPubUncompressed: (Data, Data, [String]) throws -> Data =
  batchBrc42DeriveChildPubUncompressed(privkey32:pubkey33:invoiceNumbers:)

class HybridSecpNative: HybridSecpNativeSpec {
  @inline(__always)
  private func asData(_ buf: ArrayBuffer) -> Data {
    // Zero-copy view; the UniFFI layer copies into a RustBuffer immediately,
    // synchronously, so the borrowed memory never outlives the call.
    buf.toData(copyIfNeeded: false)
  }

  @inline(__always)
  private func asBuffer(_ data: Data) throws -> ArrayBuffer {
    try ArrayBuffer.copy(data: data)
  }

  func ecdsaSign(msg32: ArrayBuffer, privkey32: ArrayBuffer) throws -> ArrayBuffer {
    try asBuffer(ffiEcdsaSign(asData(msg32), asData(privkey32)))
  }

  func ecdsaVerify(msg32: ArrayBuffer, derSig: ArrayBuffer, pubkey33: ArrayBuffer) throws -> Bool {
    try ffiEcdsaVerify(asData(msg32), asData(derSig), asData(pubkey33))
  }

  func pubkeyCreate(privkey32: ArrayBuffer) throws -> ArrayBuffer {
    try asBuffer(ffiPubkeyCreate(asData(privkey32)))
  }

  func pubkeyTweakAdd(pubkey33: ArrayBuffer, tweak32: ArrayBuffer) throws -> ArrayBuffer {
    try asBuffer(ffiPubkeyTweakAdd(asData(pubkey33), asData(tweak32)))
  }

  func privkeyTweakAdd(privkey32: ArrayBuffer, tweak32: ArrayBuffer) throws -> ArrayBuffer {
    try asBuffer(ffiPrivkeyTweakAdd(asData(privkey32), asData(tweak32)))
  }

  func ecdhSharedPoint(privkey32: ArrayBuffer, pubkey33: ArrayBuffer) throws -> ArrayBuffer {
    try asBuffer(ffiEcdhSharedPoint(asData(privkey32), asData(pubkey33)))
  }

  func brc42DeriveChild(
    privkey32: ArrayBuffer, counterpartyPubkey33: ArrayBuffer, invoiceNumber: String
  ) throws -> ArrayBuffer {
    try asBuffer(
      ffiBrc42DeriveChild(asData(privkey32), asData(counterpartyPubkey33), invoiceNumber))
  }

  // ── M2 Tier-1 extension (issues #5/#6) ──────────────────────────────────────

  func ecdsaRecover(msg32: ArrayBuffer, compact65: ArrayBuffer) throws -> ArrayBuffer {
    try asBuffer(ffiEcdsaRecover(asData(msg32), asData(compact65)))
  }

  func ecdsaRecoveryFactor(
    msg32: ArrayBuffer, sig64: ArrayBuffer, pubkey33: ArrayBuffer
  ) throws -> Double {
    Double(try ffiEcdsaRecoveryFactor(asData(msg32), asData(sig64), asData(pubkey33)))
  }

  func pubkeyTweakMul(pubkey33: ArrayBuffer, scalar32: ArrayBuffer) throws -> ArrayBuffer {
    try asBuffer(ffiPubkeyTweakMul(asData(pubkey33), asData(scalar32)))
  }

  func pubkeyCombine(pubkeyA33: ArrayBuffer, pubkeyB33: ArrayBuffer) throws -> ArrayBuffer {
    try asBuffer(ffiPubkeyCombine(asData(pubkeyA33), asData(pubkeyB33)))
  }

  func schnorrGenerateProof(
    a32: ArrayBuffer, aPub33: ArrayBuffer, bPub33: ArrayBuffer, sPoint33: ArrayBuffer,
    r32: ArrayBuffer
  ) throws -> ArrayBuffer {
    try asBuffer(
      ffiSchnorrGenerateProof(asData(a32), asData(aPub33), asData(bPub33), asData(sPoint33), asData(r32)))
  }

  func schnorrVerifyProof(
    aPub33: ArrayBuffer, bPub33: ArrayBuffer, sPoint33: ArrayBuffer, rPoint33: ArrayBuffer,
    sPrime33: ArrayBuffer, z32: ArrayBuffer
  ) throws -> Bool {
    try ffiSchnorrVerifyProof(
      asData(aPub33), asData(bPub33), asData(sPoint33), asData(rPoint33), asData(sPrime33),
      asData(z32))
  }

  // ── M3 Tier-2 (issues #8/#9): uncompressed outputs + async batch flows ──────

  func pubkeyCreateUncompressed(privkey32: ArrayBuffer) throws -> ArrayBuffer {
    try asBuffer(ffiPubkeyCreateUncompressed(asData(privkey32)))
  }

  func ecdhSharedPointUncompressed(privkey32: ArrayBuffer, pubkey33: ArrayBuffer) throws -> ArrayBuffer {
    try asBuffer(ffiEcdhSharedPointUncompressed(asData(privkey32), asData(pubkey33)))
  }

  func pubkeyTweakAddUncompressed(pubkey33: ArrayBuffer, tweak32: ArrayBuffer) throws -> ArrayBuffer {
    try asBuffer(ffiPubkeyTweakAddUncompressed(asData(pubkey33), asData(tweak32)))
  }

  func ecdsaRecoverUncompressed(msg32: ArrayBuffer, compact65: ArrayBuffer) throws -> ArrayBuffer {
    try asBuffer(ffiEcdsaRecoverUncompressed(asData(msg32), asData(compact65)))
  }

  func brc42DeriveChildPubUncompressed(
    privkey32: ArrayBuffer, pubkey33: ArrayBuffer, invoiceNumber: String
  ) throws -> ArrayBuffer {
    try asBuffer(
      ffiBrc42DeriveChildPubUncompressed(asData(privkey32), asData(pubkey33), invoiceNumber))
  }

  // Async batch methods: the input ArrayBuffers are JS-owned and only valid for
  // the duration of the synchronous call, so each is COPIED into an owned Data
  // on the calling (JS) thread BEFORE the work is dispatched to a background
  // DispatchQueue (Promise.parallel). The Rust work + result ArrayBuffer
  // allocation then run entirely off the JS thread; Nitro resolves the JS
  // Promise with the native-owned result buffer.

  func batchEcdsaSign(msgs32Cat: ArrayBuffer, privkeys32Cat: ArrayBuffer) throws -> Promise<ArrayBuffer> {
    let msgs = msgs32Cat.toData(copyIfNeeded: true)
    let keys = privkeys32Cat.toData(copyIfNeeded: true)
    return Promise.parallel {
      try ArrayBuffer.copy(data: ffiBatchEcdsaSign(msgs, keys))
    }
  }

  func batchEcdsaVerify(
    msgs32Cat: ArrayBuffer, sigsFramed: ArrayBuffer, pubkeys33Cat: ArrayBuffer
  ) throws -> Promise<ArrayBuffer> {
    let msgs = msgs32Cat.toData(copyIfNeeded: true)
    let sigs = sigsFramed.toData(copyIfNeeded: true)
    let pubs = pubkeys33Cat.toData(copyIfNeeded: true)
    return Promise.parallel {
      try ArrayBuffer.copy(data: ffiBatchEcdsaVerify(msgs, sigs, pubs))
    }
  }

  func batchBrc42DeriveChild(
    privkey32: ArrayBuffer, counterpartyPubkey33: ArrayBuffer, invoiceNumbers: [String]
  ) throws -> Promise<ArrayBuffer> {
    let priv = privkey32.toData(copyIfNeeded: true)
    let cp = counterpartyPubkey33.toData(copyIfNeeded: true)
    return Promise.parallel {
      try ArrayBuffer.copy(data: ffiBatchBrc42DeriveChild(priv, cp, invoiceNumbers))
    }
  }

  func batchBrc42DeriveChildPubUncompressed(
    privkey32: ArrayBuffer, pubkey33: ArrayBuffer, invoiceNumbers: [String]
  ) throws -> Promise<ArrayBuffer> {
    let priv = privkey32.toData(copyIfNeeded: true)
    let pub = pubkey33.toData(copyIfNeeded: true)
    return Promise.parallel {
      try ArrayBuffer.copy(data: ffiBatchBrc42DeriveChildPubUncompressed(priv, pub, invoiceNumbers))
    }
  }
}
