import CoreBluetooth
import CryptoKit
import Foundation

/// The `bsvpay-ble/1` GATT profile: constants, key derivation, message
/// construction and stream framing shared by the peripheral (payee) and
/// central (payer) roles in HybridLocalPayBleTransport.swift.
///
/// This file is the byte-exact reference for the Kotlin `object BleGattProfile`
/// (android/src/main/java/com/margelo/nitro/localpaytransport/BleGattProfile.kt)
/// and for any third-party build that wants to interoperate on the CAP_BLE
/// session bit. Change both platforms or neither.
///
/// Security model (design spec §3): bare GATT has no link security and
/// cross-platform bonding prompts are a UX dead end, so the link is
/// authenticated at the message layer. HELLO_A/HELLO_B prove each side holds
/// the QR's PSK before any payload moves; the FRAME body is AES-256-GCM
/// sealed by JS under the same PSK; the ACK carries an HMAC so an attacker who
/// sniffed the advertisement and re-advertised the same UUID cannot forge a
/// `{"ok":true}` to a payer whose real payee queued nothing.
enum BleGattProfile {
  // MARK: - Fixed identifiers

  /// central → peripheral. Properties: write, writeWithoutResponse.
  static let frameCharUuid = CBUUID(string: "B5A1E001-7374-4F6E-8E2D-425356504159")
  /// peripheral → central. Properties: indicate.
  static let ackCharUuid = CBUUID(string: "B5A1E002-7374-4F6E-8E2D-425356504159")
  /// Advisory only; iOS may drop it from the advertisement to fit 31 bytes.
  static let localName = "BSV Pay"
  private static let serviceUuidLabel = Data("bsvpay-ble-svc".utf8)

  // MARK: - Message types (first byte of every message)

  static let typeHelloA: UInt8 = 0x01
  static let typeHelloB: UInt8 = 0x02
  static let typeFrame: UInt8 = 0x03
  static let typeAck: UInt8 = 0x04

  // MARK: - Limits and timers (identical on Android)

  /// `type ‖ body` of one message must be <= this. Same ceiling as the Nearby
  /// backend's MAX_BYTES_PAYLOAD; the payer rejects a larger sealed frame so JS
  /// falls back to the fountain, which has no ceiling below 64 KiB.
  static let maxBleFrameBytes = 32768
  /// Hard cap on a reassembly buffer: one maximal message plus its prefix.
  static let maxReassemblyBytes = maxBleFrameBytes + 4
  static let idleConnectionTimeoutMs = 30_000
  static let pendingAckTimeoutMs = 60_000
  /// Android only (iOS negotiates MTU in the OS); kept here so the two
  /// platforms' constant tables read identically.
  static let mtuNegotiationTimeoutMs = 2_000
  static let requestedMtu = 517
  static let defaultAttMtu = 23
  static let macLength = 32
  /**
   * Hard ceiling on a single GATT chunk, independent of the negotiated ATT MTU.
   * Discovered 2026-09-03 on the reversed-role hardware run: Android's native
   * Bluetooth stack rejects `notifyCharacteristicChanged`/indication payloads
   * over 512 bytes regardless of MTU. CoreBluetooth's own indication path
   * (`CBCentral.maximumUpdateValueLength`) doesn't carry this specific bug, but
   * a payer peer on the other end of an indication (or a future iOS↔iOS pairing
   * on a stack revision that does) might — applied defensively on iOS's
   * indication paths too, on top of the `.withResponse` cap the write path
   * already self-imposes via `writeChunkSize`.
   */
  static let maxChunkBytes = 512

  // MARK: - Errors

  static let errorDomain = "LocalPayBleTransport"

  static func error(_ message: String, code: Int) -> NSError {
    NSError(domain: errorDomain, code: code, userInfo: [NSLocalizedDescriptionKey: message])
  }

  // MARK: - Key derivation and proofs

