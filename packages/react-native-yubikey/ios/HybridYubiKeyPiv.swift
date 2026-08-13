import CoreNFC
import Foundation
import YubiKit

/**
 * YubiKeyPiv over Yubico's YubiKit (YKFSmartCardConnection + YKFPIVSession).
 *
 * Mirrors the Android/yubikit-android backend's contract exactly (the JS
 * wrapper is shared): discovery streams key-connected / key-removed events to
 * the JS listener via YubiKit's `YKFManagerDelegate`, and each Promise-
 * returning method opens a `YKFPIVSession` on the connection currently held
 * open, does its one operation, and resolves/rejects.
 *
 * Every rejection carries a `VAULT_ERR:<code>:<detail>` message (see
 * `mapError`) so the JS vault layer can branch on a stable machine code rather
 * than parse YubiKit's own English. Completion handlers are all guarded — a
 * dropped key or a YubiKit error becomes a rejection, never a crash.
 *
 * The primary transport is the USB-C smart-card reader (`YKFSmartCardConnection`,
 * iOS 16+); NFC and MFi accessory are wired best-effort through the same
 * delegate. The active connection is held in `activeConnection` between the
 * delegate's connect and disconnect callbacks (both delivered on the main
 * thread by YubiKit), which is the only mutable discovery state here.
 */
final class HybridYubiKeyPiv: HybridYubiKeyPivSpec {
  /// (eventType, serial, transport) -> Void. Nitro dispatches the call to JS.
  private var listener: ((String, String, String) -> Void)?
  /// The connection for the key currently on a reader. Set on didConnect*,
  /// cleared on didDisconnect*. Every operation runs against this.
  private var activeConnection: (any YKFConnectionProtocol)?

  // MARK: - Capability

  /// The USB-C smart-card APIs this module is built on (YKFSmartCardConnection)
  /// require iOS 16. Below that there is no supported CCID transport for a
  /// hardware key here, so the JS layer treats the device as reader-less and
  /// stays on its software-key path.
  func isSupported() throws -> Bool {
    if #available(iOS 16, *) { return true } else { return false }
  }

  // MARK: - Discovery

