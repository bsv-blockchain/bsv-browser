import Foundation
import Network

final class HybridLocalPayTransport: HybridLocalPayTransportSpec {
  func isSupported() throws -> Bool {
    if #available(iOS 15.0, *) { return true }
    return false
  }
}
