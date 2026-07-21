import ExpoModulesCore

private final class NativeSecpError: Exception {
  private let message: String
  init(_ message: String) {
    self.message = message
    super.init()
  }
  override var reason: String { message }
}

public class NativeSecp256k1Module: Module {
  public func definition() -> ModuleDefinition {
    Name("NativeSecp256k1")

    // Synchronous functions only — BSV PrivateKey.sign is sync.
    Function("isAvailable") { () -> Bool in
      true
    }

    Function("ecdsaSign") { (msg32: Data, priv32: Data) throws -> Data in
      var error: NSError?
      guard let result = NativeSecp256k1Bridge.ecdsaSignMsg32(msg32, priv32: priv32, error: &error) else {
        throw NativeSecpError(error?.localizedDescription ?? "ecdsaSign failed")
      }
      return result
    }

    Function("ecdsaVerify") { (msg32: Data, sig64: Data, pub33: Data) -> Bool in
      NativeSecp256k1Bridge.ecdsaVerifyMsg32(msg32, sig64: sig64, pub33: pub33)
    }

    Function("pubkeyCreate") { (priv32: Data) throws -> Data in
      var error: NSError?
      guard let result = NativeSecp256k1Bridge.pubkeyCreatePriv32(priv32, error: &error) else {
        throw NativeSecpError(error?.localizedDescription ?? "pubkeyCreate failed")
      }
      return result
    }
  }
}