  func startDiscovery() throws {
    YubiKitManager.shared.delegate = self
    if #available(iOS 16.0, *) {
      YubiKitManager.shared.startSmartCardConnection()
    }
    // MFi accessory (Lightning) — harmless where unavailable.
    YubiKitManager.shared.startAccessoryConnection()
    // NFC is best-effort: starting a session shows the system NFC sheet, so it
    // is only meaningful when the app actually wants a tap. Guarded so a device
    // without NFC (or a denied session) never throws out of discovery.
    if YubiKitManager.shared.nfcConnection != nil || NFCReaderSession.readingAvailable {
      YubiKitManager.shared.startNFCConnection()
    }
  }

  func stopDiscovery() throws {
    if #available(iOS 16.0, *) {
      YubiKitManager.shared.stopSmartCardConnection()
    }
    YubiKitManager.shared.stopAccessoryConnection()
    YubiKitManager.shared.stopNFCConnection()
    YubiKitManager.shared.delegate = nil
    activeConnection = nil
  }

  func setKeyListener(listener: @escaping (String, String, String) -> Void) throws {
    self.listener = listener
  }

  func clearKeyListener() throws {
    self.listener = nil
  }

  private func emit(_ eventType: String, _ serial: String, _ transport: String) {
    listener?(eventType, serial, transport)
  }

  /// Opens a throwaway session just to read the serial for a connect event.
  private func readSerialAndEmit(_ connection: any YKFConnectionProtocol, _ transport: String) {
    connection.pivSession { [weak self] session, _ in
      guard let self else { return }
      guard let session else { self.emit("connected", "", transport); return }
      session.getSerialNumber { serial, error in
        let serialStr = error == nil ? String(serial) : ""
        self.emit("connected", serialStr, transport)
      }
    }
  }

  // MARK: - Operations

  func getKeyInfo() throws -> Promise<String> {
    let promise = Promise<String>()
    withSession(promise) { session in
      let version = session.version
      session.getPinAttempts { attempts, _ in
        session.getSerialNumber { serial, error in
          if let error { return promise.reject(withError: Self.mapError(error)) }
          let json = "{\"serial\":\"\(serial)\",\"firmwareVersion\":\"\(version.major).\(version.minor).\(version.micro)\",\"pinRetries\":\(attempts)}"
          promise.resolve(withResult: json)
        }
      }
    }
    return promise
  }

  func verifyPin(pin: String) throws -> Promise<String> {
    let promise = Promise<String>()
    withSession(promise) { session in
      session.verifyPin(pin) { retriesLeft, error in
        // A wrong PIN is a normal, resolvable result for this probe (the spec
        // returns {ok, retriesLeft}); only transport faults reject.
        if error != nil {
          promise.resolve(withResult: "{\"ok\":false,\"retriesLeft\":\(retriesLeft)}")
        } else {
          promise.resolve(withResult: "{\"ok\":true,\"retriesLeft\":null}")
        }
      }
    }
    return promise
  }

  func changePin(oldPin: String, newPin: String) throws -> Promise<String> {
    let promise = Promise<String>()
    withSession(promise) { session in
      // Per the module spec, changePin is grouped with generateKey under the
      // management-key gate. (PIV's CHANGE REFERENCE DATA itself only needs the
      // old PIN; the management-key auth is here because the spec asks for it,
      // and it is what surfaces mgmt-key-custom on a personalised key.)
      self.authenticateManagementKey(session, promise) {
        session.setPin(newPin, oldPin: oldPin) { error in
          if let error { return promise.reject(withError: Self.mapError(error)) }
          promise.resolve(withResult: "{\"ok\":true}")
        }
      }
    }
    return promise
  }

  func generateVaultKey(slot: Double, touchPolicy: String, pinPolicy: String) throws -> Promise<String> {
    let promise = Promise<String>()
    guard let pivSlot = YKFPIVSlot(rawValue: UInt(slot)) else {
      promise.reject(withError: Self.vaultError("no-key", "bad slot"))
      return promise
    }
    withSession(promise) { session in
      self.authenticateManagementKey(session, promise) {
        session.generateKey(
          inSlot: pivSlot,
          type: .ECCP256,
          pinPolicy: Self.toPinPolicy(pinPolicy),
          touchPolicy: Self.toTouchPolicy(touchPolicy)
        ) { publicKey, error in
          if let error { return promise.reject(withError: Self.mapError(error)) }
          guard let publicKey, let hex = Self.secKeyToSec1Hex(publicKey) else {
            return promise.reject(withError: Self.vaultError("wrong-key", "could not export public key"))
          }
          promise.resolve(withResult: "{\"publicKey\":\"\(hex)\"}")
        }
      }
    }
    return promise
  }

  func readVaultPublicKey(slot: Double) throws -> Promise<String> {
    let promise = Promise<String>()
    guard let pivSlot = YKFPIVSlot(rawValue: UInt(slot)) else {
      promise.reject(withError: Self.vaultError("no-key", "bad slot"))
      return promise
    }
    withSession(promise) { session in
      session.getSlotMetadata(pivSlot) { metadata, error in
        // Empty slot (metadata read fails) is not an error here — null pubkey.
        guard error == nil, let metadata, let hex = Self.secKeyToSec1Hex(metadata.publicKey) else {
          return promise.resolve(withResult: "{\"publicKey\":null}")
        }
        promise.resolve(withResult: "{\"publicKey\":\"\(hex)\"}")
      }
    }
    return promise
  }

  func ecdh(slot: Double, pin: String, peerPublicKey: String) throws -> Promise<String> {
    let promise = Promise<String>()
    guard let pivSlot = YKFPIVSlot(rawValue: UInt(slot)) else {
      promise.reject(withError: Self.vaultError("no-key", "bad slot"))
      return promise
    }
    guard let peerKey = Self.sec1HexToSecKey(peerPublicKey) else {
      promise.reject(withError: Self.vaultError("wrong-key", "bad peer public key"))
      return promise
    }
    withSession(promise) { session in
      // pin-policy ONCE gate: verify before the touch-gated agreement.
      session.verifyPin(pin) { _, error in
        if let error { return promise.reject(withError: Self.mapError(error)) }
        // TOUCH-gated when the key was generated with TouchPolicy.ALWAYS: this
        // waits for the user to tap the key, and surfaces as touch-timeout if
        // they never do (see mapError).
        session.calculateSecretKey(inSlot: pivSlot, peerPublicKey: peerKey) { secret, error in
          if let error { return promise.reject(withError: Self.mapError(error)) }
          guard let secret else {
            return promise.reject(withError: Self.vaultError("touch-timeout", "no shared secret returned"))
          }
          promise.resolve(withResult: "{\"secret\":\"\(secret.hexString)\"}")
        }
      }
    }
    return promise
  }

  // MARK: - Helpers

  /// Opens a `YKFPIVSession` on the held connection and hands it to `work`;
  /// rejects with no-key when nothing is on a reader, or maps a session-open
  /// error. `work` owns resolving/rejecting `promise` from there.
  private func withSession(_ promise: Promise<String>, _ work: @escaping (YKFPIVSession) -> Void) {
    guard let connection = activeConnection else {
      promise.reject(withError: Self.vaultError("no-key", "no YubiKey present"))
      return
    }
    connection.pivSession { session, error in
      if let error { return promise.reject(withError: Self.mapError(error)) }
      guard let session else {
        return promise.reject(withError: Self.vaultError("no-key", "could not open PIV session"))
      }
      work(session)
    }
  }

  /// Authenticate with the firmware-default management key so generateKey (and,
  /// per spec, changePin) can proceed, then run `next`. Pre-5.7 keys default to
  /// TDES, fw >= 5.7 to AES-192; both ship the same 24-byte default value. A
  /// failure means a custom management key we cannot supply → mgmt-key-custom.
  private func authenticateManagementKey(
    _ session: YKFPIVSession,
    _ promise: Promise<String>,
    _ next: @escaping () -> Void
  ) {
    let version = session.version
    let fw57 = version.major > 5 || (version.major == 5 && version.minor >= 7)
    let type: YKFPIVManagementKeyType = fw57 ? .aes192 : .tripleDES
    session.authenticate(withManagementKey: Self.defaultManagementKey, type: type) { error in
      if error != nil {
        return promise.reject(withError: Self.vaultError("mgmt-key-custom", "default management key rejected"))
      }
      next()
    }
  }

  private static func toTouchPolicy(_ p: String) -> YKFPIVTouchPolicy {
    switch p.lowercased() {
    case "always": return .always
    case "cached": return .cached
    case "never": return .never
    default: return .default
    }
  }

  private static func toPinPolicy(_ p: String) -> YKFPIVPinPolicy {
    switch p.lowercased() {
    case "once": return .once
    case "always": return .always
    case "never": return .never
    default: return .default
    }
  }

  private static func vaultError(_ code: String, _ detail: String) -> NSError {
    NSError(domain: "YubiKeyPiv", code: 1,
            userInfo: [NSLocalizedDescriptionKey: "VAULT_ERR:\(code):\(detail)"])
  }

  /// Best-effort translation of a YubiKit error to a VAULT_ERR code.
  ///
  /// NOTE: YubiKit surfaces smart-card faults as NSErrors whose `code` is often
  /// the raw APDU status word; the exact domains/codes are version-sensitive
  /// and should be re-checked on-device. Anything unrecognised falls through to
  /// wrong-key so a failure is never silently swallowed.
  private static func mapError(_ error: Error) -> NSError {
    let ns = error as NSError
    // Already one of ours (e.g. nested through withSession) — pass through.
    if ns.domain == "YubiKeyPiv" { return ns }
    switch ns.code {
    case 0x6983: return vaultError("pin-locked", "authentication method blocked")
    case 0x63C0...0x63CF: // 0x63Cx = PIN verify failed, x = retries left
      return vaultError("pin-invalid", "retries=\(ns.code & 0x0F)")
    case 0x6A88, 0x6A80: return vaultError("no-key", "reference data not found")
    case 0x6982, 0x6985: return vaultError("touch-timeout", "conditions of use not satisfied")
    default:
      let desc = ns.localizedDescription.lowercased()
      if desc.contains("touch") || desc.contains("timeout") {
        return vaultError("touch-timeout", ns.localizedDescription)
      }
      if desc.contains("no connection") || desc.contains("disconnect") || desc.contains("removed") {
        return vaultError("key-removed-mid-op", ns.localizedDescription)
      }
      return vaultError("wrong-key", ns.localizedDescription)
    }
  }

  /// EC public `SecKey` -> SEC1 uncompressed hex (0x04 || X || Y). Security's
  /// external representation for an EC public key IS ANSI X9.63 uncompressed,
  /// so this is a straight export + hex encode.
  private static func secKeyToSec1Hex(_ key: SecKey) -> String? {
    var error: Unmanaged<CFError>?
    guard let data = SecKeyCopyExternalRepresentation(key, &error) as Data? else { return nil }
    return data.hexString
  }

  /// SEC1 uncompressed hex (0x04 || X || Y) -> EC public `SecKey`.
  private static func sec1HexToSecKey(_ hex: String) -> SecKey? {
    guard let data = Data(hexString: hex) else { return nil }
    let attrs: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeyClass as String: kSecAttrKeyClassPublic,
      kSecAttrKeySizeInBits as String: 256
    ]
    var error: Unmanaged<CFError>?
    return SecKeyCreateWithData(data as CFData, attrs as CFDictionary, &error)
  }

  /// Firmware-default PIV management key (0x0102…08 ×3, 24 bytes).
  private static let defaultManagementKey = Data([
    0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
    0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
    0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08
  ])
}

