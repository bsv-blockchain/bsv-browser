package com.margelo.nitro.yubikeypiv

import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.ReactApplicationContext
import com.margelo.nitro.NitroModules
import com.margelo.nitro.core.Promise
import com.yubico.yubikit.android.YubiKitManager
import com.yubico.yubikit.android.transport.nfc.NfcConfiguration
import com.yubico.yubikit.android.transport.nfc.NfcNotAvailable
import com.yubico.yubikit.android.transport.nfc.NfcYubiKeyDevice
import com.yubico.yubikit.android.transport.usb.UsbConfiguration
import com.yubico.yubikit.android.transport.usb.UsbYubiKeyDevice
import com.yubico.yubikit.core.YubiKeyDevice
import com.yubico.yubikit.core.keys.EllipticCurveValues
import com.yubico.yubikit.core.keys.PublicKeyValues
import com.yubico.yubikit.core.smartcard.ApduException
import com.yubico.yubikit.core.smartcard.SmartCardConnection
// 3.2.0: InvalidPinException lives in core.application, not piv.
import com.yubico.yubikit.core.application.InvalidPinException
import com.yubico.yubikit.piv.KeyType
import com.yubico.yubikit.piv.PinPolicy
import com.yubico.yubikit.piv.PivSession
import com.yubico.yubikit.piv.Slot
import com.yubico.yubikit.piv.TouchPolicy
import java.io.IOException
import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.spec.ECFieldFp
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec

/**
 * YubiKeyPiv over YubiKit-Android's PIV application (CCID).
 *
 * Mirrors the iOS/YubiKit backend's contract exactly (the JS wrapper is
 * shared): discovery streams key-connected / key-removed events to the JS
 * listener, and each Promise-returning method opens a fresh
 * SmartCardConnection → PivSession against the currently-held device, does its
 * one operation, and lets the connection close.
 *
 * Every rejection carries a `VAULT_ERR:<code>:<detail>` message (see
 * `mapError`) so the JS vault layer can branch on a stable machine code rather
 * than parse YubiKit's own English.
 *
 * Discovery bookkeeping (`listener`, `currentDevice`) is confined to the
 * main-thread Handler — YubiKitManager delivers USB/NFC discovery on the main
 * thread and we post everything we initiate onto the same thread, making the
 * discovery state machine single-threaded by construction (the same discipline
 * the Swift side gets from serial completion queues). The per-operation
 * `requestConnection` callbacks run on YubiKit's own executor; they only touch
 * the Promise they were handed, never the shared discovery state.
 */
class HybridYubiKeyPiv : HybridYubiKeyPivSpec() {
  private val main = Handler(Looper.getMainLooper())

  private val manager: YubiKitManager? by lazy {
    val ctx = NitroModules.applicationContext ?: return@lazy null
    YubiKitManager(ctx.applicationContext)
  }

  /** JS listener: (eventType, serial, transport). Confined to `main`. */
  private var listener: ((String, String, String) -> Unit)? = null
  /** The key currently on a reader (USB plugged, or NFC held). Confined to `main`. */
  private var currentDevice: YubiKeyDevice? = null
  private var discovering = false

  // ── discovery ──

  override fun isSupported(): Boolean {
    val ctx = NitroModules.applicationContext ?: return false
    val pm: PackageManager = ctx.packageManager
    val usb = pm.hasSystemFeature(PackageManager.FEATURE_USB_HOST)
    val nfc = pm.hasSystemFeature(PackageManager.FEATURE_NFC)
    return usb || nfc
  }

  override fun startDiscovery() {
    main.post {
      if (discovering) return@post
      val m = manager ?: return@post
      discovering = true

      // USB: the SDK owns the runtime permission dialog. Each plug-in delivers
      // a UsbYubiKeyDevice that stays live until unplugged.
      m.startUsbDiscovery(UsbConfiguration()) { device ->
        main.post { currentDevice = device }
        readSerialAndEmit(device, "usb")
        (device as? UsbYubiKeyDevice)?.setOnClosed {
          main.post {
            if (currentDevice === device) currentDevice = null
            emit("removed", "", "usb")
          }
        }
      }

      // NFC: best-effort. Needs a foreground Activity and an NFC radio; either
      // missing is fine — USB still works and isSupported() stays honest.
      try {
        val activity = (NitroModules.applicationContext as? ReactApplicationContext)?.currentActivity
        if (activity != null) {
          m.startNfcDiscovery(NfcConfiguration(), activity) { device ->
            main.post { currentDevice = device }
            readSerialAndEmit(device, "nfc")
            // An NFC tap is a transient session: when the tag leaves the field
            // we must emit `removed` so the JS layer relocks the PKM, exactly
            // like USB unplug. NfcYubiKeyDevice.remove(...) fires once the tag
            // is gone. Without this the 120s PKM window outlives the tap.
            (device as? NfcYubiKeyDevice)?.remove {
              main.post {
                if (currentDevice === device) currentDevice = null
                emit("removed", "", "nfc")
              }
            }
          }
        }
      } catch (_: NfcNotAvailable) {
        // no NFC on this device — ignore
      } catch (_: Throwable) {
        // any other NFC-start failure is non-fatal for USB-only use
      }
    }
  }

