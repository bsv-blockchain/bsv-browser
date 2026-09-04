import CoreBluetooth
import Foundation
import os.log
#if canImport(CoreNFC)
import CoreNFC
#endif

/// One subsystem/category so Console.app can filter the whole rung with
/// `subsystem:org.bsvblockchain.wallet category:LocalPayBle` — the category the
/// Task 1 stub already logged under, and the same tag the Kotlin backend uses
/// for logcat, so every hardware checklist greps for one string.
private let bleLog = OSLog(subsystem: "org.bsvblockchain.wallet", category: "LocalPayBle")

/// LocalPayBleTransport over CoreBluetooth (design spec §2-§3, §7).
///
/// This class is only the Nitro-facing shell. `HybridLocalPayBleTransportSpec_base`
/// is a plain Swift class, not an `NSObject`, and every CoreBluetooth delegate
/// protocol requires `NSObjectProtocol`, so the state machine lives in
/// `BleEngine` below and this type forwards to it one-to-one.
final class HybridLocalPayBleTransport: HybridLocalPayBleTransportSpec {
  private let engine = BleEngine()

  func isSupported() throws -> Bool {
    engine.isSupported()
  }

  func bluetoothState() throws -> String {
    engine.bluetoothState()
  }

  func nfcAvailable() throws -> Bool {
    BleEngine.nfcAvailable()
  }

  func prepare(timeoutMs: Double) throws -> Promise<String> {
    engine.prepare(timeoutMs: timeoutMs)
  }

  func startListening(
    instanceName: String,
    pskBase64: String,
    onFrame: @escaping (String) -> Void,
    onError: @escaping (String) -> Void
  ) throws -> Promise<Void> {
    engine.startListening(instanceName: instanceName, pskBase64: pskBase64, onFrame: onFrame, onError: onError)
  }

  func stopListening() throws -> Promise<Void> {
    engine.stopListening()
  }

  func confirmFrame(accepted: Bool, reason: String) throws -> Promise<Void> {
    engine.confirmFrame(accepted: accepted, reason: reason)
  }

  func sendFrame(
    instanceName: String,
    pskBase64: String,
    frameBase64: String,
    timeoutMs: Double,
    connectTimeoutMs: Double
  ) throws -> Promise<String> {
    engine.sendFrame(
      instanceName: instanceName, pskBase64: pskBase64, frameBase64: frameBase64,
      timeoutMs: timeoutMs, connectTimeoutMs: connectTimeoutMs
    )
  }

  func startScanning(
    instanceName: String,
    pskBase64: String,
    onFrame: @escaping (String) -> Void,
    onError: @escaping (String) -> Void
  ) throws -> Promise<Void> {
    engine.startScanning(instanceName: instanceName, pskBase64: pskBase64, onFrame: onFrame, onError: onError)
  }

  func sendFrameAdvertising(
    instanceName: String,
    pskBase64: String,
    frameBase64: String,
    timeoutMs: Double,
    connectTimeoutMs: Double
  ) throws -> Promise<String> {
    engine.sendFrameAdvertising(
      instanceName: instanceName, pskBase64: pskBase64, frameBase64: frameBase64,
      timeoutMs: timeoutMs, connectTimeoutMs: connectTimeoutMs
    )
  }
}

// MARK: - Peripheral-side bookkeeping

/// Everything the payee holds between `startListening` and the ack. Confined
/// to `BleEngine.queue`.
private final class ListenSession {
  let instanceName: String
  let psk: Data
  let serviceUuid: CBUUID
  let onFrame: (String) -> Void
  let onError: (String) -> Void
  /// Outstanding until `peripheralManagerDidStartAdvertising` (or a failure).
  var startPromise: Promise<Void>?
  var service: CBMutableService?
  var frameChar: CBMutableCharacteristic?
  var ackChar: CBMutableCharacteristic?
  var centrals: [UUID: InboundCentral] = [:]
  /// First-success-wins latch, mirroring `HybridLocalPayTransport.hasAccepted`
  /// and the Kotlin backend's field of the same name: set the instant a FRAME
  /// from a bound central is validated, before `onFrame` and before any ack.
  var hasAccepted = false
  /// The central whose FRAME went to JS and has not been acknowledged. Held
  /// -- deliberately un-acked -- until JS calls `confirmFrame`.
  var pendingAck: InboundCentral?
  /// The scan link whose FRAME went to JS and has not been acknowledged (reversed role). Mutually exclusive with `pendingAck`.
  var scanPendingAck: InboundScan?
  var pendingAckTimeout: DispatchWorkItem?
  /// Set by `confirmFrame` until the last ACK chunk has been queued.
  var ackPromise: Promise<Void>?
  var ackTarget: InboundCentral?
  /// True once the ack is queued: writes are refused and the service goes
  /// away when the payer leaves or the grace period ends.
  var closing = false
  var closeTimeout: DispatchWorkItem?

  init(instanceName: String, psk: Data, serviceUuid: CBUUID,
       onFrame: @escaping (String) -> Void, onError: @escaping (String) -> Void) {
    self.instanceName = instanceName
    self.psk = psk
    self.serviceUuid = serviceUuid
    self.onFrame = onFrame
    self.onError = onError
  }
}

/// One connected central as the peripheral sees it.
private final class InboundCentral {
  enum Stage { case awaitingHello, bound }
  let central: CBCentral
  var stage: Stage = .awaitingHello
  /// Subscribed to the ACK characteristic. Without this HELLO_B/ACK have no
  /// route back, so HELLO_A from an unsubscribed central is refused.
  var subscribed = false
  var reassembler = BleGattProfile.Reassembler()
  var idleReaper: DispatchWorkItem?

  init(central: CBCentral) { self.central = central }
}

/// A queued indication chunk. `completion` fires when CoreBluetooth accepts
/// the chunk into its own transmit queue (`updateValue` returned true).
private struct Indication {
  let central: CBCentral
  let chunk: Data
  let completion: (() -> Void)?
}

private struct PrepareWaiter {
  let promise: Promise<String>
  let timeout: DispatchWorkItem
}

// MARK: - Reversed role: payee as central (spec 2026-09-03 §5)

/// Scan → connect → discover → subscribe → HELLO_A (indication) → HELLO_B
/// (write) → FRAME (indications) → hold → ACK (write with response).
/// Callbacks arrive on `engine.queue`. Owned by `BleEngine.activeScan`; the
/// first-success-wins latch is the ListenSession's, shared with the
/// advertised link.
private final class InboundScan: NSObject, CBPeripheralDelegate {
  private enum Stage { case scanning, connecting, discoveringServices, discoveringCharacteristics, subscribing, awaitingHelloA, writingHelloB, awaitingFrame, holding, writingAck, done }

  private weak var engine: BleEngine?
  private let queue: DispatchQueue
  let instanceName: String
  let psk: Data
  let serviceUuid: CBUUID
  let onFrame: (String) -> Void
  let onError: (String) -> Void

  private var stage: Stage = .scanning
  private(set) var isScanning = false
  private(set) var peripheral: CBPeripheral?
  private var frameChar: CBCharacteristic?
  private var reassembler = BleGattProfile.Reassembler()
  private var writeChunks: [Data] = []
  private var writeCompletion: ((Bool) -> Void)?
  private var idleReaper: DispatchWorkItem?
  private let startedAt = DispatchTime.now()

  init(engine: BleEngine, instanceName: String, psk: Data,
       onFrame: @escaping (String) -> Void, onError: @escaping (String) -> Void) {
    self.engine = engine
    self.queue = engine.queue
    self.instanceName = instanceName
    self.psk = psk
    self.serviceUuid = BleGattProfile.serviceUuid(psk: psk, instanceName: instanceName)
    self.onFrame = onFrame
    self.onError = onError
    super.init()
  }

  private func elapsedMs() -> Int {
    Int((DispatchTime.now().uptimeNanoseconds - startedAt.uptimeNanoseconds) / 1_000_000)
  }

  private static func writeChunkSize(for p: CBPeripheral) -> Int {
    min(p.maximumWriteValueLength(for: .withoutResponse), p.maximumWriteValueLength(for: .withResponse))
  }

  /// Runs on `queue`. Starts scanning if the manager is powered on; otherwise waits for managerStateChanged.
  func start() -> Bool {
    dispatchPrecondition(condition: .onQueue(queue))
    guard let cm = engine?.centralManager else { return false }
    switch cm.state {
    case .poweredOn:
      scan(cm)
      return true
    case .unknown, .resetting:
      return true
    case .unauthorized where CBManager.authorization == .notDetermined:
      return true
    default:
      return false
    }
  }

  private func scan(_ cm: CBCentralManager) {
    guard stage == .scanning, !isScanning else { return }
    isScanning = true
    cm.scanForPeripherals(withServices: [serviceUuid], options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
    os_log("payee(scan): scanning service=%{public}@", log: bleLog, type: .default, serviceUuid.uuidString)
  }

  /// Drop the current peripheral (a stranger, a bad proof, a mid-handshake disconnect) and scan again.
  private func rescan(_ reason: String) {
    dispatchPrecondition(condition: .onQueue(queue))
    os_log("payee(scan): %{public}@; rescanning", log: bleLog, type: .default, reason)
    idleReaper?.cancel(); idleReaper = nil
    isScanning = false
    if let p = peripheral, let cm = engine?.centralManager, p.state != .disconnected { cm.cancelPeripheralConnection(p) }
    peripheral?.delegate = nil
    peripheral = nil; frameChar = nil
    reassembler = BleGattProfile.Reassembler()
    writeChunks = []
    stage = .scanning
    // Capture-then-nil-then-invoke (tearDown's pattern): a stray write completion
    // must not be silently dropped (it may be `writeAck`'s, which settles
    // `confirmFrame`), but `stage` is set to `.scanning` BEFORE it runs so that a
    // reentrant call lands correctly either way -- the HELLO_B closure's own
    // stage guard now no-ops instead of recursing into `rescan`, and if this was
    // `writeAck`'s completion, its nested `tearDown()` call (which sets
    // `stage = .done`) is not clobbered by a `stage = .scanning` running after
    // it, so the trailing `scan(cm)` below correctly declines to resurrect a
    // scan the engine has already disowned.
    let done = writeCompletion; writeCompletion = nil
    done?(false)
    if let cm = engine?.centralManager { scan(cm) }
  }

  /// Full stop: called by the engine when the advertised link won, on stopListening, or after the ack.
  func tearDown() {
    dispatchPrecondition(condition: .onQueue(queue))
    idleReaper?.cancel(); idleReaper = nil
    if let cm = engine?.centralManager {
      if isScanning { cm.stopScan() }
      if let p = peripheral, p.state != .disconnected { cm.cancelPeripheralConnection(p) }
    }
    isScanning = false
    peripheral?.delegate = nil
    peripheral = nil
    stage = .done
    let done = writeCompletion; writeCompletion = nil
    done?(false)
  }

  // MARK: central manager events (forwarded by BleEngine)

  func managerStateChanged(_ state: CBManagerState) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard stage == .scanning, let cm = engine?.centralManager else { return }
    switch state {
    case .poweredOn: scan(cm)
    case .unknown, .resetting: break
    case .unauthorized where CBManager.authorization == .notDetermined: break
    default:
      isScanning = false
      onError("bluetooth unavailable")
    }
  }

