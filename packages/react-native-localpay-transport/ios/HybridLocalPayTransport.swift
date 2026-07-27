import Foundation
import Network

final class HybridLocalPayTransport: HybridLocalPayTransportSpec {
  private var listener: NWListener?
  private var live: [NWConnection] = []
  private let queue = DispatchQueue(label: "org.bsvassociation.localpay")

  /// Genuine capability probe. The podspec's deployment target (iOS 15.1) already
  /// implies Network.framework peer-to-peer APIs exist, so an `#available(iOS 15.0, *)`
  /// check can never evaluate false -- it would be dead code asserting support
  /// unconditionally. Instead, build the actual TLS-PSK + peer-to-peer parameter
  /// stack this transport uses and attempt to construct a listener from it:
  /// `NWListener(using:)` validates the protocol stack synchronously and throws
  /// if the parameter combination can't be realized on this device, so a real
  /// failure (unlike the old check) is observable here.
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
    do {
      let params = AwdlSession.parameters(psk: psk, identity: identity)
      let l = try NWListener(using: params)
      l.service = NWListener.Service(name: instanceName, type: AwdlSession.serviceType)
      l.newConnectionHandler = { [weak self] conn in
        guard let self else { return }
        self.live.append(conn)
        conn.start(queue: self.queue)
        AwdlSession.readFrame(on: conn) { result in
          switch result {
          case .success(let data):
            onFrame(data.base64EncodedString())
            let ack = AwdlSession.lengthPrefixed(Data("{\"ok\":true}".utf8))
            conn.send(content: ack, completion: .contentProcessed { _ in conn.cancel() })
          case .failure(let error):
            onError(error.localizedDescription)
            conn.cancel()
          }
        }
      }
      l.stateUpdateHandler = { state in
        if case .failed(let error) = state { onError(error.localizedDescription) }
      }
      l.start(queue: queue)
      listener = l
      promise.resolve(withResult: ())
    } catch {
      promise.reject(withError: error)
    }
    return promise
  }

  func stopListening() throws -> Promise<Void> {
    let promise = Promise<Void>()
    listener?.cancel()
    listener = nil
    live.forEach { $0.cancel() }
    live.removeAll()
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
    let settle: (Result<String, Error>) -> Void = { result in
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
