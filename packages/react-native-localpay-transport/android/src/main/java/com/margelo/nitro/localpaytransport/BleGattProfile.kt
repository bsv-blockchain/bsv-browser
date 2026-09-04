package com.margelo.nitro.localpaytransport

import java.nio.ByteBuffer
import java.security.MessageDigest
import java.util.UUID
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Wire constants and pure helpers for the `bsvpay-ble/1` GATT profile
 * (design §2 profile, §3 messages and framing).
 *
 * Byte-for-byte identical to ios/BleGattProfile.swift. A change here without
 * the same change there breaks Android↔iOS, which is the whole reason this
 * rung exists. Pure JVM on purpose — no android.* imports — so
 * BleGattProfileTest runs under plain JUnit without an emulator.
 */
object BleGattProfile {
  /** Logcat tag; the hardware checklist greps for it. Same tag as the Swift os_log category. */
  const val TAG = "LocalPayBle"

  /** Fixed characteristic UUIDs; only the service UUID is per-session (§2). Suffix 425356504159 = ASCII "BSVPAY". */
  val FRAME_CHAR_UUID: UUID = UUID.fromString("B5A1E001-7374-4F6E-8E2D-425356504159")
  val ACK_CHAR_UUID: UUID = UUID.fromString("B5A1E002-7374-4F6E-8E2D-425356504159")
  /** Client Characteristic Configuration descriptor — Bluetooth SIG assigned number 0x2902. */
  val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

  const val TYPE_HELLO_A: Byte = 0x01
  const val TYPE_HELLO_B: Byte = 0x02
  const val TYPE_FRAME: Byte = 0x03
  const val TYPE_ACK: Byte = 0x04

  /** `type ‖ body` ceiling, same as Nearby's MAX_BYTES_PAYLOAD (§3). */
  const val MAX_BLE_FRAME_BYTES = 32768
  const val LENGTH_PREFIX_BYTES = 4
  const val MAC_BYTES = 32
  const val IDLE_CONNECTION_TIMEOUT_MS = 30_000L
  const val PENDING_ACK_TIMEOUT_MS = 60_000L
  const val MTU_NEGOTIATION_TIMEOUT_MS = 2_000L
  const val REQUESTED_MTU = 517
  const val DEFAULT_ATT_MTU = 23
  /** ATT opcode (1 byte) + attribute handle (2 bytes) precede every write / indication payload. */
  const val ATT_HEADER_BYTES = 3
  /**
   * Hard ceiling on a single GATT chunk, independent of the negotiated ATT MTU.
   * Discovered 2026-09-03 on the reversed-role hardware run: Android's native
   * Bluetooth stack rejects `notifyCharacteristicChanged`/indication payloads
   * over 512 bytes regardless of MTU (`bt_stack: BTA_GATTS_HandleValueIndication
   * — data to indicate is too long` at mtu-3=514 with MTU=517). Applied to every
   * chunk (writes included, not just indications) for one uniform, defensive
   * ceiling rather than tracking which paths are and aren't exempt.
   */
  const val MAX_CHUNK_BYTES = 512

  private const val SERVICE_LABEL = "bsvpay-ble-svc"
  private val UTF8 = Charsets.UTF_8

  // ── crypto ──