  func didDiscover(_ p: CBPeripheral, rssi: NSNumber) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard stage == .scanning, let cm = engine?.centralManager else { return }
    cm.stopScan(); isScanning = false
    stage = .connecting
    peripheral = p
    p.delegate = self
    os_log("payee(scan): scan hit rssi=%d id=%{public}@ ms=%ld", log: bleLog, type: .default, rssi.int32Value, p.identifier.uuidString, elapsedMs())
    let reaper = DispatchWorkItem { [weak self] in
      guard let self, self.stage != .holding, self.stage != .writingAck, self.stage != .done else { return }
      self.rescan("idle central reaper")
    }
    idleReaper = reaper
    queue.asyncAfter(deadline: .now() + .milliseconds(BleGattProfile.idleConnectionTimeoutMs), execute: reaper)
    cm.connect(p, options: nil)
  }

  func didConnect(_ p: CBPeripheral) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard p === peripheral, stage == .connecting else { return }
    stage = .discoveringServices
    os_log("payee(scan): connected id=%{public}@ chunk=%ld ms=%ld", log: bleLog, type: .default, p.identifier.uuidString, Self.writeChunkSize(for: p), elapsedMs())
    p.discoverServices([serviceUuid])
  }

  func didFailToConnect(_ p: CBPeripheral, error: Error?) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard p === peripheral else { return }
    rescan("connect failed: \(error?.localizedDescription ?? "unknown")")
  }

  func didDisconnect(_ p: CBPeripheral, error: Error?) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard p === peripheral else { return }
    switch stage {
    case .holding, .writingAck:
      // The payer left before the ack: release the hold so confirmFrame reports the failure (Swift hardening 2).
      engine?.scanLinkLost(self)
    case .done:
      break
    default:
      rescan("peer disconnected")
    }
  }

  // MARK: CBPeripheralDelegate

  func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard p === peripheral else { return }
    guard stage == .discoveringServices else { return }
    if let error { return rescan(error.localizedDescription) }
    guard let service = p.services?.first(where: { $0.uuid == serviceUuid }) else { return rescan("session service not found on peer") }
    stage = .discoveringCharacteristics
    p.discoverCharacteristics([BleGattProfile.frameCharUuid, BleGattProfile.ackCharUuid], for: service)
  }

  func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard p === peripheral else { return }
    guard stage == .discoveringCharacteristics, service.uuid == serviceUuid else { return }
    if let error { return rescan(error.localizedDescription) }
    let chars = service.characteristics ?? []
    guard let frame = chars.first(where: { $0.uuid == BleGattProfile.frameCharUuid }),
          let ack = chars.first(where: { $0.uuid == BleGattProfile.ackCharUuid }) else {
      return rescan("session characteristics not found on peer")
    }
    frameChar = frame
    stage = .subscribing
    p.setNotifyValue(true, for: ack)
  }

  func peripheral(_ p: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard p === peripheral else { return }
    guard stage == .subscribing, characteristic.uuid == BleGattProfile.ackCharUuid else { return }
    if let error { return rescan(error.localizedDescription) }
    guard characteristic.isNotifying else { return rescan("peer refused the ack subscription") }
    stage = .awaitingHelloA
    os_log("payee(scan): subscribed ms=%ld; awaiting HELLO_A", log: bleLog, type: .default, elapsedMs())
  }

  func peripheral(_ p: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard p === peripheral else { return }
    guard characteristic.uuid == BleGattProfile.ackCharUuid else { return }
    if let error { return rescan(error.localizedDescription) }
    guard let value = characteristic.value, !value.isEmpty else { return }
    let messages: [Data]
    do { messages = try reassembler.feed(value) } catch { return rescan("bad framing from peer") }
    for message in messages { handle(message: message, on: p) }
  }

  private func handle(message: Data, on p: CBPeripheral) {
    guard !message.isEmpty else { return }
    let type = message[message.startIndex]
    let body = Data(message.dropFirst())
    switch (type, stage) {
    case (BleGattProfile.typeHelloA, .awaitingHelloA):
      let expected = BleGattProfile.proof(psk: psk, instanceName: instanceName, type: BleGattProfile.typeHelloA)
      guard BleGattProfile.constantTimeEquals(body, expected) else { return rescan("HELLO_A proof failed") }
      os_log("payee(scan): hello verified ms=%ld", log: bleLog, type: .default, elapsedMs())
      stage = .writingHelloB
      write(BleGattProfile.helloB(psk: psk, instanceName: instanceName), on: p) { [weak self] ok in
        guard let self else { return }
        guard self.stage == .writingHelloB else { return }
        if ok { self.stage = .awaitingFrame } else { self.rescan("HELLO_B write failed") }
      }
    case (BleGattProfile.typeFrame, .awaitingFrame), (BleGattProfile.typeFrame, .writingHelloB):
      guard !body.isEmpty else { return rescan("empty frame") }
      guard let engine, engine.acceptScannedFrame(self) else {
        // The advertised link already won: this payer gets nothing and times out to its fountain.
        return rescan("already accepted on the other link")
      }
      idleReaper?.cancel(); idleReaper = nil
      stage = .holding
      os_log("payee(scan): frame accepted bytes=%ld id=%{public}@", log: bleLog, type: .default, body.count, p.identifier.uuidString)
      onFrame(body.base64EncodedString())
    default:
      os_log("payee(scan): unexpected message ignored type=%d", log: bleLog, type: .default, Int32(type))
    }
  }

  private func write(_ message: Data, on p: CBPeripheral, completion: @escaping (Bool) -> Void) {
    guard let frame = frameChar else { return completion(false) }
    writeChunks = BleGattProfile.chunks(BleGattProfile.lengthPrefixed(message), size: Self.writeChunkSize(for: p))
    writeCompletion = completion
    writeNextChunk(p, frame)
  }

  private func writeNextChunk(_ p: CBPeripheral, _ frame: CBCharacteristic) {
    guard !writeChunks.isEmpty else {
      let done = writeCompletion; writeCompletion = nil
      done?(true)
      return
    }
    p.writeValue(writeChunks.removeFirst(), for: frame, type: .withResponse)
  }

  func peripheral(_ p: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard p === peripheral else { return }
    guard characteristic.uuid == BleGattProfile.frameCharUuid, let frame = frameChar else { return }
    if error != nil {
      let done = writeCompletion; writeCompletion = nil; writeChunks = []
      done?(false)
      return
    }
    writeNextChunk(p, frame)
  }

  /// The ACK, written with response. `completion(true)` only once the last chunk's write response arrived.
  func writeAck(_ message: Data, completion: @escaping (Bool) -> Void) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard stage == .holding, let p = peripheral else { return completion(false) }
    stage = .writingAck
    write(message, on: p) { [weak self] ok in
      guard let self else { return }
      os_log("payee(scan): ack written ok=%d", log: bleLog, type: .default, ok ? 1 : 0)
      completion(ok)
      self.tearDown()
    }
  }
}

// MARK: - Reversed role: payer as peripheral (spec 2026-09-03 §4, iOS twin)

private final class PayerAdvertise {
  let instanceName: String
  let psk: Data
  let sealed: Data
  let serviceUuid: CBUUID
  let promise: Promise<String>
  var service: CBMutableService?
  var ackChar: CBMutableCharacteristic?
  /** The central that subscribed first and received HELLO_A. */
  var candidate: CBCentral?
  /** Set once HELLO_B verified. */
  var bound: CBCentral?
  var frameOnWire = false
  var frameIndicationStarted = false
  var reassemblers: [UUID: BleGattProfile.Reassembler] = [:]
  var settled = false
  var connectTimeout: DispatchWorkItem?
  var wholeTimeout: DispatchWorkItem?
  var connectDeadline: DispatchTime?
  let startedAt = DispatchTime.now()

  init(instanceName: String, psk: Data, sealed: Data, promise: Promise<String>) {
    self.instanceName = instanceName
    self.psk = psk
    self.sealed = sealed
    self.serviceUuid = BleGattProfile.serviceUuid(psk: psk, instanceName: instanceName)
    self.promise = promise
  }

  func elapsedMs() -> Int { Int((DispatchTime.now().uptimeNanoseconds - startedAt.uptimeNanoseconds) / 1_000_000) }
}

// MARK: - Engine

/// Owns both CoreBluetooth managers and every piece of mutable state.
///
/// Threading, verbatim from the AWDL backend's discipline: both managers are
/// created with `queue` as their delegate queue, so every delegate callback in
/// this file (and every `OutboundSend` peripheral-delegate callback) already
/// runs on `queue` and touches state directly. The public entry points are
/// called from the JS-bridge thread, never from `queue`, and wrap their
/// mutations in `queue.sync`. `dispatchPrecondition` makes the confinement an
/// enforced invariant rather than an accident of wiring.
final class BleEngine: NSObject {
  fileprivate let queue = DispatchQueue(label: "org.bsvassociation.localpay.ble")