  override fun stopDiscovery() {
    main.post {
      if (!discovering) return@post
      val m = manager
      try { m?.stopUsbDiscovery() } catch (_: Throwable) {}
      try {
        val activity = (NitroModules.applicationContext as? ReactApplicationContext)?.currentActivity
        if (activity != null) m?.stopNfcDiscovery(activity)
      } catch (_: Throwable) {}
      currentDevice = null
      discovering = false
    }
  }

  override fun setKeyListener(listener: (String, String, String) -> Unit) {
    main.post { this.listener = listener }
  }

  override fun clearKeyListener() {
    main.post { this.listener = null }
  }

  private fun emit(eventType: String, serial: String, transport: String) {
    val l = listener ?: return
    main.post { l(eventType, serial, transport) }
  }

  /** Open a throwaway session just to read the serial for a connected event. */
  private fun readSerialAndEmit(device: YubiKeyDevice, transport: String) {
    device.requestConnection(SmartCardConnection::class.java) { result ->
      val serial = try {
        val piv = PivSession(result.value)
        piv.serialNumber.toString()
      } catch (_: Throwable) {
        ""
      }
      emit("connected", serial, transport)
    }
  }

  // ── operations ──

  override fun getKeyInfo(): Promise<String> {
    val promise = Promise<String>()
    withPiv(promise) { piv ->
      val serial = piv.serialNumber
      val v = piv.version
      val retries = try { piv.pinAttempts } catch (_: Throwable) { -1 }
      "{\"serial\":\"$serial\",\"firmwareVersion\":\"${v.major}.${v.minor}.${v.micro}\",\"pinRetries\":$retries}"
    }
    return promise
  }

  override fun verifyPin(pin: String): Promise<String> {
    val promise = Promise<String>()
    withPiv(promise) { piv ->
      try {
        piv.verifyPin(pin.toCharArray())
        "{\"ok\":true,\"retriesLeft\":null}"
      } catch (e: InvalidPinException) {
        // A wrong PIN is a normal, resolvable result for this probe (the spec
        // returns {ok, retriesLeft}); only transport faults reject.
        "{\"ok\":false,\"retriesLeft\":${e.attemptsRemaining}}"
      }
    }
    return promise
  }

  override fun changePin(oldPin: String, newPin: String): Promise<String> {
    val promise = Promise<String>()
    withPiv(promise) { piv ->
      // PIV CHANGE REFERENCE DATA needs only the old PIN — NOT management-key
      // auth. Gating it on the management key would wrongly reject a key that
      // has a custom management key but a still-default PIN.
      try {
        piv.changePin(oldPin.toCharArray(), newPin.toCharArray())
        "{\"ok\":true}"
      } catch (e: InvalidPinException) {
        throw VaultException("pin-invalid", "retries=${e.attemptsRemaining}")
      }
    }
    return promise
  }

  override fun generateVaultKey(slot: Double, touchPolicy: String, pinPolicy: String): Promise<String> {
    val promise = Promise<String>()
    withPiv(promise) { piv ->
      authenticateManagementKey(piv)
      // 3.2.0: generateKey(...) returns PublicKeyValues (generateKeyValues is
      // @Deprecated / removed).
      val pub = piv.generateKey(
        Slot.fromValue(slot.toInt()),
        KeyType.ECCP256,
        toPinPolicy(pinPolicy),
        toTouchPolicy(touchPolicy)
      )
      "{\"publicKey\":\"${(pub as PublicKeyValues.Ec).encodedPoint.toHex()}\"}"
    }
    return promise
  }

