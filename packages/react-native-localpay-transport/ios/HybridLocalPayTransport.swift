import Foundation
import Network

final class HybridLocalPayTransport: HybridLocalPayTransportSpec {
  // MARK: - State confined to `queue`
  //
  // Network.framework invokes every callback in this file (the listener's
  // `newConnectionHandler`/`stateUpdateHandler`, and every `NWConnection`'s
  // `receive`/`send` completions and `stateUpdateHandler`) on the queue that
  // was passed to that object's `start(queue:)` -- which is always `queue`
  // below, for both the listener and every connection it accepts, and for the
  // outbound connection in `sendFrame`. The public methods
  // (`startListening`/`stopListening`) are instead invoked from whatever
  // thread the JS bridge calls in on, which is NOT `queue`. So there are two
  // real threads that can touch this state, and every touch is confined to
  // `queue` on purpose: public entry points that mutate state wrap the
  // mutation in `queue.sync` (safe: they are never called while already on
  // `queue`), and code that Network.framework itself invokes -- already
  // running on `queue` -- touches the state directly, since dispatching to
  // (or synchronously re-entering) `queue` from there is unnecessary and
  // `queue.sync` from within `queue` would deadlock a serial queue.
  private var listener: NWListener?
  private var live: [ObjectIdentifier: NWConnection] = [:]
  private var readTimeouts: [ObjectIdentifier: DispatchWorkItem] = [:]
  /// First-success-wins latch for the current `startListening` session. Set
  /// the instant a frame is validated, before the ack is even sent, so a
  /// second inbound connection completing its own `readFrame` in the window
  /// before JS gets around to calling `stopListening()` can never be
  /// mistaken for a second successful payment (see Critical 1 in review).
  private var hasAccepted = false
  private let queue = DispatchQueue(label: "org.bsvassociation.localpay")

  /// Ceiling on how long an accepted-but-not-yet-completed inbound connection
  /// is retained. TCP accept happens before the TLS-PSK handshake and the
  /// framed read resolve, so a peer that connects (with or without a valid
  /// PSK) and then stalls would otherwise be retained in `live` forever --
  /// a resource-exhaustion vector against payment code on an open local
  /// network. Named so the value only needs stating once.
  private static let acceptedConnectionReadTimeout: DispatchTimeInterval = .seconds(30)

  /// Genuine capability probe. The podspec's deployment target (iOS 15.1) already
  /// implies Network.framework peer-to-peer APIs exist, so an `#available(iOS 15.0, *)`
  /// check can never evaluate false -- it would be dead code asserting support
  /// unconditionally. Instead, build the actual TLS-PSK + peer-to-peer parameter
  /// stack this transport uses and attempt to construct a listener from it:
  /// `NWListener(using:)` validates the protocol stack synchronously and throws
  /// if the parameter combination can't be realized on this device, so a real
  /// failure (unlike the old check) is observable here. This probe never touches
  /// `listener`/`live`/`hasAccepted`, so it needs no queue confinement.
  func isSupported() throws -> Bool {
    let probePsk = Data(repeating: 0, count: 32)
    guard let probeIdentity = "probe".data(using: .utf8) else { return false }
    let params = AwdlSession.parameters(psk: probePsk, identity: probeIdentity)
    do {
      _ = try NWListener(using: params)
      return true
    } catch {
      return false
    }
  }