  fileprivate var peripheralManager: CBPeripheralManager?
  fileprivate var centralManager: CBCentralManager?
  /// Latest state either manager reported. Read by the prompt-free probes.
  private var lastKnownState: CBManagerState = .unknown
  private var prepareWaiters: [PrepareWaiter] = []

  private var listening: ListenSession?
  /// Indication chunks waiting for `updateValue` to accept them. Drained by
  /// `flushIndications`, resumed by `peripheralManagerIsReady(toUpdateSubscribers:)`.
  private var indicationQueue: [Indication] = []

  private var activeSend: OutboundSend?
  private var activeScan: InboundScan?
  private var activePayer: PayerAdvertise?

  /// How long the service stays registered after the ACK's last chunk was
  /// queued, in case the payer has not yet read it and disconnected. iOS only:
  /// Android's `BluetoothGattServer.notifyCharacteristicChanged` is
  /// synchronous with respect to `onNotificationSent`.
  private static let ackFlushGraceMs = 2_000

  // MARK: Probes (prompt-free)

  fileprivate static func describe(_ state: CBManagerState) -> String {
    switch state {
    case .poweredOn: return "poweredOn"
    case .poweredOff: return "poweredOff"
    case .unauthorized: return "unauthorized"
    case .unsupported: return "unsupported"
    case .unknown, .resetting: return "unknown"
    @unknown default: return "unknown"
    }
  }

  /// `.unknown`/`.resetting` are transient. So is `.unauthorized` while the
  /// system prompt is still on screen (authorization `.notDetermined`).
  private static func isSettled(_ state: CBManagerState) -> Bool {
    switch state {
    case .unknown, .resetting: return false
    case .unauthorized: return CBManager.authorization != .notDetermined
    default: return true
    }
  }

  /// Hardware present, not denied, and — where a manager has already reported
  /// it in this process — not powered off. Prompt-free: nothing here creates a
  /// manager. `notDetermined` counts as supported so the ladder can pick BLE
  /// and let the prompt follow (spec §7). A radio that is merely off with no
  /// manager yet is indistinguishable from on without prompting; the ladder
  /// then tries BLE, sendFrame's fast "bluetooth unavailable" falls to the
  /// fountain, and the next scan in this process floors to QR with the
  /// local_bt_off copy (spec §5).
  func isSupported() -> Bool {
    switch CBManager.authorization {
    case .denied, .restricted: return false
    default: break
    }
    return queue.sync {
      switch self.lastKnownState {
      case .unsupported, .poweredOff: return false
      default: return true
      }
    }
  }

  func bluetoothState() -> String {
    queue.sync { self.stateString() }
  }

  static func nfcAvailable() -> Bool {
    #if canImport(CoreNFC)
    return NFCNDEFReaderSession.readingAvailable
    #else
    return false
    #endif
  }

  /// Runs on `queue`. Prefers a live manager's settled state; before any
  /// manager exists, all that can be known without prompting is authorization.
  private func stateString() -> String {
    dispatchPrecondition(condition: .onQueue(queue))
    if let cm = centralManager, Self.isSettled(cm.state) { return Self.describe(cm.state) }
    if let pm = peripheralManager, Self.isSettled(pm.state) { return Self.describe(pm.state) }
    if Self.isSettled(lastKnownState) { return Self.describe(lastKnownState) }
    switch CBManager.authorization {
    case .denied, .restricted: return "unauthorized"
    default: return "unknown"
    }
  }

  // MARK: Managers and prepare()

  /// The one place a `CB*Manager` is constructed -- and therefore the one
  /// place the iOS Bluetooth privacy prompt can appear. Runs on `queue`.
  private func ensureManagers() {
    dispatchPrecondition(condition: .onQueue(queue))
    if peripheralManager == nil {
      peripheralManager = CBPeripheralManager(
        delegate: self, queue: queue,
        options: [CBPeripheralManagerOptionShowPowerAlertKey: false]
      )
    }
    if centralManager == nil {
      centralManager = CBCentralManager(
        delegate: self, queue: queue,
        options: [CBCentralManagerOptionShowPowerAlertKey: false]
      )
    }
  }

  private var managersSettled: Bool {
    guard let pm = peripheralManager, let cm = centralManager else { return false }
    return Self.isSettled(pm.state) && Self.isSettled(cm.state)
  }

  func prepare(timeoutMs: Double) -> Promise<String> {
    let promise = Promise<String>()
    // Called from the JS-bridge thread, never from `queue` itself.
    queue.sync {
      self.ensureManagers()
      if self.managersSettled {
        let state = self.stateString()
        os_log("prepare resolved state=%{public}@", log: bleLog, type: .default, state)
        promise.resolve(withResult: state)
        return
      }
      let timeout = DispatchWorkItem { [weak self] in
        guard let self else { return }
        dispatchPrecondition(condition: .onQueue(self.queue))
        guard let idx = self.prepareWaiters.firstIndex(where: { $0.promise === promise }) else { return }
        self.prepareWaiters.remove(at: idx)
        let state = self.stateString()
        os_log("prepare timed out state=%{public}@", log: bleLog, type: .default, state)
        promise.resolve(withResult: state)
      }
      self.prepareWaiters.append(PrepareWaiter(promise: promise, timeout: timeout))
      self.queue.asyncAfter(deadline: .now() + .milliseconds(max(0, Int(timeoutMs))), execute: timeout)
    }
    return promise
  }

  private func stateChanged(_ state: CBManagerState) {
    dispatchPrecondition(condition: .onQueue(queue))
    lastKnownState = state
    guard managersSettled, !prepareWaiters.isEmpty else { return }
    let waiters = prepareWaiters
    prepareWaiters.removeAll()
    let result = stateString()
    os_log("prepare resolved state=%{public}@", log: bleLog, type: .default, result)
    for w in waiters {
      w.timeout.cancel()
      w.promise.resolve(withResult: result)
    }
  }

  // MARK: Payee: startListening / stopListening / confirmFrame

  func startListening(
    instanceName: String,
    pskBase64: String,
    onFrame: @escaping (String) -> Void,
    onError: @escaping (String) -> Void
  ) -> Promise<Void> {
    let promise = Promise<Void>()
    guard let psk = Data(base64Encoded: pskBase64), !instanceName.isEmpty else {
      promise.reject(withError: BleGattProfile.error("bad psk or instance name", code: 10))
      return promise
    }
    // Called from the JS-bridge thread, never from `queue` itself.
    queue.sync {
      // Self-reset (spec §3 step 2): a previous session that was never
      // explicitly stopped must not leak its latch, centrals or reapers.
      self.resetListening()
      // A device never pays and receives at once; a listen supersedes a live send.
      if let payer = self.activePayer {
        self.settlePayer(payer, .failure(BleGattProfile.error("superseded by a newer send", code: 15)))
      }
      // Defensive, and normally a no-op: the payee flow calls prepare() at
      // minting, which is where the iOS Bluetooth prompt appears. Without this
      // call a caller that skipped prepare() would hang forever on
      // advertiseIfPowered's silent "no manager yet" guard -- so on a build
      // that does not call prepare() first, the prompt appears here instead.
      self.ensureManagers()
      let session = ListenSession(
        instanceName: instanceName, psk: psk,
        serviceUuid: BleGattProfile.serviceUuid(psk: psk, instanceName: instanceName),
        onFrame: onFrame, onError: onError
      )
      session.startPromise = promise
      self.listening = session
      self.advertiseIfPowered()
    }
    return promise
  }

  /// Adds the session service once the peripheral manager is powered on.
  /// Called from `startListening` and again from `peripheralManagerDidUpdateState`
  /// when the manager was still settling at that point.
  private func advertiseIfPowered() {
    dispatchPrecondition(condition: .onQueue(queue))
    guard let session = listening, session.service == nil, let pm = peripheralManager else { return }
    switch pm.state {
    case .poweredOn:
      break
    case .unknown, .resetting:
      return
    case .unauthorized where CBManager.authorization == .notDetermined:
      return
    default:
      failStart(session, message: "bluetooth unavailable")
      return
    }
    let frame = CBMutableCharacteristic(
      type: BleGattProfile.frameCharUuid,
      properties: [.write, .writeWithoutResponse],
      value: nil,
      permissions: [.writeable]
    )
    let ack = CBMutableCharacteristic(
      type: BleGattProfile.ackCharUuid,
      properties: [.indicate],
      value: nil,
      permissions: [.readable]
    )
    let service = CBMutableService(type: session.serviceUuid, primary: true)
    service.characteristics = [frame, ack]
    session.frameChar = frame
    session.ackChar = ack
    session.service = service
    pm.add(service)
  }

  private func failStart(_ session: ListenSession, message: String) {
    dispatchPrecondition(condition: .onQueue(queue))
    if let promise = session.startPromise {
      session.startPromise = nil
      promise.reject(withError: BleGattProfile.error(message, code: 16))
    }
    resetListening()
  }

  /// Tears the current listen session down: advertising, service, every
  /// central's state, every reaper, every queued indication. Runs on `queue`.
  private func resetListening() {
    dispatchPrecondition(condition: .onQueue(queue))
    indicationQueue.removeAll()
    activeScan?.tearDown(); activeScan = nil
    if let session = listening {
      session.centrals.values.forEach { $0.idleReaper?.cancel() }
      session.pendingAckTimeout?.cancel()
      session.closeTimeout?.cancel()
      if let promise = session.startPromise {
        session.startPromise = nil
        promise.reject(withError: BleGattProfile.error("listener reset", code: 17))
      }
      if let promise = session.ackPromise {
        session.ackPromise = nil
        promise.reject(withError: BleGattProfile.error("listener reset", code: 17))
      }
    }
    listening = nil
    if let pm = peripheralManager, pm.state == .poweredOn {
      if pm.isAdvertising { pm.stopAdvertising() }
      pm.removeAllServices()
    }
  }