  override fun readVaultPublicKey(slot: Double): Promise<String> {
    val promise = Promise<String>()
    withPiv(promise) { piv ->
      try {
        val meta = piv.getSlotMetadata(Slot.fromValue(slot.toInt()))
        val pub = meta.publicKeyValues as PublicKeyValues.Ec
        "{\"publicKey\":\"${pub.encodedPoint.toHex()}\"}"
      } catch (_: ApduException) {
        // Empty slot (reference-data-not-found) is not an error here.
        "{\"publicKey\":null}"
      }
    }
    return promise
  }

  override fun ecdh(slot: Double, pin: String, peerPublicKey: String): Promise<String> {
    val promise = Promise<String>()
    // Decode + shape-check BEFORE any card command so a malformed peer key never
    // burns a PIN retry — the same discipline as signEcdsa's digest check.
    val peerBytes = try {
      hexToBytes(peerPublicKey)
    } catch (t: Throwable) {
      promise.reject(vaultError("template-invalid", "peer public key ${t.message ?: "must be hex"}"))
      return promise
    }
    // fromEncodedPoint derives the coordinate width from the ARRAY length
    // ((len - 1) / 2), not from the curve, so an off-length blob does not fail —
    // it silently yields differently-sized X/Y and therefore a different key.
    // It does reject a missing 0x04 marker, but only by throwing
    // IllegalArgumentException, which inside the block below would land AFTER
    // verifyPin and burn a retry. Both checks therefore happen here.
    if (peerBytes.size != 65 || peerBytes[0] != 0x04.toByte()) {
      promise.reject(
        vaultError(
          "template-invalid",
          "peer public key must be 65-byte SEC1 uncompressed (0x04 || X || Y), got ${peerBytes.size} bytes"
        )
      )
      return promise
    }
    // Invalid-curve defence. Neither the shape check above nor fromEncodedPoint
    // below establishes that the point actually lies ON secp256r1, and handing
    // an off-curve point to a KeyAgreement is the classic invalid-curve attack:
    // the card ends up computing in a small group of the attacker's choosing and
    // the resulting "secret" leaks bits of the slot's private key. The card is
    // expected to reject it as well, but that is the card's guarantee to keep —
    // this one is ours (iOS gets it for free from SecKeyCreateWithData) and it
    // costs two 256-bit modular exponentiations, once per unlock. Runs BEFORE
    // the PIN so a bad point never burns a retry either.
    try {
      requireOnCurveP256(peerBytes)
    } catch (_: Throwable) {
      promise.reject(vaultError("template-invalid", "peer public key is not a point on secp256r1"))
      return promise
    }

    withPiv(promise) { piv ->
      // withPiv opens a FRESH PivSession per call, so the PIN must be verified
      // inside every operation — this is not redundant with an earlier verify.
      piv.verifyPin(pin.toCharArray())
      // calculateSecret takes PublicKeyValues, not a java.security ECPublicKey.
      // Verified with javap against the PINNED piv-3.1.0.jar:
      //   public byte[] calculateSecret(Slot, PublicKeyValues)
      // (3.1.0's piv/core jars are in fact byte-identical to 3.2.0's — same
      // SHA-1 — so only the AAR's minCompileSdk metadata differs, which is why
      // this file's 3.2.0-era API usage is correct on the 3.1.0 pin.)
      val peer = PublicKeyValues.Ec.fromEncodedPoint(EllipticCurveValues.SECP256R1, peerBytes)
      // TOUCH-gated by the slot's touch policy (generateVaultKey now enrolls with
      // ALWAYS): this blocks until the user taps, and an unmet touch surfaces as
      // SW 0x6982/0x6985, which mapError folds into touch-timeout.
      //
      // The result is the RAW x-coordinate of the shared point — 32 bytes, no
      // KDF and no hashing on either side. The vault's sealing layer owns any
      // derivation, so this returns the card's bytes unmodified.
      val secret = piv.calculateSecret(Slot.fromValue(slot.toInt()), peer)
      if (secret.size != 32) {
        // Mirrors iOS and signEcdsa: a short/empty result without a thrown error
        // must not resolve as a "secret" — an under-length x-coordinate would
        // silently derive a wrong seal key.
        throw VaultException("touch-timeout", "no shared secret returned")
      }
      "{\"secret\":\"${secret.toHex()}\"}"
    }
    return promise
  }