  private static func hmac(key: Data, message: Data) -> Data {
    Data(HMAC<SHA256>.authenticationCode(for: message, using: SymmetricKey(data: key)))
  }

  /// Per-session service UUID: HMAC-SHA256(psk, "bsvpay-ble-svc" ‖ utf8(instanceName))[0..<16]
  /// with the RFC-4122 version nibble forced to 4 and the variant bits to 10.
  /// Only a device that read the QR (and therefore holds the PSK) can compute
  /// it, so the payer's scan filter matches exactly one advertiser and a
  /// sniffed advertisement reveals nothing about the QR.
  static func serviceUuid(psk: Data, instanceName: String) -> CBUUID {
    var message = serviceUuidLabel
    message.append(Data(instanceName.utf8))
    var bytes = [UInt8](hmac(key: psk, message: message).prefix(16))
    bytes[6] = (bytes[6] & 0x0F) | 0x40
    bytes[8] = (bytes[8] & 0x3F) | 0x80
    let uuid = UUID(uuid: (
      bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
      bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
    ))
    return CBUUID(nsuuid: uuid)
  }

  /// HMAC-SHA256(psk, utf8(instanceName) ‖ [type]) — the HELLO_A / HELLO_B body.
  static func proof(psk: Data, instanceName: String, type: UInt8) -> Data {
    var message = Data(instanceName.utf8)
    message.append(type)
    return hmac(key: psk, message: message)
  }

  /// HMAC-SHA256(psk, utf8(instanceName) ‖ [0x04] ‖ ackJson) — appended to the ACK.
  static func ackMac(psk: Data, instanceName: String, ackJson: Data) -> Data {
    var message = Data(instanceName.utf8)
    message.append(typeAck)
    message.append(ackJson)
    return hmac(key: psk, message: message)
  }

  /// Constant-time equality: no early exit on the first differing byte, so a
  /// remote peer cannot learn how many leading bytes of its forged proof were
  /// right from the response latency.
  static func constantTimeEquals(_ a: Data, _ b: Data) -> Bool {
    guard a.count == b.count else { return false }
    var acc: UInt8 = 0
    for (x, y) in zip(a, b) { acc |= x ^ y }
    return acc == 0
  }

  // MARK: - Messages

  static func helloA(psk: Data, instanceName: String) -> Data {
    var m = Data([typeHelloA])
    m.append(proof(psk: psk, instanceName: instanceName, type: typeHelloA))
    return m
  }

  static func helloB(psk: Data, instanceName: String) -> Data {
    var m = Data([typeHelloB])
    m.append(proof(psk: psk, instanceName: instanceName, type: typeHelloB))
    return m
  }

  static func frameMessage(sealed: Data) -> Data {
    var m = Data([typeFrame])
    m.append(sealed)
    return m
  }

  static func ackMessage(psk: Data, instanceName: String, ackJson: Data) -> Data {
    var m = Data([typeAck])
    m.append(ackJson)
    m.append(ackMac(psk: psk, instanceName: instanceName, ackJson: ackJson))
    return m
  }

  static let okJson = "{\"ok\":true}"

