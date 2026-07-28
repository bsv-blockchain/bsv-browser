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
  /// The accepted connection whose frame has been handed to JS but not yet
  /// acknowledged. Held open -- deliberately un-acked -- until JS calls
  /// `confirmFrame`. See that method for why delivery and acknowledgement are
  /// two separate steps. Confined to `queue` like everything else here.
  private var pendingAck: NWConnection?
  /// Reaper for `pendingAck`. Same cancellation discipline as `readTimeouts`:
  /// whichever of the timeout and the confirm runs first takes the entry by
  /// clearing `pendingAck`, and the other bails.
  private var pendingAckTimeout: DispatchWorkItem?
  private let queue = DispatchQueue(label: "org.bsvassociation.localpay")

  /// Ceiling on how long an accepted-but-not-yet-completed inbound connection
  /// is retained. TCP accept happens before the TLS-PSK handshake and the
  /// framed read resolve, so a peer that connects (with or without a valid
  /// PSK) and then stalls would otherwise be retained in `live` forever --
  /// a resource-exhaustion vector against payment code on an open local
  /// network. Named so the value only needs stating once.
  private static let acceptedConnectionReadTimeout: DispatchTimeInterval = .seconds(30)

  /// Ceiling on how long the accepted connection is held open waiting for JS
  /// to call `confirmFrame`. A JS crash, a backgrounded app or a wedged
  /// storage write must not leak the socket.
  ///
  /// Deliberately LONGER than the payer's own `sendFrame` timeout (20s, see
  /// SEND_TIMEOUT_MS in utils/localpay/transport/awdl.ts), and expiry tears
  /// the connection down SILENTLY -- it never synthesises a negative ack.
  /// Both properties matter: a negative ack instructs the payer to release
  /// the inputs its `noSend` action is holding, and a payee that is merely
  /// slow to commit may still succeed, at which point those inputs are free
  /// to be respent into a transaction that conflicts with the one the payee
  /// is about to broadcast. Staying silent instead drops the payer onto its
  /// existing "delivered, unconfirmed" path, which neither aborts nor
  /// broadcasts -- the strictly safer of the two failure modes.
  private static let pendingAckConfirmTimeout: DispatchTimeInterval = .seconds(60)

  /// `{"ok":false,"error":<reason>}` with `reason` correctly escaped.
  ///
  /// `reason` originates in JS and is not a literal we control, so it is
  /// serialized rather than interpolated: a raw quote, backslash or newline
  /// interpolated into the literal would produce a payload the payer's
  /// `JSON.parse` rejects. The payer treats an unparseable ack as a transport
  /// fault (AckError) rather than a decline -- so it would NOT release its
  /// inputs, turning a clean decline into a stuck `noSend` action.
  private static func declineJson(reason: String) -> String {
    let fallback = "{\"ok\":false,\"error\":\"declined\"}"
    let text = reason.isEmpty ? "declined" : reason
    guard let data = try? JSONSerialization.data(withJSONObject: ["ok": false, "error": text]),
          let json = String(data: data, encoding: .utf8) else {
      return fallback
    }
    return json
  }

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
      self.pendingAckTimeout?.cancel()
      self.pendingAckTimeout = nil
      self.pendingAck = nil
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

        // Arm the hold BEFORE handing the frame over. No ack is sent here:
        // `conn` stays open and stays in `live` until JS calls
        // `confirmFrame`, because only JS knows whether the payment was
        // durably queued. See confirmFrame.
        //
        // Ordering is deliberate. Nitro dispatches `onFrame` to the JS
        // runtime rather than running it inline on this queue, so JS cannot
        // in practice call back in before the next statement -- but arming
        // first makes that an invariant rather than a dependency on callback
        // scheduling. Confirming into a nil `pendingAck` is a silent no-op
        // that would strand the payer.
        self.pendingAck = conn
        let ackTimeout = DispatchWorkItem { [weak self] in
          guard let self else { return }
          dispatchPrecondition(condition: .onQueue(self.queue))
          // Same take-the-entry gate as the read timeout above: if the
          // confirm already ran it cleared `pendingAck` (and cancelled this
          // item), so anything else here would be acting on a dead socket.
          guard self.pendingAck === conn else { return }
          self.pendingAck = nil
          self.pendingAckTimeout = nil
          self.live.removeValue(forKey: key)
          conn.cancel()
          // No ack, by design (see pendingAckConfirmTimeout). onError is only
          // a native-side record -- JS has long since settled its receive()
          // promise, so this cannot flip a settled screen.
          onError("payee never confirmed the payment; connection released")
        }
        self.pendingAckTimeout = ackTimeout
        self.queue.asyncAfter(deadline: .now() + Self.pendingAckConfirmTimeout, execute: ackTimeout)

        onFrame(data.base64EncodedString())
      case .failure(let error):
        self.live.removeValue(forKey: key)
        onError(error.localizedDescription)
        conn.cancel()
      }
    }
  }

  /// Sends the ack on the connection held open since `onFrame`, then tears the
  /// session down.
  ///
  /// `accepted: true` sends `{"ok":true}` and must be called only once the
  /// payment is durably queued -- that is the whole point of splitting this
  /// out of `acceptConnection`. `accepted: false` sends
  /// `{"ok":false,"error":reason}`, which tells the payer nothing was queued
  /// and it may release the inputs its `noSend` action is holding; only send
  /// it where that is provably true.
  ///
  /// Idempotent: with no held connection (the confirm timeout already fired,
  /// `stopListening` already ran, or JS is confirming twice) it resolves and
  /// does nothing. Rejects only when the ack could not be written.
  func confirmFrame(accepted: Bool, reason: String) throws -> Promise<Void> {
    let promise = Promise<Void>()
    // Called from the JS-bridge thread, never from `queue` itself, so
    // `queue.sync` here cannot deadlock. Doing the bookkeeping synchronously
    // also fixes the ordering against a `stopListening()` that JS may issue
    // immediately afterwards: by the time this returns, `conn` is out of
    // `live`, so that teardown cannot cancel the socket the ack is on.
    queue.sync {
      self.pendingAckTimeout?.cancel()
      self.pendingAckTimeout = nil
      guard let conn = self.pendingAck else {
        promise.resolve(withResult: ())
        return
      }
      self.pendingAck = nil
      self.live.removeValue(forKey: ObjectIdentifier(conn))

      // This session is over either way. The listener was already cancelled
      // at accept time; clear the rest so a `startListening` that is never
      // preceded by `stopListening` cannot inherit stale bookkeeping.
      self.listener?.cancel()
      self.listener = nil
      self.live.values.forEach { $0.cancel() }
      self.live.removeAll()
      self.readTimeouts.values.forEach { $0.cancel() }
      self.readTimeouts.removeAll()

      let body = accepted ? "{\"ok\":true}" : Self.declineJson(reason: reason)
      conn.send(content: AwdlSession.lengthPrefixed(Data(body.utf8)), completion: .contentProcessed { error in
        // NWConnection dispatches send completions on the queue the
        // connection was started with, which is `queue` for everything
        // `acceptConnection` accepts.
        dispatchPrecondition(condition: .onQueue(self.queue))
        conn.cancel()
        if let error {
          promise.reject(withError: error)
        } else {
          promise.resolve(withResult: ())
        }
      })
    }
    return promise
  }

  func stopListening() throws -> Promise<Void> {
    let promise = Promise<Void>()
    // Called from the JS-bridge thread, never from `queue` itself.
    //
    // This cancels a connection still held for `confirmFrame`, so JS must not
    // call it on the success path -- see the `teardown` flag in
    // utils/localpay/transport/awdl.ts. `acceptConnection` already cancels the
    // listener itself the instant a frame is accepted, so there is nothing
    // left for this to do there anyway.
    queue.sync {
      self.listener?.cancel()
      self.listener = nil
      self.pendingAckTimeout?.cancel()
      self.pendingAckTimeout = nil
      self.pendingAck = nil
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
