import Foundation
import Network
import Security

enum AwdlSession {
  static let serviceType = "_bsvpay._tcp"

  /// TCP over AWDL, authenticated and encrypted with a pre-shared key.
  /// Only a peer that saw the pairing QR holds the PSK, so this is mutual auth.
  static func parameters(psk: Data, identity: Data) -> NWParameters {
    let tls = NWProtocolTLS.Options()
    let opts = tls.securityProtocolOptions
    psk.withUnsafeBytes { pskBuf in
      identity.withUnsafeBytes { idBuf in
        let pskData = DispatchData(bytes: pskBuf)
        let idData = DispatchData(bytes: idBuf)
        sec_protocol_options_add_pre_shared_key(
          opts,
          pskData as __DispatchData,
          idData as __DispatchData
        )
      }
    }
    sec_protocol_options_append_tls_ciphersuite(
      opts,
      tls_ciphersuite_t(rawValue: TLS_PSK_WITH_AES_128_GCM_SHA256)!
    )
    let params = NWParameters(tls: tls)
    params.includePeerToPeer = true
    return params
  }

  /// 4-byte big-endian length prefix, so a stream yields discrete frames.
  static func lengthPrefixed(_ payload: Data) -> Data {
    var out = Data(count: 4)
    let n = UInt32(payload.count).bigEndian
    withUnsafeBytes(of: n) { out.replaceSubrange(0..<4, with: $0) }
    out.append(payload)
    return out
  }

  static func readFrame(on conn: NWConnection, completion: @escaping (Result<Data, Error>) -> Void) {
    conn.receive(minimumIncompleteLength: 4, maximumLength: 4) { header, _, _, error in
      if let error { return completion(.failure(error)) }
      guard let header, header.count == 4 else {
        return completion(.failure(NSError(domain: "LocalPayTransport", code: 1,
          userInfo: [NSLocalizedDescriptionKey: "short header"])))
      }
      let length = Int(header.withUnsafeBytes { $0.load(as: UInt32.self).bigEndian })
      guard length > 0, length <= 8 * 1024 * 1024 else {
        return completion(.failure(NSError(domain: "LocalPayTransport", code: 2,
          userInfo: [NSLocalizedDescriptionKey: "frame length out of range: \(length)"])))
      }
      conn.receive(minimumIncompleteLength: length, maximumLength: length) { body, _, _, error in
        if let error { return completion(.failure(error)) }
        guard let body, body.count == length else {
          return completion(.failure(NSError(domain: "LocalPayTransport", code: 3,
            userInfo: [NSLocalizedDescriptionKey: "short body"])))
        }
        completion(.success(body))
      }
    }
  }
}