// MARK: - Discovery delegate

extension HybridYubiKeyPiv: YKFManagerDelegate {
  func didConnectNFC(_ connection: YKFNFCConnection) {
    activeConnection = connection
    readSerialAndEmit(connection, "nfc")
  }

  func didDisconnectNFC(_ connection: YKFNFCConnection, error: Error?) {
    if activeConnection === connection { activeConnection = nil }
    emit("removed", "", "nfc")
  }

  func didConnectAccessory(_ connection: YKFAccessoryConnection) {
    activeConnection = connection
    readSerialAndEmit(connection, "usb")
  }

  func didDisconnectAccessory(_ connection: YKFAccessoryConnection, error: Error?) {
    if activeConnection === connection { activeConnection = nil }
    emit("removed", "", "usb")
  }

  @available(iOS 16.0, *)
  func didConnectSmartCard(_ connection: YKFSmartCardConnection) {
    activeConnection = connection
    readSerialAndEmit(connection, "usb")
  }

  @available(iOS 16.0, *)
  func didDisconnectSmartCard(_ connection: YKFSmartCardConnection, error: Error?) {
    if activeConnection === connection { activeConnection = nil }
    emit("removed", "", "usb")
  }
}

// MARK: - hex

private extension Data {
  var hexString: String { map { String(format: "%02x", $0) }.joined() }

  init?(hexString: String) {
    var hex = hexString
    if hex.hasPrefix("0x") || hex.hasPrefix("0X") { hex = String(hex.dropFirst(2)) }
    guard hex.count % 2 == 0 else { return nil }
    var out = Data(capacity: hex.count / 2)
    var idx = hex.startIndex
    while idx < hex.endIndex {
      let next = hex.index(idx, offsetBy: 2)
      guard let byte = UInt8(hex[idx..<next], radix: 16) else { return nil }
      out.append(byte)
      idx = next
    }
    self = out
  }
}
