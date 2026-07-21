package expo.modules.nativesecp256k1

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class NativeSecp256k1Module : Module() {
  companion object {
    private val libraryLoaded: Boolean =
      try {
        System.loadLibrary("native-secp256k1")
        true
      } catch (_: UnsatisfiedLinkError) {
        // Soft-fail: isAvailable() reports false when the .so is missing.
        false
      }

    @JvmStatic
    private external fun nativeEcdsaSign(msg32: ByteArray, priv32: ByteArray): ByteArray

    @JvmStatic
    private external fun nativeEcdsaVerify(
      msg32: ByteArray,
      sig64: ByteArray,
      pub33: ByteArray
    ): Boolean

    @JvmStatic
    private external fun nativePubkeyCreate(priv32: ByteArray): ByteArray
  }

  override fun definition() = ModuleDefinition {
    Name("NativeSecp256k1")

    Function("isAvailable") {
      libraryLoaded
    }

    Function("ecdsaSign") { msg32: ByteArray, priv32: ByteArray ->
      require(libraryLoaded) { "native-secp256k1 library not loaded" }
      require(msg32.size == 32) { "msg32 must be 32 bytes" }
      require(priv32.size == 32) { "priv32 must be 32 bytes" }
      nativeEcdsaSign(msg32, priv32)
    }

    Function("ecdsaVerify") { msg32: ByteArray, sig64: ByteArray, pub33: ByteArray ->
      require(libraryLoaded) { "native-secp256k1 library not loaded" }
      require(msg32.size == 32) { "msg32 must be 32 bytes" }
      require(sig64.size == 64) { "sig64 must be 64 bytes" }
      require(pub33.size == 33) { "pub33 must be 33 bytes" }
      nativeEcdsaVerify(msg32, sig64, pub33)
    }

    Function("pubkeyCreate") { priv32: ByteArray ->
      require(libraryLoaded) { "native-secp256k1 library not loaded" }
      require(priv32.size == 32) { "priv32 must be 32 bytes" }
      nativePubkeyCreate(priv32)
    }
  }
}