  func stopListening() -> Promise<Void> {
    let promise = Promise<Void>()
    // Called from the JS-bridge thread, never from `queue` itself. JS must not
    // call this on the success path (it drops the central the ack has to go
    // to) -- see the `teardown` flag in core/localpay/transport/socket.ts.
    queue.sync {
      os_log("listener stopped by JS", log: bleLog, type: .default)
      self.resetListening()
    }
    promise.resolve(withResult: ())
    return promise
  }

  /// Sends the ACK to the central held since `onFrame`, then closes the
  /// session. `accepted: true` only after JS has durably queued the payment;
  /// `accepted: false` only where nothing was queued (spec §9). Idempotent
  /// with nothing pending. Rejects only if the ack cannot reach the central.
  func confirmFrame(accepted: Bool, reason: String) -> Promise<Void> {
    let promise = Promise<Void>()
    // Called from the JS-bridge thread, never from `queue` itself.
    queue.sync {
      guard let session = self.listening else {
        promise.resolve(withResult: ())
        return
      }
      session.pendingAckTimeout?.cancel()
      session.pendingAckTimeout = nil
      if let scan = session.scanPendingAck {
        session.scanPendingAck = nil
        let json = accepted ? BleGattProfile.okJson : BleGattProfile.declineJson(reason: reason)
        let message = BleGattProfile.ackMessage(psk: session.psk, instanceName: session.instanceName, ackJson: Data(json.utf8))
        session.closing = true
        scan.writeAck(message) { [weak self] ok in
          guard let self else { return }
          self.activeScan = nil
          if ok {
            os_log("ack sent ok=%d bytes=%ld via scan link", log: bleLog, type: .default, accepted ? 1 : 0, message.count)
            promise.resolve(withResult: ())
          } else {
            promise.reject(withError: BleGattProfile.error("peer disconnected before acking", code: 21))
          }
          self.resetListening()
        }
        return
      }
      guard let target = session.pendingAck else {
        promise.resolve(withResult: ())
        return
      }
      session.pendingAck = nil
      guard target.subscribed, let pm = self.peripheralManager, pm.state == .poweredOn else {
        promise.reject(withError: BleGattProfile.error("peer disconnected before acking", code: 21))
        self.resetListening()
        return
      }
      // The session is over either way: nobody else gets HELLO_B or a FRAME in.
      for other in session.centrals.values where other !== target {
        self.forget(other, in: session)
      }
      let json = accepted ? BleGattProfile.okJson : BleGattProfile.declineJson(reason: reason)
      let message = BleGattProfile.ackMessage(
        psk: session.psk, instanceName: session.instanceName, ackJson: Data(json.utf8)
      )
      session.ackPromise = promise
      session.ackTarget = target
      session.closing = true
      self.enqueueIndication(message, to: target.central) { [weak self] in
        guard let self, let session = self.listening, session.ackPromise === promise else { return }
        session.ackPromise = nil
        os_log("ack sent ok=%d bytes=%ld", log: bleLog, type: .default, accepted ? 1 : 0, message.count)
        promise.resolve(withResult: ())
        self.scheduleClose(session)
      }
    }
    return promise
  }

  private func scheduleClose(_ session: ListenSession) {
    dispatchPrecondition(condition: .onQueue(queue))
    let item = DispatchWorkItem { [weak self] in
      guard let self, self.listening === session else { return }
      dispatchPrecondition(condition: .onQueue(self.queue))
      self.resetListening()
    }
    session.closeTimeout = item
    queue.asyncAfter(deadline: .now() + .milliseconds(Self.ackFlushGraceMs), execute: item)
  }

  // MARK: Payee: per-central state

  private func inbound(for central: CBCentral, in session: ListenSession) -> InboundCentral {
    dispatchPrecondition(condition: .onQueue(queue))
    if let existing = session.centrals[central.identifier] { return existing }
    let entry = InboundCentral(central: central)
    session.centrals[central.identifier] = entry
    armIdleReaper(entry, in: session)
    return entry
  }

  /// 30 s idle reaper per central (spec §3 step 3). Silent: a stranger that
  /// connected to the advertisement and never completed HELLO is not a failed
  /// payment, and `onError` is scoped to the one accepted payment per session.
  private func armIdleReaper(_ entry: InboundCentral, in session: ListenSession) {
    let item = DispatchWorkItem { [weak self] in
      guard let self else { return }
      dispatchPrecondition(condition: .onQueue(self.queue))
      guard let session = self.listening,
            let current = session.centrals[entry.central.identifier], current === entry else { return }
      os_log("idle central forgotten id=%{public}@", log: bleLog, type: .default, entry.central.identifier.uuidString)
      self.forget(current, in: session)
    }
    entry.idleReaper = item
    queue.asyncAfter(deadline: .now() + .milliseconds(BleGattProfile.idleConnectionTimeoutMs), execute: item)
  }

  /// CoreBluetooth offers no peripheral-side disconnect. Forgetting a central
  /// means: its state is gone, its queued indications are dropped, and its
  /// further writes are answered `insufficientAuthorization`.
  private func forget(_ entry: InboundCentral, in session: ListenSession) {
    dispatchPrecondition(condition: .onQueue(queue))
    entry.idleReaper?.cancel()
    entry.idleReaper = nil
    // A forgotten central has no ack route left, so the flags that describe
    // that route must go with it. Without this, `forget` on the held central
    // left `pendingAck` pointing at an untracked entry whose `subscribed` was
    // still true: `confirmFrame` would then queue the ACK to a departed
    // central, `updateValue` would accept it, and the completion would resolve
    // with `ack sent ok=1` logged for a payment the payer never heard about.
    // Releasing the hold here makes that path reject "peer disconnected before
    // acking" instead -- the payer's inputs stay locked, which is the safe
    // failure (see HybridLocalPayTransport.pendingAckConfirmTimeout).
    entry.subscribed = false
    if session.pendingAck === entry {
      session.pendingAck = nil
      session.pendingAckTimeout?.cancel()
      session.pendingAckTimeout = nil
    }
    session.centrals.removeValue(forKey: entry.central.identifier)
    let id = entry.central.identifier
    indicationQueue.removeAll { $0.central.identifier == id }
  }

  /// Refuses one message from one central. The central being held for the ack
  /// is deliberately NOT forgotten: a stray or malformed write from the payer
  /// after its FRAME was accepted (a duplicate, a retry, a truncated record)
  /// must not cost it the ack route it is waiting on. Everything else is
  /// dropped outright, exactly as before.
  private func refuse(_ entry: InboundCentral, in session: ListenSession, reason: String) {
    dispatchPrecondition(condition: .onQueue(queue))
    os_log("frame refused reason=%{public}@ id=%{public}@", log: bleLog, type: .default,
           reason, entry.central.identifier.uuidString)
    guard session.pendingAck !== entry else { return }
    forget(entry, in: session)
  }

  /// 60 s ack reaper (spec §3 step 7). Tears down SILENTLY -- never a
  /// synthesised negative ack -- for the reasons spelled out at
  /// HybridLocalPayTransport.pendingAckConfirmTimeout: a negative ack releases
  /// the payer's inputs, and a payee that is merely slow may still succeed.
  private func armAckReaper(_ entry: InboundCentral, in session: ListenSession) {
    let item = DispatchWorkItem { [weak self] in
      guard let self else { return }
      dispatchPrecondition(condition: .onQueue(self.queue))
      guard let session = self.listening, session.pendingAck === entry else { return }
      session.pendingAck = nil
      session.pendingAckTimeout = nil
      self.forget(entry, in: session)
      os_log("ack reaper fired; connection released", log: bleLog, type: .default)
      session.onError("payee never confirmed the payment; connection released")
    }
    session.pendingAckTimeout = item
    queue.asyncAfter(deadline: .now() + .milliseconds(BleGattProfile.pendingAckTimeoutMs), execute: item)
  }

  /// Dispatches one reassembled message from one central (spec §3 steps 4-5).
  private func handle(message: Data, from entry: InboundCentral, in session: ListenSession) {
    dispatchPrecondition(condition: .onQueue(queue))
    // An earlier message in the same write batch may already have forgotten it.
    guard session.centrals[entry.central.identifier] === entry, !message.isEmpty else { return }
    let type = message[message.startIndex]
    let body = Data(message.dropFirst())
    let id = entry.central.identifier.uuidString

    switch (type, entry.stage) {
    case (BleGattProfile.typeHelloA, .awaitingHello):
      // The session already has its payer: nobody else gets HELLO_B, and a
      // stray HELLO_A from the held central must not cost it the ack route
      // (`refuse` keeps that one central). Mirrors Kotlin's
      // `TYPE_HELLO_A -> if (hasAccepted) refuse(device, "already accepted")`.
      guard !session.hasAccepted else {
        refuse(entry, in: session, reason: "already accepted")
        return
      }
      let expected = BleGattProfile.proof(psk: session.psk, instanceName: session.instanceName, type: BleGattProfile.typeHelloA)
      guard entry.subscribed, BleGattProfile.constantTimeEquals(body, expected) else {
        // Wrong PSK, or no route back for HELLO_B: forget it, keep advertising.
        os_log("hello rejected id=%{public}@", log: bleLog, type: .default, id)
        forget(entry, in: session)
        return
      }
      entry.stage = .bound
      os_log("hello verified id=%{public}@", log: bleLog, type: .default, id)
      enqueueIndication(
        BleGattProfile.helloB(psk: session.psk, instanceName: session.instanceName),
        to: entry.central, completion: nil
      )

    case (BleGattProfile.typeFrame, .bound):
      // First-success-wins as a native invariant: a second PSK-holder reaching
      // FRAME after we accepted one is refused outright, never raced.
      guard !session.hasAccepted, !body.isEmpty else {
        refuse(entry, in: session, reason: session.hasAccepted ? "already accepted" : "empty frame")
        return
      }
      session.hasAccepted = true
      entry.idleReaper?.cancel()
      entry.idleReaper = nil
      // Stop advertising immediately so nothing else can connect, rather than
      // waiting for JS to round-trip stopListening().
      if let pm = peripheralManager, pm.isAdvertising { pm.stopAdvertising() }
      // The advertised link won: the scan link (reversed role) is torn down now.
      activeScan?.tearDown()
      activeScan = nil
      // Arm the hold BEFORE handing the frame over (see
      // HybridLocalPayTransport.acceptConnection for why the order matters).
      session.pendingAck = entry
      armAckReaper(entry, in: session)
      os_log("frame accepted bytes=%ld id=%{public}@", log: bleLog, type: .default, body.count, id)
      session.onFrame(body.base64EncodedString())

    default:
      // FRAME before HELLO, a second HELLO, or an unknown type: protocol violation.
      refuse(entry, in: session,
             reason: type == BleGattProfile.typeFrame ? "not bound" : "unexpected type")
    }
  }