  fun hmac(psk: ByteArray, vararg parts: ByteArray): ByteArray {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(psk, "HmacSHA256"))
    for (part in parts) mac.update(part)
    return mac.doFinal()
  }

  /**
   * HMAC-SHA256(psk, "bsvpay-ble-svc" ‖ utf8(instanceName)) truncated to 16
   * bytes, then forced to RFC-4122 version 4 / variant 10 so both platforms
   * (and Android's exact-match ScanFilter) agree on every bit (§2).
   */
  fun serviceUuid(psk: ByteArray, instanceName: String): UUID {
    val digest = hmac(psk, SERVICE_LABEL.toByteArray(UTF8), instanceName.toByteArray(UTF8))
    val b = digest.copyOfRange(0, 16)
    b[6] = ((b[6].toInt() and 0x0F) or 0x40).toByte()
    b[8] = ((b[8].toInt() and 0x3F) or 0x80).toByte()
    val bb = ByteBuffer.wrap(b)
    return UUID(bb.long, bb.long)
  }

  /** HMAC-SHA256(psk, utf8(instanceName) ‖ [type]) — the HELLO proof each way (§3 table). */
  fun proof(psk: ByteArray, instanceName: String, type: Byte): ByteArray =
    hmac(psk, instanceName.toByteArray(UTF8), byteArrayOf(type))

  /** HMAC-SHA256(psk, utf8(instanceName) ‖ [0x04] ‖ ackJson) — what makes a forged ack impossible without the PSK (§3). */
  fun ackMac(psk: ByteArray, instanceName: String, ackJson: ByteArray): ByteArray =
    hmac(psk, instanceName.toByteArray(UTF8), byteArrayOf(TYPE_ACK), ackJson)

  fun constantTimeEquals(a: ByteArray, b: ByteArray): Boolean = MessageDigest.isEqual(a, b)

  // ── messages (type byte ‖ body) ──

  fun helloA(psk: ByteArray, instanceName: String): ByteArray =
    byteArrayOf(TYPE_HELLO_A) + proof(psk, instanceName, TYPE_HELLO_A)

  fun helloB(psk: ByteArray, instanceName: String): ByteArray =
    byteArrayOf(TYPE_HELLO_B) + proof(psk, instanceName, TYPE_HELLO_B)

  fun frameMessage(sealed: ByteArray): ByteArray = byteArrayOf(TYPE_FRAME) + sealed

  fun ackMessage(psk: ByteArray, instanceName: String, ackJson: ByteArray): ByteArray =
    byteArrayOf(TYPE_ACK) + ackJson + ackMac(psk, instanceName, ackJson)

  /**
   * Payer side: checks the type byte, splits off the trailing 32-byte MAC,
   * verifies it in constant time and returns the bare ackJson (which JS's
   * parseAck expects), or null when anything is off.
   */
  fun verifyAck(psk: ByteArray, instanceName: String, message: ByteArray): ByteArray? {
    if (message.isEmpty() || message[0] != TYPE_ACK) return null
    // Strictly greater: a 33-byte ACK is a MAC over an EMPTY ackJson, which the
    // Swift twin also rejects (`body.count > macLength`) and which JS's
    // parseAck could not parse anyway.
    if (message.size <= 1 + MAC_BYTES) return null
    val json = message.copyOfRange(1, message.size - MAC_BYTES)
    val mac = message.copyOfRange(message.size - MAC_BYTES, message.size)
    return if (constantTimeEquals(mac, ackMac(psk, instanceName, json))) json else null
  }

  /**
   * Byte-identical to the AWDL/Nearby acks: {"ok":true} or
   * {"ok":false,"error":<reason>} with the reason JSON-serialized, never
   * interpolated (a raw quote would make the payer's JSON.parse throw and
   * turn a clean decline into an AckError). Empty reason → "declined",
   * matching Swift's declineJson fallback.
   */
  fun ackJson(accepted: Boolean, reason: String): String =
    if (accepted) "{\"ok\":true}"
    else "{\"ok\":false,\"error\":${jsonString(if (reason.isEmpty()) "declined" else reason)}}"

  /** Minimal, complete JSON string serializer (RFC 8259 §7): quotes, backslash and all control characters escaped. */
  fun jsonString(s: String): String {
    val sb = StringBuilder(s.length + 2)
    sb.append('"')
    for (ch in s) {
      when (ch) {
        '"' -> sb.append("\\\"")
        '\\' -> sb.append("\\\\")
        '\n' -> sb.append("\\n")
        '\r' -> sb.append("\\r")
        '\t' -> sb.append("\\t")
        '\b' -> sb.append("\\b")
        '\u000C' -> sb.append("\\f")
        else -> if (ch < ' ') sb.append("\\u%04x".format(ch.code)) else sb.append(ch)
      }
    }
    sb.append('"')
    return sb.toString()
  }

  // ── framing: [u32 BE length][message], chunked to ATT_MTU − 3 (§3) ──

  fun lengthPrefixed(message: ByteArray): ByteArray {
    val n = message.size
    val out = ByteArray(LENGTH_PREFIX_BYTES + n)
    out[0] = (n ushr 24).toByte()
    out[1] = (n ushr 16).toByte()
    out[2] = (n ushr 8).toByte()
    out[3] = n.toByte()
    System.arraycopy(message, 0, out, LENGTH_PREFIX_BYTES, n)
    return out
  }

  fun chunkSize(mtu: Int): Int = maxOf(1, minOf(mtu - ATT_HEADER_BYTES, MAX_CHUNK_BYTES))

  fun chunk(bytes: ByteArray, mtu: Int): ArrayDeque<ByteArray> {
    val size = chunkSize(mtu)
    val out = ArrayDeque<ByteArray>()
    var i = 0
    while (i < bytes.size) {
      val end = minOf(bytes.size, i + size)
      out.addLast(bytes.copyOfRange(i, end))
      i = end
    }
    return out
  }

  /**
   * Rebuilds `[u32 BE length][message]` streams from arbitrary chunking.
   * One instance per connection per direction. The buffer is allocated at
   * the declared length, so it can never hold more than
   * MAX_BLE_FRAME_BYTES + 4 bytes: an oversize or zero declared length
   * throws IllegalArgumentException and the caller drops the connection.
   */
  class Reassembler {
    private val header = ByteArray(LENGTH_PREFIX_BYTES)
    private var headerFilled = 0
    private var body: ByteArray? = null
    private var bodyFilled = 0

    /**
     * Discards any half-read record.
     *
     * `feed` calls this before every throw, which is load-bearing rather than
     * tidy: the rejected length prefix is diagnosed with `headerFilled`
     * already at LENGTH_PREFIX_BYTES and `body` still null, so an instance
     * left in that state would take the header branch on its very next byte
     * and write `header[4]` — an ArrayIndexOutOfBoundsException raised inside
     * a GATT callback, i.e. a process kill. A caller that keeps a peer alive
     * after a framing refusal (the payee holding the ack route open) can also
     * call it directly to resynchronise.
     */
    fun reset() {
      headerFilled = 0
      body = null
      bodyFilled = 0
    }

    fun feed(chunk: ByteArray): List<ByteArray> {
      val done = mutableListOf<ByteArray>()
      var i = 0
      while (i < chunk.size) {
        val current = body
        if (current == null) {
          header[headerFilled++] = chunk[i++]
          if (headerFilled == LENGTH_PREFIX_BYTES) {
            val declared = ((header[0].toInt() and 0xff) shl 24) or
              ((header[1].toInt() and 0xff) shl 16) or
              ((header[2].toInt() and 0xff) shl 8) or
              (header[3].toInt() and 0xff)
            if (declared <= 0 || declared > MAX_BLE_FRAME_BYTES) {
              // Reset BEFORE throwing: see `reset`'s doc comment — leaving
              // headerFilled at 4 with a null body turns the next byte from
              // this peer into an ArrayIndexOutOfBoundsException.
              reset()
              throw IllegalArgumentException("declared message length $declared outside 1..$MAX_BLE_FRAME_BYTES")
            }
            body = ByteArray(declared)
            bodyFilled = 0
          }
        } else {
          val n = minOf(chunk.size - i, current.size - bodyFilled)
          System.arraycopy(chunk, i, current, bodyFilled, n)
          bodyFilled += n
          i += n
          if (bodyFilled == current.size) {
            done += current
            body = null
            headerFilled = 0
          }
        }
      }
      return done
    }
  }
}