  override fun signEcdsa(slot: Double, pin: String, digest: String): Promise<String> {
    val promise = Promise<String>()
    // MUST be exactly 32 bytes: rawSignOrDecrypt silently TRUNCATES an over-long
    // EC payload (Arrays.copyOf to the key's 32-byte length) and left zero-pads a
    // short one, so an off-length digest signs the wrong message rather than
    // failing. Checked BEFORE any card command so a malformed digest never burns
    // a PIN retry.
    val digestBytes = try {
      hexToBytes(digest)
    } catch (t: Throwable) {
      // hexToBytes' message distinguishes odd-length from non-hex-content so
      // this detail doesn't misreport which check actually failed.
      promise.reject(vaultError("template-invalid", "digest ${t.message ?: "must be hex"}"))
      return promise
    }
    if (digestBytes.size != 32) {
      promise.reject(vaultError("template-invalid", "digest must be exactly 32 bytes, got ${digestBytes.size}"))
      return promise
    }

    withPiv(promise) { piv ->
      // withPiv opens a FRESH PivSession per call, so the PIN must be verified
      // inside every operation — this is not redundant with an earlier verify.
      piv.verifyPin(pin.toCharArray())
      // TOUCH-gated by the slot's touch policy; a required-but-unmet touch
      // surfaces as SW 0x6982/0x6985, which mapError folds into touch-timeout.
      // rawSignOrDecrypt sends the digest verbatim (no local hashing/re-encoding)
      // and the card returns raw DER (SEQUENCE { r, s }), NOT low-S normalised —
      // returned here unmodified.
      val der = piv.rawSignOrDecrypt(Slot.fromValue(slot.toInt()), KeyType.ECCP256, digestBytes)
      if (der.isEmpty()) {
        // Mirrors iOS: an empty result without a thrown error should not
        // resolve as a "signature" — surface it as touch-timeout rather than
        // silently returning {"signature":""}.
        throw VaultException("touch-timeout", "no signature returned")
      }
      "{\"signature\":\"${der.toHex()}\"}"
    }
    return promise
  }

  // ── helpers ──

  /**
   * Open a SmartCardConnection → PivSession against the held device, run
   * `block`, resolve; translate any failure to a VAULT_ERR rejection. No held
   * device means no key is on a reader → no-key.
   */
  private fun withPiv(promise: Promise<String>, block: (PivSession) -> String) {
    val device = currentDevice
    if (device == null) {
      promise.reject(vaultError("no-key", "no YubiKey present"))
      return
    }
    device.requestConnection(SmartCardConnection::class.java) { result ->
      try {
        val piv = PivSession(result.value) // result.value throws IOException if the connect failed
        promise.resolve(block(piv))
      } catch (t: Throwable) {
        promise.reject(mapError(t))
      }
    }
  }

  /**
   * Authenticate with the firmware-default management key so generateKey can
   * run. On yubikit-android 3.2.0 `authenticate(byte[])` reads the key's
   * algorithm from card metadata itself, so we pass only the 24-byte default
   * value (the same default for both the pre-5.7 TDES and fw >= 5.7 AES-192
   * cards). A rejection means the key has a custom management key we cannot
   * supply → mgmt-key-custom.
   */
  private fun authenticateManagementKey(piv: PivSession) {
    try {
      piv.authenticate(DEFAULT_MANAGEMENT_KEY)
    } catch (e: Throwable) {
      throw VaultException("mgmt-key-custom", "default management key rejected")
    }
  }

  private fun toTouchPolicy(p: String): TouchPolicy = when (p.lowercase()) {
    "always" -> TouchPolicy.ALWAYS
    "cached" -> TouchPolicy.CACHED
    "never" -> TouchPolicy.NEVER
    else -> TouchPolicy.DEFAULT
  }

  private fun toPinPolicy(p: String): PinPolicy = when (p.lowercase()) {
    "once" -> PinPolicy.ONCE
    "always" -> PinPolicy.ALWAYS
    "never" -> PinPolicy.NEVER
    else -> PinPolicy.DEFAULT
  }

  /** Small carrier so a code path can name its own VAULT_ERR code + detail. */
  private class VaultException(val code: String, val detail: String) : Exception("$code:$detail")

  private fun vaultError(code: String, detail: String): Throwable = Error("VAULT_ERR:$code:$detail")