  // MARK: Payee: indications with backpressure

  private func enqueueIndication(_ message: Data, to central: CBCentral, completion: (() -> Void)?) {
    dispatchPrecondition(condition: .onQueue(queue))
    let parts = BleGattProfile.chunks(BleGattProfile.lengthPrefixed(message), size: min(central.maximumUpdateValueLength, BleGattProfile.maxChunkBytes))
    for (i, part) in parts.enumerated() {
      indicationQueue.append(Indication(central: central, chunk: part, completion: i == parts.count - 1 ? completion : nil))
    }
    flushIndications()
  }

  /// `updateValue` returns false when CoreBluetooth's transmit queue is full;
  /// the remainder waits for `peripheralManagerIsReady(toUpdateSubscribers:)`.
  private func flushIndications() {
    dispatchPrecondition(condition: .onQueue(queue))
    guard let pm = peripheralManager, let session = listening, let ack = session.ackChar else {
      indicationQueue.removeAll()
      return
    }
    while let next = indicationQueue.first {
      guard pm.updateValue(next.chunk, for: ack, onSubscribedCentrals: [next.central]) else { return }
      indicationQueue.removeFirst()
      next.completion?()
    }
  }

  // MARK: Payer: sendFrame

  func sendFrame(
    instanceName: String,
    pskBase64: String,
    frameBase64: String,
    timeoutMs: Double,
    connectTimeoutMs: Double
  ) -> Promise<String> {
    let promise = Promise<String>()
    guard let psk = Data(base64Encoded: pskBase64),
          let sealed = Data(base64Encoded: frameBase64),
          !instanceName.isEmpty else {
      promise.reject(withError: BleGattProfile.error("bad psk or frame", code: 11))
      return promise
    }
    // Type byte + sealed body must fit one profile message (spec §3).
    guard sealed.count + 1 <= BleGattProfile.maxBleFrameBytes else {
      promise.reject(withError: BleGattProfile.error("frame too large for a BLE payload", code: 30))
      return promise
    }
    // Called from the JS-bridge thread, never from `queue` itself.
    queue.sync {
      self.ensureManagers()
      // JS may have abandoned an earlier send (its own abort) and retried
      // before our timeouts fired; the newer send wins.
      if let previous = self.activeSend {
        previous.settle(.failure(BleGattProfile.error("superseded by a newer send", code: 15)))
      }
      let send = OutboundSend(
        engine: self, instanceName: instanceName, psk: psk, sealed: sealed, promise: promise
      )
      self.activeSend = send
      send.start(timeoutMs: timeoutMs, connectTimeoutMs: connectTimeoutMs)
    }
    return promise
  }

  /// Called by `OutboundSend.settle` on `queue`: releases the radio.
  fileprivate func finishSend(_ send: OutboundSend) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard activeSend === send else { return }
    activeSend = nil
    guard let cm = centralManager else { return }
    if send.isScanning { cm.stopScan() }
    if let p = send.peripheral, p.state != .disconnected { cm.cancelPeripheralConnection(p) }
  }

  // MARK: Reversed role (spec 2026-09-03) — filled in by the InboundScan / PayerAdvertise tasks

  func startScanning(
    instanceName: String, pskBase64: String,
    onFrame: @escaping (String) -> Void, onError: @escaping (String) -> Void
  ) -> Promise<Void> {
    let promise = Promise<Void>()
    guard let psk = Data(base64Encoded: pskBase64), !instanceName.isEmpty else {
      promise.reject(withError: BleGattProfile.error("bad psk or instance name", code: 10))
      return promise
    }
    queue.sync {
      self.ensureManagers()
      if self.listening == nil {
        os_log("payee(scan): startScanning called with no active listen session", log: bleLog, type: .default)
      }
      self.activeScan?.tearDown()
      let scan = InboundScan(engine: self, instanceName: instanceName, psk: psk, onFrame: onFrame, onError: onError)
      self.activeScan = scan
      if scan.start() {
        promise.resolve(withResult: ())
      } else {
        self.activeScan = nil
        promise.reject(withError: BleGattProfile.error("bluetooth unavailable", code: 16))
      }
    }
    return promise
  }

  /// Called by InboundScan on `queue` when a FRAME is complete. Returns false if the advertised link already won.
  fileprivate func acceptScannedFrame(_ scan: InboundScan) -> Bool {
    dispatchPrecondition(condition: .onQueue(queue))
    guard let session = listening, !session.hasAccepted, activeScan === scan else { return false }
    session.hasAccepted = true
    if let pm = peripheralManager, pm.isAdvertising { pm.stopAdvertising() }
    // The advertised link lost: forget every central it holds.
    for entry in Array(session.centrals.values) { forget(entry, in: session) }
    session.scanPendingAck = scan
    let item = DispatchWorkItem { [weak self] in
      guard let self, let session = self.listening, session.scanPendingAck === scan else { return }
      session.scanPendingAck = nil
      session.pendingAckTimeout = nil
      scan.tearDown()
      self.activeScan = nil
      os_log("ack reaper fired; connection released", log: bleLog, type: .default)
      session.onError("payee never confirmed the payment; connection released")
    }
    session.pendingAckTimeout = item
    queue.asyncAfter(deadline: .now() + .milliseconds(BleGattProfile.pendingAckTimeoutMs), execute: item)
    return true
  }

  /// Called by InboundScan when the held payer disconnected before the ack.
  fileprivate func scanLinkLost(_ scan: InboundScan) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard activeScan === scan else { return }
    listening?.pendingAckTimeout?.cancel()
    listening?.pendingAckTimeout = nil
    activeScan = nil
    scan.tearDown()
  }

  func sendFrameAdvertising(
    instanceName: String, pskBase64: String, frameBase64: String,
    timeoutMs: Double, connectTimeoutMs: Double
  ) -> Promise<String> {
    let promise = Promise<String>()
    guard let psk = Data(base64Encoded: pskBase64), let sealed = Data(base64Encoded: frameBase64), !instanceName.isEmpty else {
      promise.reject(withError: BleGattProfile.error("bad psk or frame", code: 11))
      return promise
    }
    guard sealed.count + 1 <= BleGattProfile.maxBleFrameBytes else {
      promise.reject(withError: BleGattProfile.error("frame too large for a BLE payload", code: 30))
      return promise
    }
    queue.sync {
      self.ensureManagers()
      // A payer never listens while it pays; a newer send supersedes an older one.
      self.resetListening()
      if let previous = self.activePayer { self.settlePayer(previous, .failure(BleGattProfile.error("superseded by a newer send", code: 15))) }
      let payer = PayerAdvertise(instanceName: instanceName, psk: psk, sealed: sealed, promise: promise)
      self.activePayer = payer
      let whole = DispatchWorkItem { [weak self] in
        guard let self, let p = self.activePayer, p === payer else { return }
        self.settlePayer(p, .failure(BleGattProfile.error("timed out waiting for peer", code: 12)))
      }
      payer.wholeTimeout = whole
      self.queue.asyncAfter(deadline: .now() + .milliseconds(max(0, Int(timeoutMs))), execute: whole)
      let connectDeadline = DispatchTime.now() + .milliseconds(max(0, Int(connectTimeoutMs)))
      payer.connectDeadline = connectDeadline
      let connect = DispatchWorkItem { [weak self] in
        guard let self, let p = self.activePayer, p === payer, p.candidate == nil else { return }
        self.settlePayer(p, .failure(BleGattProfile.error("connect timeout: no route to peer", code: 14)))
      }
      payer.connectTimeout = connect
      self.queue.asyncAfter(deadline: connectDeadline, execute: connect)
      self.advertisePayerIfPowered()
    }
    return promise
  }

  private func advertisePayerIfPowered() {
    dispatchPrecondition(condition: .onQueue(queue))
    guard let payer = activePayer, payer.service == nil, let pm = peripheralManager else { return }
    switch pm.state {
    case .poweredOn: break
    case .unknown, .resetting: return
    case .unauthorized where CBManager.authorization == .notDetermined: return
    default:
      settlePayer(payer, .failure(BleGattProfile.error("bluetooth unavailable", code: 16)))
      return
    }
    let frame = CBMutableCharacteristic(type: BleGattProfile.frameCharUuid, properties: [.write, .writeWithoutResponse], value: nil, permissions: [.writeable])
    let ack = CBMutableCharacteristic(type: BleGattProfile.ackCharUuid, properties: [.indicate], value: nil, permissions: [.readable])
    let service = CBMutableService(type: payer.serviceUuid, primary: true)
    service.characteristics = [frame, ack]
    payer.ackChar = ack
    payer.service = service
    pm.add(service)
  }

  fileprivate func settlePayer(_ payer: PayerAdvertise, _ result: Result<String, Error>) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard !payer.settled else { return }
    payer.settled = true
    payer.connectTimeout?.cancel(); payer.wholeTimeout?.cancel()
    if activePayer === payer { activePayer = nil }
    indicationQueue.removeAll()
    if let pm = peripheralManager, pm.state == .poweredOn {
      if pm.isAdvertising { pm.stopAdvertising() }
      pm.removeAllServices()
    }
    switch result {
    case .success(let ack): payer.promise.resolve(withResult: ack)
    case .failure(let error):
      os_log("payer(adv): send failed reason=%{public}@", log: bleLog, type: .default, error.localizedDescription)
      payer.promise.reject(withError: error)
    }
  }

  /// Indication enqueue for the payer role: `flushIndications` needs an ACK characteristic, which it reads from `listening`; the payer keeps its own, so this variant takes it explicitly.
  private func enqueuePayerIndication(_ message: Data, to central: CBCentral, ack: CBMutableCharacteristic, completion: (() -> Void)?) {
    dispatchPrecondition(condition: .onQueue(queue))
    let parts = BleGattProfile.chunks(BleGattProfile.lengthPrefixed(message), size: min(central.maximumUpdateValueLength, BleGattProfile.maxChunkBytes))
    for (i, part) in parts.enumerated() {
      indicationQueue.append(Indication(central: central, chunk: part, completion: i == parts.count - 1 ? completion : nil))
    }
    flushPayerIndications(ack)
  }

  private func flushPayerIndications(_ ack: CBMutableCharacteristic) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard let pm = peripheralManager else { indicationQueue.removeAll(); return }
    while let next = indicationQueue.first {
      guard pm.updateValue(next.chunk, for: ack, onSubscribedCentrals: [next.central]) else { return }
      indicationQueue.removeFirst()
      next.completion?()
    }
  }

  private func payerHandle(message: Data, from central: CBCentral, payer: PayerAdvertise) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard !payer.settled, !message.isEmpty, let ack = payer.ackChar else { return }
    let type = message[message.startIndex]
    let body = Data(message.dropFirst())
    let fromCandidate = payer.candidate?.identifier == central.identifier
    if type == BleGattProfile.typeHelloB, payer.bound == nil, fromCandidate {
      let expected = BleGattProfile.proof(psk: payer.psk, instanceName: payer.instanceName, type: BleGattProfile.typeHelloB)
      guard BleGattProfile.constantTimeEquals(body, expected) else {
        os_log("payer(adv): HELLO_B proof failed id=%{public}@", log: bleLog, type: .default, central.identifier.uuidString)
        payer.candidate = nil
        if let deadline = payer.connectDeadline {
          let retry = DispatchWorkItem { [weak self] in
            guard let self, let p = self.activePayer, p === payer, p.candidate == nil else { return }
            self.settlePayer(p, .failure(BleGattProfile.error("connect timeout: no route to peer", code: 14)))
          }
          payer.connectTimeout = retry
          self.queue.asyncAfter(deadline: deadline, execute: retry)
        }
        return
      }
      payer.bound = central
      if let pm = peripheralManager, pm.isAdvertising { pm.stopAdvertising() }
      os_log("payer(adv): hello verified ms=%ld; indicating frame bytes=%ld", log: bleLog, type: .default, payer.elapsedMs(), payer.sealed.count)
      payer.frameIndicationStarted = true
      enqueuePayerIndication(BleGattProfile.frameMessage(sealed: payer.sealed), to: central, ack: ack) { [weak self, weak payer] in
        guard let payer, !payer.settled else { return }
        payer.frameOnWire = true
        os_log("payer(adv): frame indicated ms=%ld; awaiting ack", log: bleLog, type: .default, payer.elapsedMs())
        _ = self
      }
      return
    }
    if type == BleGattProfile.typeAck, payer.bound?.identifier == central.identifier, payer.frameOnWire || payer.frameIndicationStarted {
      guard body.count > BleGattProfile.macLength else { return settlePayer(payer, .failure(BleGattProfile.error("peer failed the session proof", code: 22))) }
      let json = Data(body.prefix(body.count - BleGattProfile.macLength))
      let mac = Data(body.suffix(BleGattProfile.macLength))
      guard BleGattProfile.constantTimeEquals(mac, BleGattProfile.ackMac(psk: payer.psk, instanceName: payer.instanceName, ackJson: json)) else {
        return settlePayer(payer, .failure(BleGattProfile.error("peer failed the session proof", code: 22)))
      }
      os_log("payer(adv): ack verified bytes=%ld ms=%ld", log: bleLog, type: .default, json.count, payer.elapsedMs())
      settlePayer(payer, .success(json.base64EncodedString()))
      return
    }
    if payer.frameOnWire {
      os_log("payer(adv): unexpected message ignored type=%d", log: bleLog, type: .default, Int32(type))
    } else if fromCandidate {
      settlePayer(payer, .failure(BleGattProfile.error("peer failed the session proof", code: 22)))
    }
  }
}

