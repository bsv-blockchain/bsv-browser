///
/// HybridEngineNative.swift
/// Nitro HybridObject implementation over the UniFFI-generated bindings
/// (ios/uniffi/EngineNative.swift), which call the Rust staticlib inside
/// EngineNative.xcframework (crate: native-engine-ffi/src/lib.rs — the M5.1
/// promotion of the M5.3-proven Tier-3 engine spike; libsecp256k1 sign core
/// per the ratified issue #19 decision).
///
/// Bytes-only seam: ArrayBuffer <-> Data at this layer, nothing else.
/// Errors (EngineError) propagate to JS as thrown exceptions / Promise
/// rejections; the JS seam falls back to the pure-JS path on any of them
/// (the M3 contract — the engine is an accelerator, never a dependency).
///
/// Structure mirrors HybridSecpNative.swift (the proven M2/M3 shape),
/// including its two integration fixes:
///   • UniFFI globals bound as FILE-SCOPE private lets (inside the class,
///     unqualified names collide with the spec method names and
///     `EngineNative.`-qualified lookup resolves to a type under C++ interop);
///   • async batch methods COPY their JS-owned ArrayBuffers into owned Data on
///     the calling (JS) thread BEFORE dispatch (`toData(copyIfNeeded: true)`),
///     then run the Rust work + result allocation on a background queue via
///     `Promise.parallel`.
///

import Foundation
import NitroModules

// File-scope aliases to the UniFFI-generated global functions (see note above).
private let ffiEngineVersion: () -> String = engineVersion
private let ffiEnginePing: (Data) -> Data = enginePing(payload:)
private let ffiBatchSignP2pkhInputs: (Data, Data) throws -> Data =
  batchSignP2pkhInputs(unsignedTx:inputsMeta:)
private let ffiBatchVerifyP2pkhInputs: (Data, Data) throws -> Data =
  batchVerifyP2pkhInputs(signedTx:prevoutsMeta:)
private let ffiComputeSighashSigningOrder: (Data, UInt32, Data, UInt64, UInt32) throws -> Data =
  computeSighashSigningOrder(rawTx:inputIndex:subscriptScript:satoshis:scope:)

class HybridEngineNative: HybridEngineNativeSpec {
  func version() throws -> String {
    ffiEngineVersion()
  }

  func ping(payload: ArrayBuffer) throws -> ArrayBuffer {
    // Zero-copy view is safe here: the UniFFI layer copies into a RustBuffer
    // immediately, synchronously, so the borrowed memory never outlives the call.
    try ArrayBuffer.copy(data: ffiEnginePing(payload.toData(copyIfNeeded: false)))
  }

  func batchSignP2pkhInputs(
    unsignedTx: ArrayBuffer, inputsMeta: ArrayBuffer
  ) throws -> Promise<ArrayBuffer> {
    // JS-owned buffers are only valid for the duration of the synchronous
    // call — copy on the JS thread BEFORE dispatching (the M3 fix).
    let tx = unsignedTx.toData(copyIfNeeded: true)
    let meta = inputsMeta.toData(copyIfNeeded: true)
    return Promise.parallel {
      try ArrayBuffer.copy(data: ffiBatchSignP2pkhInputs(tx, meta))
    }
  }

  func batchVerifyP2pkhInputs(
    signedTx: ArrayBuffer, prevoutsMeta: ArrayBuffer
  ) throws -> Promise<ArrayBuffer> {
    // Same M3 fix: copy the JS-owned buffers on the JS thread BEFORE dispatch.
    let tx = signedTx.toData(copyIfNeeded: true)
    let meta = prevoutsMeta.toData(copyIfNeeded: true)
    return Promise.parallel {
      try ArrayBuffer.copy(data: ffiBatchVerifyP2pkhInputs(tx, meta))
    }
  }

  func computeSighashSigningOrder(
    rawTx: ArrayBuffer, inputIndex: Double, subscriptScript: ArrayBuffer,
    satoshis: Double, scope: Double
  ) throws -> Promise<ArrayBuffer> {
    // Nitro numbers are Doubles; the seam contract is u32/u64 (satoshis ≤ 2^53
    // by SDK construction). Reject non-representable values instead of
    // truncating — the JS seam then falls back to pure JS.
    guard let idx = UInt32(exactly: inputIndex),
          let sats = UInt64(exactly: satoshis),
          let scope32 = UInt32(exactly: scope)
    else {
      throw RuntimeError.error(withMessage: "engine: non-integer inputIndex/satoshis/scope")
    }
    let tx = rawTx.toData(copyIfNeeded: true)
    let sub = subscriptScript.toData(copyIfNeeded: true)
    return Promise.parallel {
      try ArrayBuffer.copy(data: ffiComputeSighashSigningOrder(tx, idx, sub, sats, scope32))
    }
  }
}