  private fun mapError(t: Throwable): Throwable = when (t) {
    is VaultException -> Error("VAULT_ERR:${t.code}:${t.detail}")
    is InvalidPinException -> {
      val n = t.attemptsRemaining
      if (n <= 0) Error("VAULT_ERR:pin-locked:no attempts remaining")
      else Error("VAULT_ERR:pin-invalid:retries=$n")
    }
    is ApduException -> {
      when (t.sw.toInt() and 0xffff) {
        0x6983 -> Error("VAULT_ERR:pin-locked:authentication method blocked")
        0x6a88, 0x6a80 -> Error("VAULT_ERR:no-key:reference data not found")
        // 0x6982 (security status not satisfied) / 0x6985 (conditions not
        // satisfied) is what a required-but-unmet touch surfaces as over CCID.
        0x6982, 0x6985 -> Error("VAULT_ERR:touch-timeout:conditions of use not satisfied")
        else -> Error("VAULT_ERR:wrong-key:apdu 0x${Integer.toHexString(t.sw.toInt() and 0xffff)}")
      }
    }
    is IOException -> Error("VAULT_ERR:key-removed-mid-op:${t.message}")
    else -> Error("VAULT_ERR:wrong-key:${t.message}")
  }

  /**
   * Throw unless `point` (65-byte SEC1 uncompressed, already shape-checked) is a
   * point on secp256r1.
   *
   * The equation is checked HERE, in explicit BigInteger arithmetic, rather than
   * by round-tripping the coordinates through
   * `KeyFactory.generatePublic(ECPublicKeySpec)`. That is deliberate and was
   * measured, not assumed: the JCE does NOT promise on-curve validation at
   * key-spec construction, and the JDK's own SunEC provider demonstrably
   * performs none — it accepts a bit-flipped off-curve point and even all-zero
   * coordinates. Conscrypt happens to be stricter, but a security check must not
   * rest on which provider a given OS image ships. Doing the arithmetic makes
   * the guarantee ours on every provider and every API level.
   *
   * Only p, a and b are taken from the JCE (via a named curve, so the domain
   * parameters are never hard-coded here). secp256r1 has cofactor 1, so
   * "on the curve and not the identity" is exactly "in the prime-order
   * subgroup" — no scalar multiplication is needed. The identity has no
   * uncompressed 0x04 encoding, and (0, 0) fails the equation because b != 0.
   *
   * Throws IllegalArgumentException (the same failure mode as `hexToBytes`);
   * the caller maps ANY throwable to template-invalid, so this fails closed.
   */
  private fun requireOnCurveP256(point: ByteArray) {
    val params = AlgorithmParameters.getInstance("EC").run {
      init(ECGenParameterSpec("secp256r1"))
      getParameterSpec(ECParameterSpec::class.java)
    }
    val curve = params.curve
    val p = (curve.field as ECFieldFp).p
    val x = BigInteger(1, point.copyOfRange(1, 33))
    val y = BigInteger(1, point.copyOfRange(33, 65))
    // Coordinates must be field elements. BigInteger(1, ..) is never negative,
    // so this is really the upper bound — it rejects e.g. an all-0xff blob.
    require(x < p && y < p) { "coordinate not in the field" }
    // y^2 == x^3 + ax + b  (mod p). BigInteger.TWO is API 31+ and minSdk is 24,
    // so both constants go through valueOf.
    val lhs = y.modPow(BigInteger.valueOf(2), p)
    val rhs = x.modPow(BigInteger.valueOf(3), p).add(curve.a.multiply(x)).add(curve.b).mod(p)
    require(lhs == rhs) { "point is not on the curve" }
  }

  private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }

  private fun hexToBytes(hex: String): ByteArray {
    val clean = hex.removePrefix("0x").removePrefix("0X")
    require(clean.length % 2 == 0) { "must have even length" }
    // Character.digit(c, 16) returns -1 for a non-hex character rather than
    // throwing, so without this explicit check a garbage string of the right
    // length (e.g. "g".repeat(64)) would silently decode to a byte array of
    // 0xEF instead of failing — exactly the class of bug this function must
    // not produce for callers that gate on decoded length alone (signEcdsa).
    require(clean.all { Character.digit(it, 16) != -1 }) { "contains a non-hex character" }
    return ByteArray(clean.length / 2) {
      ((Character.digit(clean[it * 2], 16) shl 4) + Character.digit(clean[it * 2 + 1], 16)).toByte()
    }
  }

  companion object {
    /** Firmware-default PIV management key (0x0102…08 ×3, 24 bytes). */
    private val DEFAULT_MANAGEMENT_KEY = byteArrayOf(
      0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
      0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
      0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08
    )
  }
}