  /// `{"ok":false,"error":<reason>}` with `reason` correctly escaped. Same
  /// reasoning as `HybridLocalPayTransport.declineJson`: `reason` comes from JS
  /// and is serialized, never interpolated, because an unparseable ack is an
  /// AckError on the payer (inputs stay locked) rather than a clean decline.
  ///
  /// The object is assembled by hand because key ORDER is part of this wire
  /// format: Kotlin's `ackJson` emits `{"ok":false,"error":…}`, and
  /// `JSONSerialization` over a dictionary neither preserves insertion order
  /// nor -- with `.sortedKeys` -- produces this one (`error` would sort before
  /// `ok`). Only the reason's ESCAPING is delegated, by serializing it as a
  /// one-element array and stripping the `[`/`]`, so no hand-rolled escaper
  /// decides how a quote, a backslash or a control character is encoded.
  /// `.withoutEscapingSlashes` matches Kotlin's `jsonString`, which passes `/`
  /// through; with everything else the two agree byte for byte (`"` `\` `\n`
  /// `\r` `\t` `\b` `\f`, `\u00xx` lowercase for the rest of C0, raw UTF-8
  /// above it).
  static func declineJson(reason: String) -> String {
    let fallback = "{\"ok\":false,\"error\":\"declined\"}"
    let text = reason.isEmpty ? "declined" : reason
    guard let data = try? JSONSerialization.data(withJSONObject: [text],
                                                 options: [.withoutEscapingSlashes]),
          let array = String(data: data, encoding: .utf8),
          array.hasPrefix("["), array.hasSuffix("]"), array.count > 2 else {
      return fallback
    }
    return "{\"ok\":false,\"error\":" + String(array.dropFirst().dropLast()) + "}"
  }

  // MARK: - Stream framing

  /// `[u32 big-endian length][message]`. Same encoding as AwdlSession.lengthPrefixed.
  static func lengthPrefixed(_ message: Data) -> Data {
    var out = Data(count: 4)
    let n = UInt32(message.count).bigEndian
    withUnsafeBytes(of: n) { out.replaceSubrange(0..<4, with: $0) }
    out.append(message)
    return out
  }

  /// Split into ATT-sized pieces. `size` is `ATT_MTU - 3`, which CoreBluetooth
  /// exposes as `CBCentral.maximumUpdateValueLength` (indications) and
  /// `CBPeripheral.maximumWriteValueLength(for: .withoutResponse)` (writes).
  /// A chunk that may be written `.withResponse` must additionally respect
  /// `maximumWriteValueLength(for: .withResponse)` (512), or CoreBluetooth may
  /// turn the write into a prepare/execute long write, which the profile does
  /// not use and the Kotlin peripheral refuses -- see
  /// `OutboundSend.writeChunkSize`.
  static func chunks(_ data: Data, size: Int) -> [Data] {
    let n = max(1, size)
    var out: [Data] = []
    var i = 0
    while i < data.count {
      let end = min(i + n, data.count)
      out.append(data.subdata(in: i..<end))
      i = end
    }
    return out
  }

  /// Reassembles `[u32 BE length][message]` records from an ordered stream of
  /// chunks. Writes on one GATT connection and indications on one
  /// characteristic are both ordered and reliable, so no sequence numbers or
  /// checksums are needed (spec §3). Throws once the buffer or a declared
  /// length exceeds the profile ceiling; the caller drops the peer.
  struct Reassembler {
    private var buffer = Data()

    mutating func feed(_ chunk: Data) throws -> [Data] {
      buffer.append(chunk)
      guard buffer.count <= BleGattProfile.maxReassemblyBytes else {
        buffer.removeAll()
        throw BleGattProfile.error("frame too large for a BLE payload", code: 30)
      }
      var messages: [Data] = []
      while buffer.count >= 4 {
        let b = [UInt8](buffer.prefix(4))
        let length = (Int(b[0]) << 24) | (Int(b[1]) << 16) | (Int(b[2]) << 8) | Int(b[3])
        guard length >= 1 else {
          buffer.removeAll()
          throw BleGattProfile.error("bad frame length", code: 31)
        }
        guard length <= BleGattProfile.maxBleFrameBytes else {
          buffer.removeAll()
          throw BleGattProfile.error("frame too large for a BLE payload", code: 30)
        }
        guard buffer.count >= 4 + length else { break }
        messages.append(buffer.subdata(in: 4..<(4 + length)))
        // `Data(...)` re-bases the slice to startIndex 0 so the `prefix(4)` /
        // `subdata(in:)` arithmetic above stays valid on the next pass.
        buffer = Data(buffer.suffix(from: 4 + length))
      }
      return messages
    }
  }
}