  func startListening(
    instanceName: String,
    pskBase64: String,
    onFrame: @escaping (String) -> Void,
    onError: @escaping (String) -> Void
  ) throws -> Promise<Void> {
    let promise = Promise<Void>()
    guard let psk = Data(base64Encoded: pskBase64),
          let identity = instanceName.data(using: .utf8) else {
      promise.reject(withError: NSError(domain: "LocalPayTransport", code: 10,
        userInfo: [NSLocalizedDescriptionKey: "bad psk or instance name"]))
      return promise
    }

    // Called from the JS-bridge thread, never from `queue` itself, so
    // `queue.sync` here cannot deadlock. Everything that reads or mutates
    // `listener`/`live`/`readTimeouts`/`hasAccepted` happens inside this block.
    queue.sync {
      // Reset per-session state so first-success-wins and the resource bounds
      // below start fresh each time listening (re)starts, even if a previous
      // session's listener/connections were never explicitly stopped.
      self.listener?.cancel()
      self.live.values.forEach { $0.cancel() }
      self.live.removeAll()
      self.readTimeouts.values.forEach { $0.cancel() }
      self.readTimeouts.removeAll()
      self.hasAccepted = false

      do {
        let params = AwdlSession.parameters(psk: psk, identity: identity)
        let l = try NWListener(using: params)
        l.service = NWListener.Service(name: instanceName, type: AwdlSession.serviceType)
        l.newConnectionHandler = { [weak self] conn in
          // Network.framework calls this on `queue` (the queue passed to
          // `l.start(queue:)` below), so touching `self`'s state directly
          // here -- via `acceptConnection` -- is already safe.
          guard let self else { return }
          self.acceptConnection(conn, onFrame: onFrame, onError: onError)
        }
        l.stateUpdateHandler = { state in
          if case .failed(let error) = state { onError(error.localizedDescription) }
        }
        l.start(queue: self.queue)
        self.listener = l
        promise.resolve(withResult: ())
      } catch {
        promise.reject(withError: error)
      }
    }
    return promise
  }

  /// Runs only on `queue` (invoked exclusively from `newConnectionHandler`,
  /// which Network.framework dispatches on `queue`). Owns first-success-wins
  /// and the per-connection bookkeeping (`live`, per-connection read timeout).
  private func acceptConnection(
    _ conn: NWConnection,
    onFrame: @escaping (String) -> Void,
    onError: @escaping (String) -> Void
  ) {
    let key = ObjectIdentifier(conn)
    live[key] = conn
    conn.start(queue: queue)

    // Per-connection read timeout, mirroring sendFrame's timeout on the
    // sender side: if this peer never completes a framed read, drop it
    // instead of retaining it forever. Deliberately silent (no onError) --
    // a stray/probing connection against the Bonjour advertisement is not
    // the same as a failed payment attempt, and the shared onError callback
    // is scoped to the one accepted payment per session.
    let timeout = DispatchWorkItem { [weak self] in
      guard let self else { return }
      dispatchPrecondition(condition: .onQueue(self.queue))
      self.live.removeValue(forKey: key)
      self.readTimeouts.removeValue(forKey: key)
      conn.cancel()
    }
    readTimeouts[key] = timeout
    queue.asyncAfter(deadline: .now() + Self.acceptedConnectionReadTimeout, execute: timeout)

    AwdlSession.readFrame(on: conn) { [weak self] result in
      // Also on `queue`: NWConnection dispatches `receive` completions on
      // the queue it was started with, which is `queue` for every
      // connection accepted here.
      guard let self else { return }
      dispatchPrecondition(condition: .onQueue(self.queue))

      // The read timeout and this completion are two independently
      // scheduled callbacks feeding the same serial queue, with no shared
      // gate between them otherwise. Removing our own entry from
      // `readTimeouts` doubles as that gate, mirroring `settled` in
      // `sendFrame`: whichever of the two runs first "wins" by taking the
      // entry, and the other must bail. If it's already gone here, the
      // timeout fired first, already reaped `live`, and already cancelled
      // `conn` -- so bail before touching `result` at all. Neither success
      // nor failure may proceed on a connection the timeout already
      // terminated (a `.success` here would otherwise call `onFrame` with
      // real payment data for a connection whose ack send is doomed to
      // fail, telling the payee's JS layer it holds a payment before the
      // ack failure is even reported).
      guard let timeoutItem = self.readTimeouts.removeValue(forKey: key) else {
        return
      }
      timeoutItem.cancel()

      switch result {
      case .success(let data):
        // First-success-wins, made an invariant of the native layer rather
        // than relying on JS calling stopListening() from inside its own
        // onFrame handler (a cross-bridge round trip that cannot be atomic
        // with the native accept loop). This check-and-set, and the
        // listener cancellation right after it, run synchronously on
        // `queue`, so they are atomic with respect to every other
        // connection's completion handler -- a second inbound connection
        // that also finishes `readFrame` in this window is cancelled below
        // with no ack and no `onFrame`, never falsely acked as a real-money
        // success.
        guard !self.hasAccepted else {
          self.live.removeValue(forKey: key)
          conn.cancel()
          return
        }
        self.hasAccepted = true
        // Stop advertising immediately so no further connection can even be
        // accepted, rather than waiting for JS to round-trip stopListening().
        self.listener?.cancel()
        self.listener = nil

        onFrame(data.base64EncodedString())
        let ack = AwdlSession.lengthPrefixed(Data("{\"ok\":true}".utf8))
        conn.send(content: ack, completion: .contentProcessed { [weak self] error in
          guard let self else { return }
          if let error {
            // The frame was already handed to JS via onFrame, so the payee's
            // JS layer believes it holds the payment. If the ack never
            // reached the payer, the payer's sendFrame will time out
            // believing nothing arrived -- surface this instead of
            // swallowing it, so there is at least a native-side record of
            // the mismatch.
            onError(error.localizedDescription)
          }
          self.live.removeValue(forKey: key)
          conn.cancel()
        })
      case .failure(let error):
        self.live.removeValue(forKey: key)
        onError(error.localizedDescription)
        conn.cancel()
      }
    }
  }