// MARK: - CBPeripheralManagerDelegate (payee)

extension BleEngine: CBPeripheralManagerDelegate {
  func peripheralManagerDidUpdateState(_ pm: CBPeripheralManager) {
    dispatchPrecondition(condition: .onQueue(queue))
    os_log("peripheral manager state=%{public}@", log: bleLog, type: .default, Self.describe(pm.state))
    stateChanged(pm.state)
    if let payer = activePayer {
      switch pm.state {
      case .poweredOn: advertisePayerIfPowered()
      case .unknown, .resetting: break
      case .unauthorized where CBManager.authorization == .notDetermined: break
      default: settlePayer(payer, .failure(BleGattProfile.error("bluetooth unavailable", code: 16)))
      }
      return
    }
    guard let session = listening else { return }
    switch pm.state {
    case .poweredOn:
      advertiseIfPowered()
    case .unknown, .resetting:
      break
    case .unauthorized where CBManager.authorization == .notDetermined:
      break
    default:
      if session.startPromise != nil {
        failStart(session, message: "bluetooth unavailable")
      } else if !session.closing {
        let onError = session.onError
        resetListening()
        onError("bluetooth unavailable")
      } else {
        resetListening()
      }
    }
  }

  func peripheralManager(_ pm: CBPeripheralManager, didAdd service: CBService, error: Error?) {
    dispatchPrecondition(condition: .onQueue(queue))
    if let payer = activePayer, payer.service?.uuid == service.uuid {
      if let error { return settlePayer(payer, .failure(error)) }
      pm.startAdvertising([CBAdvertisementDataServiceUUIDsKey: [payer.serviceUuid], CBAdvertisementDataLocalNameKey: BleGattProfile.localName])
      return
    }
    guard let session = listening, session.service?.uuid == service.uuid else { return }
    if let error {
      failStart(session, message: error.localizedDescription)
      return
    }
    pm.startAdvertising([
      CBAdvertisementDataServiceUUIDsKey: [session.serviceUuid],
      CBAdvertisementDataLocalNameKey: BleGattProfile.localName
    ])
  }

  func peripheralManagerDidStartAdvertising(_ pm: CBPeripheralManager, error: Error?) {
    dispatchPrecondition(condition: .onQueue(queue))
    if let payer = activePayer {
      if let error { return settlePayer(payer, .failure(error)) }
      os_log("payer(adv): advertising started service=%{public}@", log: bleLog, type: .default, payer.serviceUuid.uuidString)
      return
    }
    guard let session = listening else { return }
    if let error {
      failStart(session, message: error.localizedDescription)
      return
    }
    os_log("advertising started service=%{public}@ name=%{public}@", log: bleLog, type: .default,
           session.serviceUuid.uuidString, session.instanceName)
    if let promise = session.startPromise {
      session.startPromise = nil
      promise.resolve(withResult: ())
    }
  }

  func peripheralManager(_ pm: CBPeripheralManager, central: CBCentral, didSubscribeTo characteristic: CBCharacteristic) {
    dispatchPrecondition(condition: .onQueue(queue))
    if let payer = activePayer, characteristic.uuid == BleGattProfile.ackCharUuid, let ack = payer.ackChar {
      guard payer.candidate == nil else { return }
      payer.candidate = central
      payer.connectTimeout?.cancel()
      os_log("payer(adv): central subscribed id=%{public}@ maxUpdate=%ld ms=%ld; indicating HELLO_A", log: bleLog, type: .default, central.identifier.uuidString, central.maximumUpdateValueLength, payer.elapsedMs())
      enqueuePayerIndication(BleGattProfile.helloA(psk: payer.psk, instanceName: payer.instanceName), to: central, ack: ack, completion: nil)
      return
    }
    guard let session = listening, characteristic.uuid == BleGattProfile.ackCharUuid, !session.closing else { return }
    // A subscriber after acceptance can never be bound (advertising stopped
    // before it could have discovered us); do not track it.
    guard !session.hasAccepted || session.centrals[central.identifier] != nil else { return }
    let entry = inbound(for: central, in: session)
    entry.subscribed = true
    os_log("central connected id=%{public}@ maxUpdate=%ld", log: bleLog, type: .default,
           central.identifier.uuidString, central.maximumUpdateValueLength)
  }

  func peripheralManager(_ pm: CBPeripheralManager, central: CBCentral, didUnsubscribeFrom characteristic: CBCharacteristic) {
    dispatchPrecondition(condition: .onQueue(queue))
    if let payer = activePayer {
      if payer.bound?.identifier == central.identifier || payer.candidate?.identifier == central.identifier {
        settlePayer(payer, .failure(BleGattProfile.error("peer disconnected before acking", code: 21)))
      }
      return
    }
    guard let session = listening, let entry = session.centrals[central.identifier] else { return }
    entry.subscribed = false
    let id = central.identifier
    indicationQueue.removeAll { $0.central.identifier == id }
    if let promise = session.ackPromise, session.ackTarget === entry {
      // Mid-ack disconnect: the ack did not fully leave this device.
      session.ackPromise = nil
      promise.reject(withError: BleGattProfile.error("peer disconnected before acking", code: 21))
      resetListening()
      return
    }
    if session.closing, session.ackTarget === entry {
      // The payer read its ack and left: no need to wait out the grace period.
      resetListening()
      return
    }
    if session.pendingAck !== entry {
      // Not the held central: an idle or refused stranger leaving.
      forget(entry, in: session)
    }
    // If it IS the held central (payer gave up before JS confirmed), keep the
    // entry with subscribed == false so confirmFrame reports the failure
    // instead of silently succeeding into nowhere.
  }

  func peripheralManager(_ pm: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard let first = requests.first else { return }
    if let payer = activePayer {
      var result: CBATTError.Code = .success
      var pending: [(Data, CBCentral)] = []
      for request in requests {
        guard request.characteristic.uuid == BleGattProfile.frameCharUuid, let value = request.value, !value.isEmpty else { continue }
        var reassembler = payer.reassemblers[request.central.identifier] ?? BleGattProfile.Reassembler()
        do {
          let messages = try reassembler.feed(value)
          payer.reassemblers[request.central.identifier] = reassembler
          for message in messages { pending.append((message, request.central)) }
        } catch {
          payer.reassemblers[request.central.identifier] = BleGattProfile.Reassembler()
          result = .invalidAttributeValueLength
        }
      }
      pm.respond(to: first, withResult: result)
      for (message, central) in pending { payerHandle(message: message, from: central, payer: payer) }
      return
    }
    guard let session = listening, !session.closing else {
      pm.respond(to: first, withResult: .insufficientAuthorization)
      return
    }
    var result: CBATTError.Code = .success
    for request in requests {
      guard request.characteristic.uuid == BleGattProfile.frameCharUuid else {
        result = .attributeNotFound
        continue
      }
      let entry: InboundCentral
      if let existing = session.centrals[request.central.identifier] {
        entry = existing
      } else if session.hasAccepted {
        result = .insufficientAuthorization
        continue
      } else {
        entry = inbound(for: request.central, in: session)
      }
      guard let value = request.value, !value.isEmpty else { continue }
      do {
        // Long (prepared) writes arrive as several requests with offsets, in
        // order; appending in array order is correct for a byte stream.
        let messages = try entry.reassembler.feed(value)
        for message in messages {
          handle(message: message, from: entry, in: session)
        }
      } catch {
        refuse(entry, in: session, reason: "oversize or bad frame length")
        result = .invalidAttributeValueLength
      }
    }
    // One response per batch, on the first request (CBPeripheralManager
    // contract). CoreBluetooth ignores it for write-without-response requests,
    // which it cannot distinguish for us on CBATTRequest.
    pm.respond(to: first, withResult: result)
  }

  func peripheralManagerIsReady(toUpdateSubscribers pm: CBPeripheralManager) {
    dispatchPrecondition(condition: .onQueue(queue))
    if let payer = activePayer, let ack = payer.ackChar { flushPayerIndications(ack); return }
    flushIndications()
  }
}

// MARK: - CBCentralManagerDelegate (payer) -- forwards to the active send

extension BleEngine: CBCentralManagerDelegate {
  func centralManagerDidUpdateState(_ cm: CBCentralManager) {
    dispatchPrecondition(condition: .onQueue(queue))
    os_log("central manager state=%{public}@", log: bleLog, type: .default, Self.describe(cm.state))
    stateChanged(cm.state)
    activeSend?.managerStateChanged(cm.state)
    activeScan?.managerStateChanged(cm.state)
  }

  func centralManager(_ cm: CBCentralManager, didDiscover peripheral: CBPeripheral,
                      advertisementData: [String: Any], rssi RSSI: NSNumber) {
    dispatchPrecondition(condition: .onQueue(queue))
    activeSend?.didDiscover(peripheral, rssi: RSSI)
    activeScan?.didDiscover(peripheral, rssi: RSSI)
  }

  func centralManager(_ cm: CBCentralManager, didConnect peripheral: CBPeripheral) {
    dispatchPrecondition(condition: .onQueue(queue))
    activeSend?.didConnect(peripheral)
    activeScan?.didConnect(peripheral)
  }

  func centralManager(_ cm: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
    dispatchPrecondition(condition: .onQueue(queue))
    activeSend?.didFailToConnect(peripheral, error: error)
    activeScan?.didFailToConnect(peripheral, error: error)
  }

  func centralManager(_ cm: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
    dispatchPrecondition(condition: .onQueue(queue))
    activeSend?.didDisconnect(peripheral, error: error)
    activeScan?.didDisconnect(peripheral, error: error)
  }
}

// MARK: - One payer-side send (spec §3, central state machine)

/// Scan → connect → discover → subscribe → HELLO_A → HELLO_B → FRAME → ACK.
/// Owns its own `settled` latch, both timers and the peripheral delegate for
/// the one peripheral it connects to. All callbacks arrive on `engine.queue`
/// because that is the central manager's delegate queue and CBPeripheral
/// delegates inherit it.
private final class OutboundSend: NSObject, CBPeripheralDelegate {
  private enum Stage {
    case scanning, connecting, discoveringServices, discoveringCharacteristics,
         subscribing, sendingHello, awaitingHelloB, writingFrame, awaitingAck
  }

  private weak var engine: BleEngine?
  private let queue: DispatchQueue
  private let instanceName: String
  private let psk: Data
  private let sealed: Data
  private let serviceUuid: CBUUID
  private let promise: Promise<String>

  private var stage: Stage = .scanning
  private(set) var isScanning = false
  private(set) var peripheral: CBPeripheral?
  private var frameChar: CBCharacteristic?
  private var ackChar: CBCharacteristic?
  private var reassembler = BleGattProfile.Reassembler()
  private var helloChunks: [Data] = []
  private var frameChunks: [Data] = []
  private var frameBytes = 0
  private var settled = false
  /// True once the ACK subscription is confirmed: the connect budget is met.
  private var connectPhaseDone = false
  private var wholeTimeout: DispatchWorkItem?
  private var connectTimeout: DispatchWorkItem?
  private let startedAt = DispatchTime.now()
  private var frameStartedAt: DispatchTime?

  init(engine: BleEngine, instanceName: String, psk: Data, sealed: Data, promise: Promise<String>) {
    self.engine = engine
    self.queue = engine.queue
    self.instanceName = instanceName
    self.psk = psk
    self.sealed = sealed
    self.serviceUuid = BleGattProfile.serviceUuid(psk: psk, instanceName: instanceName)
    self.promise = promise
    super.init()
  }

  private func elapsedMs(since start: DispatchTime) -> Int {
    Int((DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1_000_000)
  }

  /// One chunk size for every write on this connection: the SMALLER of the two
  /// CoreBluetooth ceilings.
  ///
  /// `.withoutResponse` is `ATT_MTU − 3` (514 against an Android peripheral
  /// that negotiated 517), but HELLO_A's chunks and the FRAME's first chunk are
  /// written `.withResponse`, whose own ceiling is 512. Handing CoreBluetooth a
  /// 514-byte with-response write invites it to satisfy the request as a
  /// prepare/execute long write -- and the Kotlin peripheral answers a prepared
  /// write `GATT_REQUEST_NOT_SUPPORTED` and calls `refuse(device, "prepared
  /// write")`, which drops the link (the profile never uses long writes; chunks
  /// are <= MTU − 3 by construction, spec §3). Sizing everything by the min
  /// costs 2 bytes per chunk at MTU 517 and nothing at any smaller MTU.
  private static func writeChunkSize(for p: CBPeripheral) -> Int {
    min(p.maximumWriteValueLength(for: .withoutResponse), p.maximumWriteValueLength(for: .withResponse))
  }

  /// Runs on `queue`. `connectTimeoutMs` covers scan + connect + discovery +
  /// subscribe (spec §3 step 8); `timeoutMs` covers the whole exchange.
  func start(timeoutMs: Double, connectTimeoutMs: Double) {
    dispatchPrecondition(condition: .onQueue(queue))
    let whole = DispatchWorkItem { [weak self] in
      self?.settle(.failure(BleGattProfile.error("timed out waiting for peer", code: 12)))
    }
    wholeTimeout = whole
    queue.asyncAfter(deadline: .now() + .milliseconds(max(0, Int(timeoutMs))), execute: whole)

    let connect = DispatchWorkItem { [weak self] in
      guard let self, !self.connectPhaseDone else { return }
      self.settle(.failure(BleGattProfile.error("connect timeout: no route to peer", code: 14)))
    }
    connectTimeout = connect
    queue.asyncAfter(deadline: .now() + .milliseconds(max(0, Int(connectTimeoutMs))), execute: connect)

    if let cm = engine?.centralManager {
      managerStateChanged(cm.state)
    }
  }

  /// Settle latch, as in `HybridLocalPayTransport.sendFrame`: every caller is
  /// on `queue`, so a plain Bool is safe and the precondition enforces it.
  func settle(_ result: Result<String, Error>) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard !settled else { return }
    settled = true
    wholeTimeout?.cancel()
    connectTimeout?.cancel()
    engine?.finishSend(self)
    isScanning = false
    switch result {
    case .success(let ack): promise.resolve(withResult: ack)
    case .failure(let error):
      // Every terminal failure of a send says so in the log, so the hardware
      // rows are positive checks rather than inferences from a missing line.
      os_log("send failed reason=%{public}@", log: bleLog, type: .default, error.localizedDescription)
      promise.reject(withError: error)
    }
  }

  // MARK: Central manager events (forwarded by BleEngine)

  func managerStateChanged(_ state: CBManagerState) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard !settled, stage == .scanning, !isScanning, let cm = engine?.centralManager else { return }
    switch state {
    case .poweredOn:
      isScanning = true
      cm.scanForPeripherals(withServices: [serviceUuid],
                            options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
      os_log("scanning service=%{public}@", log: bleLog, type: .default, serviceUuid.uuidString)
    case .unknown, .resetting:
      break
    case .unauthorized where CBManager.authorization == .notDetermined:
      break
    default:
      settle(.failure(BleGattProfile.error("bluetooth unavailable", code: 16)))
    }
  }