  func stopListening() throws -> Promise<Void> {
    let promise = Promise<Void>()
    // Called from the JS-bridge thread, never from `queue` itself.
    queue.sync {
      self.listener?.cancel()
      self.listener = nil
      self.live.values.forEach { $0.cancel() }
      self.live.removeAll()
      self.readTimeouts.values.forEach { $0.cancel() }
      self.readTimeouts.removeAll()
    }
    promise.resolve(withResult: ())
    return promise
  }

  func sendFrame(
    instanceName: String,
    pskBase64: String,
    frameBase64: String,
    timeoutMs: Double
  ) throws -> Promise<String> {
    let promise = Promise<String>()
    guard let psk = Data(base64Encoded: pskBase64),
          let payload = Data(base64Encoded: frameBase64),
          let identity = instanceName.data(using: .utf8) else {
      promise.reject(withError: NSError(domain: "LocalPayTransport", code: 11,
        userInfo: [NSLocalizedDescriptionKey: "bad psk or frame"]))
      return promise
    }

    let params = AwdlSession.parameters(psk: psk, identity: identity)
    let endpoint = NWEndpoint.service(
      name: instanceName, type: AwdlSession.serviceType, domain: "local", interface: nil
    )
    let conn = NWConnection(to: endpoint, using: params)

    var settled = false
    // `settled` is a plain local `Bool`, not an `@Atomic`/locked value: that
    // is only safe because every call site below (the asyncAfter timeout,
    // the connection's stateUpdateHandler, the send completion, and
    // AwdlSession.readFrame's completion) is guaranteed by Network.framework
    // to run on `queue` -- the queue `conn` is started with at the bottom of
    // this function, and the same queue the timeout is scheduled onto. This
    // was previously true by accident of how the callbacks happened to be
    // wired up; `dispatchPrecondition` below makes the confinement an
    // enforced, deliberate invariant instead, so a future refactor that
    // moves one of these callbacks off `queue` fails loudly rather than
    // silently reintroducing a race.
    let settle: (Result<String, Error>) -> Void = { result in
      dispatchPrecondition(condition: .onQueue(self.queue))
      guard !settled else { return }
      settled = true
      switch result {
      case .success(let ack): promise.resolve(withResult: ack)
      case .failure(let error): promise.reject(withError: error)
      }
      conn.cancel()
    }

    queue.asyncAfter(deadline: .now() + .milliseconds(Int(timeoutMs))) {
      settle(.failure(NSError(domain: "LocalPayTransport", code: 12,
        userInfo: [NSLocalizedDescriptionKey: "timed out waiting for peer"])))
    }

    conn.stateUpdateHandler = { state in
      switch state {
      case .ready:
        conn.send(content: AwdlSession.lengthPrefixed(payload), completion: .contentProcessed { error in
          if let error { return settle(.failure(error)) }
          AwdlSession.readFrame(on: conn) { result in
            switch result {
            case .success(let ack): settle(.success(ack.base64EncodedString()))
            case .failure(let error): settle(.failure(error))
            }
          }
        })
      case .failed(let error):
        settle(.failure(error))
      case .cancelled:
        settle(.failure(NSError(domain: "LocalPayTransport", code: 13,
          userInfo: [NSLocalizedDescriptionKey: "connection cancelled"])))
      default:
        break
      }
    }
    conn.start(queue: queue)
    return promise
  }
}