  func didDiscover(_ p: CBPeripheral, rssi: NSNumber) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard !settled, stage == .scanning, let cm = engine?.centralManager else { return }
    // The filter already matched the per-session UUID: first hit is the payee.
    cm.stopScan()
    isScanning = false
    stage = .connecting
    peripheral = p
    p.delegate = self
    os_log("scan hit rssi=%d id=%{public}@ ms=%ld", log: bleLog, type: .default,
           rssi.int32Value, p.identifier.uuidString, elapsedMs(since: startedAt))
    cm.connect(p, options: nil)
  }

  func didConnect(_ p: CBPeripheral) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard !settled, p === peripheral, stage == .connecting else { return }
    stage = .discoveringServices
    os_log("connected id=%{public}@ maxWriteLen=%ld withResponse=%ld chunk=%ld ms=%ld", log: bleLog, type: .default,
           p.identifier.uuidString, p.maximumWriteValueLength(for: .withoutResponse),
           p.maximumWriteValueLength(for: .withResponse), Self.writeChunkSize(for: p),
           elapsedMs(since: startedAt))
    p.discoverServices([serviceUuid])
  }

  func didFailToConnect(_ p: CBPeripheral, error: Error?) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard p === peripheral else { return }
    settle(.failure(error ?? BleGattProfile.error("connect failed", code: 18)))
  }

  func didDisconnect(_ p: CBPeripheral, error: Error?) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard p === peripheral, !settled else { return }
    switch stage {
    case .sendingHello, .awaitingHelloB, .writingFrame, .awaitingAck:
      settle(.failure(BleGattProfile.error("peer disconnected before acking", code: 21)))
    default:
      settle(.failure(error ?? BleGattProfile.error("peer disconnected", code: 19)))
    }
  }

  // MARK: CBPeripheralDelegate

  func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard !settled, stage == .discoveringServices else { return }
    if let error { return settle(.failure(error)) }
    guard let service = p.services?.first(where: { $0.uuid == serviceUuid }) else {
      return settle(.failure(BleGattProfile.error("session service not found on peer", code: 20)))
    }
    stage = .discoveringCharacteristics
    p.discoverCharacteristics([BleGattProfile.frameCharUuid, BleGattProfile.ackCharUuid], for: service)
  }

  func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard !settled, stage == .discoveringCharacteristics, service.uuid == serviceUuid else { return }
    if let error { return settle(.failure(error)) }
    let chars = service.characteristics ?? []
    guard let frame = chars.first(where: { $0.uuid == BleGattProfile.frameCharUuid }),
          let ack = chars.first(where: { $0.uuid == BleGattProfile.ackCharUuid }) else {
      return settle(.failure(BleGattProfile.error("session characteristics not found on peer", code: 20)))
    }
    frameChar = frame
    ackChar = ack
    stage = .subscribing
    p.setNotifyValue(true, for: ack)
  }

  func peripheral(_ p: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard !settled, stage == .subscribing, characteristic.uuid == BleGattProfile.ackCharUuid else { return }
    if let error { return settle(.failure(error)) }
    guard characteristic.isNotifying, let frame = frameChar else {
      return settle(.failure(BleGattProfile.error("peer refused the ack subscription", code: 20)))
    }
    // Connect phase complete (spec §3 step 8): the connect budget no longer applies.
    connectPhaseDone = true
    connectTimeout?.cancel()
    os_log("subscribed ms=%ld", log: bleLog, type: .default, elapsedMs(since: startedAt))

    // HELLO_A, chunked like everything else and written WITH response so the
    // peripheral's reply to the last chunk doubles as delivery confirmation --
    // hence `writeChunkSize`, which respects the with-response ceiling too.
    let framed = BleGattProfile.lengthPrefixed(BleGattProfile.helloA(psk: psk, instanceName: instanceName))
    helloChunks = BleGattProfile.chunks(framed, size: Self.writeChunkSize(for: p))
    stage = .sendingHello
    writeNextHelloChunk(p, frame)
  }

  private func writeNextHelloChunk(_ p: CBPeripheral, _ frame: CBCharacteristic) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard !helloChunks.isEmpty else { return }
    let chunk = helloChunks.removeFirst()
    if helloChunks.isEmpty {
      // HELLO_B may arrive before the write response to this final chunk.
      stage = .awaitingHelloB
    }
    p.writeValue(chunk, for: frame, type: .withResponse)
  }

  func peripheral(_ p: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard !settled, characteristic.uuid == BleGattProfile.frameCharUuid else { return }
    if let error { return settle(.failure(error)) }
    if stage == .sendingHello, let frame = frameChar {
      writeNextHelloChunk(p, frame)
      return
    }
    if stage == .writingFrame {
      // The FRAME's first chunk landed: this is the guaranteed kick that
      // starts the withoutResponse pump for the remaining chunks (and, for a
      // single-chunk frame, moves straight to awaitingAck).
      pumpWrites()
    }
  }

  func peripheral(_ p: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard !settled, characteristic.uuid == BleGattProfile.ackCharUuid else { return }
    if let error { return settle(.failure(error)) }
    guard let value = characteristic.value, !value.isEmpty else { return }
    let messages: [Data]
    do {
      messages = try reassembler.feed(value)
    } catch {
      return settle(.failure(error))
    }
    for message in messages where !settled {
      handle(message: message, on: p)
    }
  }

  private func handle(message: Data, on p: CBPeripheral) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard !message.isEmpty else { return }
    let type = message[message.startIndex]
    let body = Data(message.dropFirst())

    switch (type, stage) {
    case (BleGattProfile.typeHelloB, .awaitingHelloB), (BleGattProfile.typeHelloB, .sendingHello):
      let expected = BleGattProfile.proof(psk: psk, instanceName: instanceName, type: BleGattProfile.typeHelloB)
      guard BleGattProfile.constantTimeEquals(body, expected) else {
        return settle(.failure(BleGattProfile.error("peer failed the session proof", code: 22)))
      }
      os_log("hello verified ms=%ld", log: bleLog, type: .default, elapsedMs(since: startedAt))
      let framed = BleGattProfile.lengthPrefixed(BleGattProfile.frameMessage(sealed: sealed))
      frameBytes = framed.count
      // `writeChunkSize`, not the withoutResponse ceiling: chunk 0 goes
      // `.withResponse` (see writeFirstFrameChunk) and must stay within the
      // with-response limit or the peer sees a prepared write.
      frameChunks = BleGattProfile.chunks(framed, size: Self.writeChunkSize(for: p))
      frameStartedAt = DispatchTime.now()
      stage = .writingFrame
      writeFirstFrameChunk()

    // Both stages accept the ACK, as the Kotlin twin's `frameOnWire` gate does:
    // the payee may indicate its ack before the last withoutResponse chunk's
    // completion has walked us to `.awaitingAck`, and dropping it there would
    // strand a payment the payee has already queued (the whole-send timeout
    // would then reject and JS would fall to the fountain). An ACK that
    // arrives BEFORE the FRAME was written still falls through to `default`:
    // its MAC proves only that the peer holds the PSK, not that it received
    // anything.
    case (BleGattProfile.typeAck, .awaitingAck), (BleGattProfile.typeAck, .writingFrame):
      guard body.count > BleGattProfile.macLength else {
        return settle(.failure(BleGattProfile.error("peer failed the session proof", code: 22)))
      }
      let json = Data(body.prefix(body.count - BleGattProfile.macLength))
      let mac = Data(body.suffix(BleGattProfile.macLength))
      let expected = BleGattProfile.ackMac(psk: psk, instanceName: instanceName, ackJson: json)
      guard BleGattProfile.constantTimeEquals(mac, expected) else {
        return settle(.failure(BleGattProfile.error("peer failed the session proof", code: 22)))
      }
      os_log("ack verified bytes=%ld ms=%ld", log: bleLog, type: .default, json.count, elapsedMs(since: startedAt))
      // MAC stripped: JS's parseAck sees exactly the AWDL/Nearby ack JSON.
      settle(.success(json.base64EncodedString()))

    default:
      // Once the FRAME is on the wire the payee may already have queued the
      // payment, so nothing unexpected here may reject: doing so would drop a
      // paid session onto the fountain. Only a bad ACK MAC (above) or a
      // timeout settles a failure from these two stages.
      if stage == .writingFrame || stage == .awaitingAck {
        os_log("unexpected message ignored type=%d bytes=%ld", log: bleLog, type: .default,
               Int32(type), body.count)
        return
      }
      settle(.failure(BleGattProfile.error("peer failed the session proof", code: 22)))
    }
  }

  /// The FRAME's first chunk, written WITH response. `canSendWriteWithoutResponse`
  /// may be false the instant HELLO_B lands, and CoreBluetooth's contract for
  /// `peripheralIsReady(toSendWriteWithoutResponse:)` is "ready *again*" -- it
  /// is not guaranteed to fire when the flag was never observed true, so a
  /// withoutResponse pump can make no progress at all until the 20 s whole-send
  /// timeout. The write response to this one chunk is that guaranteed
  /// continuation; every remaining chunk stays withoutResponse under the
  /// existing backpressure, so the cost is one round trip per send.
  private func writeFirstFrameChunk() {
    dispatchPrecondition(condition: .onQueue(queue))
    guard !settled, stage == .writingFrame, let p = peripheral, let frame = frameChar,
          !frameChunks.isEmpty else { return }
    let chunk = frameChunks.removeFirst()
    os_log("frame first chunk bytes=%ld remaining=%ld", log: bleLog, type: .default,
           chunk.count, frameChunks.count)
    p.writeValue(chunk, for: frame, type: .withResponse)
  }

  /// Write-without-response with real backpressure (spec §3 step 6): stop
  /// when CoreBluetooth's buffer is full, resume from
  /// `peripheralIsReady(toSendWriteWithoutResponse:)`. No pacing sleeps.
  private func pumpWrites() {
    dispatchPrecondition(condition: .onQueue(queue))
    guard !settled, stage == .writingFrame, let p = peripheral, let frame = frameChar else { return }
    while !frameChunks.isEmpty {
      guard p.canSendWriteWithoutResponse else { return }
      let chunk = frameChunks.removeFirst()
      p.writeValue(chunk, for: frame, type: .withoutResponse)
    }
    stage = .awaitingAck
    let ms = frameStartedAt.map { elapsedMs(since: $0) } ?? 0
    os_log("frame written bytes=%ld ms=%ld", log: bleLog, type: .default, frameBytes, ms)
  }

  func peripheralIsReady(toSendWriteWithoutResponse p: CBPeripheral) {
    dispatchPrecondition(condition: .onQueue(queue))
    pumpWrites()
  }
}
