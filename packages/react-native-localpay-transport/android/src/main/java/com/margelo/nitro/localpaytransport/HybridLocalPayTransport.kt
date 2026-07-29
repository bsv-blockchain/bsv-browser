package com.margelo.nitro.localpaytransport

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Base64
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.nearby.Nearby
import com.google.android.gms.nearby.connection.AdvertisingOptions
import com.google.android.gms.nearby.connection.ConnectionInfo
import com.google.android.gms.nearby.connection.ConnectionLifecycleCallback
import com.google.android.gms.nearby.connection.ConnectionResolution
import com.google.android.gms.nearby.connection.ConnectionsClient
import com.google.android.gms.nearby.connection.DiscoveredEndpointInfo
import com.google.android.gms.nearby.connection.DiscoveryOptions
import com.google.android.gms.nearby.connection.EndpointDiscoveryCallback
import com.google.android.gms.nearby.connection.Payload
import com.google.android.gms.nearby.connection.PayloadCallback
import com.google.android.gms.nearby.connection.PayloadTransferUpdate
import com.google.android.gms.nearby.connection.Strategy
import com.margelo.nitro.NitroModules
import com.margelo.nitro.core.Promise
import java.security.MessageDigest
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * LocalPayTransport over Google Nearby Connections.
 *
 * Mirrors the Swift/AWDL backend's contract exactly (the JS wrapper in
 * utils/localpay/transport/socket.ts is shared): the payee listens
 * (advertises), the payer dials (discovers), one frame crosses, and the ack
 * that releases the payer's transaction travels back over the SAME connection
 * only when JS calls confirmFrame after its durable write.
 *
 * Nearby encrypts the link but knows nothing of our pairing, so the first
 * payload each way is an HMAC proof binding the connection to the pairing
 * QR's PSK — see the protocol table in the implementation plan. A failed
 * proof disconnects and, on the payee, keeps advertising: a stranger must not
 * be able to kill a live request by connecting to it.
 *
 * All mutable state is confined to the main-thread Handler: Nearby delivers
 * its callbacks on the main thread, and hopping everything we initiate onto
 * the same thread makes the state machine single-threaded by construction —
 * the same discipline the Swift side gets from its serial DispatchQueue.
 */
class HybridLocalPayTransport : HybridLocalPayTransportSpec() {
  private val main = Handler(Looper.getMainLooper())
  private val serviceId = "org.bsvblockchain.bsvbrowser.localpay"

  private fun client(): ConnectionsClient? {
    val context: Context = NitroModules.applicationContext ?: return null
    return Nearby.getConnectionsClient(context)
  }

  // ── crypto ──

  private fun hmac(psk: ByteArray, instanceName: String, role: Byte): ByteArray {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(psk, "HmacSHA256"))
    mac.update(instanceName.toByteArray(Charsets.UTF_8))
    mac.update(role)
    return mac.doFinal()
  }

  private fun constantTimeEquals(a: ByteArray, b: ByteArray): Boolean = MessageDigest.isEqual(a, b)

  // ── payee (listener) state ──

  private var listening = false
  private var listenPsk: ByteArray? = null
  private var listenName: String? = null
  private var listenOnFrame: ((String) -> Unit)? = null
  private var listenOnError: ((String) -> Unit)? = null
  /** Endpoint whose HELLO verified. Only its FRAME is deliverable. */
  private var boundEndpoint: String? = null
  /** Endpoint holding an undelivered ack — the payer confirmFrame answers. */
  private var pendingAckEndpoint: String? = null

  override fun isSupported(): Boolean {
    val context: Context = NitroModules.applicationContext ?: return false
    return GoogleApiAvailability.getInstance()
      .isGooglePlayServicesAvailable(context) == ConnectionResult.SUCCESS
  }

  private val payeePayloads = object : PayloadCallback() {
    override fun onPayloadReceived(endpointId: String, payload: Payload) {
      val bytes = payload.asBytes() ?: return
      if (bytes.isEmpty()) return
      val psk = listenPsk ?: return
      val name = listenName ?: return
      when (bytes[0]) {
        TYPE_HELLO_A -> {
          val proof = bytes.copyOfRange(1, bytes.size)
          if (!constantTimeEquals(proof, hmac(psk, name, ROLE_A))) {
            client()?.disconnectFromEndpoint(endpointId)
            return
          }
          boundEndpoint = endpointId
          val reply = byteArrayOf(TYPE_HELLO_B) + hmac(psk, name, ROLE_B)
          client()?.sendPayload(endpointId, Payload.fromBytes(reply))
        }
        TYPE_FRAME -> {
          if (endpointId != boundEndpoint) {
            client()?.disconnectFromEndpoint(endpointId)
            return
          }
          // First-success-wins, like the Swift listener: stop advertising and
          // hold this connection open for the ack JS will decide on.
          pendingAckEndpoint = endpointId
          client()?.stopAdvertising()
          val frame = bytes.copyOfRange(1, bytes.size)
          listenOnFrame?.invoke(Base64.encodeToString(frame, Base64.NO_WRAP))
        }
        else -> client()?.disconnectFromEndpoint(endpointId)
      }
    }

    override fun onPayloadTransferUpdate(endpointId: String, update: PayloadTransferUpdate) {}
  }

  private val payeeLifecycle = object : ConnectionLifecycleCallback() {
    override fun onConnectionInitiated(endpointId: String, info: ConnectionInfo) {
      // Accept transport-level connections freely; trust is established by the
      // HELLO HMAC, not by Nearby's own auth digits (nobody is reading those
      // off a screen mid-payment).
      client()?.acceptConnection(endpointId, payeePayloads)
    }
    override fun onConnectionResult(endpointId: String, result: ConnectionResolution) {}
    override fun onDisconnected(endpointId: String) {
      if (endpointId == boundEndpoint && pendingAckEndpoint == null) boundEndpoint = null
    }
  }

  override fun startListening(
    instanceName: String,
    pskBase64: String,
    onFrame: (String) -> Unit,
    onError: (String) -> Unit
  ): Promise<Unit> {
    val promise = Promise<Unit>()
    main.post {
      val c = client()
      val psk = try { Base64.decode(pskBase64, Base64.DEFAULT) } catch (e: Exception) { null }
      if (c == null || psk == null) {
        promise.reject(Error("nearby unavailable or bad psk"))
        return@post
      }
      listening = true
      listenPsk = psk
      listenName = instanceName
      listenOnFrame = onFrame
      listenOnError = onError
      boundEndpoint = null
      pendingAckEndpoint = null
      c.startAdvertising(
        instanceName,
        serviceId,
        payeeLifecycle,
        AdvertisingOptions.Builder().setStrategy(Strategy.P2P_POINT_TO_POINT).build()
      )
        .addOnSuccessListener { promise.resolve(Unit) }
        .addOnFailureListener { e ->
          listening = false
          promise.reject(Error("advertising failed: ${e.message}"))
        }
    }
    return promise
  }

  override fun stopListening(): Promise<Unit> {
    val promise = Promise<Unit>()
    main.post {
      // Mirrors Swift stopListening: cancels advertising AND any held
      // connection — which is why the JS receive() path never calls it on the
      // success path (it would destroy the socket the ack must cross).
      client()?.stopAdvertising()
      client()?.stopAllEndpoints()
      listening = false
      boundEndpoint = null
      pendingAckEndpoint = null
      listenPsk = null
      listenName = null
      listenOnFrame = null
      listenOnError = null
      promise.resolve(Unit)
    }
    return promise
  }

  override fun confirmFrame(accepted: Boolean, reason: String): Promise<Unit> {
    val promise = Promise<Unit>()
    main.post {
      val endpoint = pendingAckEndpoint
      val c = client()
      if (endpoint == null || c == null) {
        // Idempotent and safe to call late, per the spec contract.
        promise.resolve(Unit)
        return@post
      }
      pendingAckEndpoint = null
      val json = if (accepted) "{\"ok\":true}"
      else "{\"ok\":false,\"error\":${jsonString(reason)}}"
      val payload = byteArrayOf(TYPE_ACK) + json.toByteArray(Charsets.UTF_8)
      c.sendPayload(endpoint, Payload.fromBytes(payload))
        .addOnSuccessListener {
          c.disconnectFromEndpoint(endpoint)
          promise.resolve(Unit)
        }
        .addOnFailureListener { e ->
          c.disconnectFromEndpoint(endpoint)
          promise.reject(Error("ack failed: ${e.message}"))
        }
    }
    return promise
  }

  // ── payer (dialer) ──

  override fun sendFrame(
    instanceName: String,
    pskBase64: String,
    frameBase64: String,
    timeoutMs: Double,
    connectTimeoutMs: Double
  ): Promise<String> {
    val promise = Promise<String>()
    main.post {
      val c = client()
      val psk = try { Base64.decode(pskBase64, Base64.DEFAULT) } catch (e: Exception) { null }
      val frame = try { Base64.decode(frameBase64, Base64.DEFAULT) } catch (e: Exception) { null }
      if (c == null || psk == null || frame == null) {
        promise.reject(Error("nearby unavailable or bad psk/frame"))
        return@post
      }
      if (frame.size + 1 > MAX_BYTES_PAYLOAD) {
        // The wire-protocol's own ceiling (see the Phase 3 protocol table),
        // not a hard limit of the Nearby API itself (Payload.fromBytes/
        // ConnectionsClient can carry well over a megabyte in practice) —
        // frames above it are deliberately rejected so the JS layer falls
        // back to the fountain QR, which handles any size.
        promise.reject(Error("frame too large for a nearby payload"))
        return@post
      }

      var settled = false
      var ready = false
      var connectedEndpoint: String? = null
      fun settle(block: () -> Unit) {
        if (settled) return
        settled = true
        c.stopDiscovery()
        connectedEndpoint?.let { c.disconnectFromEndpoint(it) }
        block()
      }

      main.postDelayed({
        if (!ready) settle { promise.reject(Error("connect timeout: no route to peer")) }
      }, connectTimeoutMs.toLong())
      main.postDelayed({
        settle { promise.reject(Error("timed out waiting for peer")) }
      }, timeoutMs.toLong())

      val payloads = object : PayloadCallback() {
        override fun onPayloadReceived(endpointId: String, payload: Payload) {
          val bytes = payload.asBytes() ?: return
          if (bytes.isEmpty()) return
          when (bytes[0]) {
            TYPE_HELLO_B -> {
              val proof = bytes.copyOfRange(1, bytes.size)
              if (!constantTimeEquals(proof, hmac(psk, instanceName, ROLE_B))) {
                settle { promise.reject(Error("peer failed the session proof")) }
                return
              }
              ready = true
              c.sendPayload(endpointId, Payload.fromBytes(byteArrayOf(TYPE_FRAME) + frame))
            }
            TYPE_ACK -> {
              val ack = bytes.copyOfRange(1, bytes.size)
              settle { promise.resolve(Base64.encodeToString(ack, Base64.NO_WRAP)) }
            }
            else -> settle { promise.reject(Error("unexpected payload from peer")) }
          }
        }
        override fun onPayloadTransferUpdate(endpointId: String, update: PayloadTransferUpdate) {}
      }

      val lifecycle = object : ConnectionLifecycleCallback() {
        override fun onConnectionInitiated(endpointId: String, info: ConnectionInfo) {
          c.acceptConnection(endpointId, payloads)
        }
        override fun onConnectionResult(endpointId: String, result: ConnectionResolution) {
          if (!result.status.isSuccess) {
            settle { promise.reject(Error("connection refused: ${result.status.statusMessage}")) }
            return
          }
          connectedEndpoint = endpointId
          c.stopDiscovery()
          c.sendPayload(
            endpointId,
            Payload.fromBytes(byteArrayOf(TYPE_HELLO_A) + hmac(psk, instanceName, ROLE_A))
          )
        }
        override fun onDisconnected(endpointId: String) {
          settle { promise.reject(Error("peer disconnected before acking")) }
        }
      }

      val discovery = object : EndpointDiscoveryCallback() {
        override fun onEndpointFound(endpointId: String, info: DiscoveredEndpointInfo) {
          // Sessions are one-per-payment: only the endpoint advertising THIS
          // session's name is our payee. Anything else on the serviceId is a
          // different payment happening nearby.
          if (info.endpointName != instanceName) return
          c.requestConnection(instanceName, endpointId, lifecycle)
        }
        override fun onEndpointLost(endpointId: String) {}
      }

      c.startDiscovery(
        serviceId,
        discovery,
        DiscoveryOptions.Builder().setStrategy(Strategy.P2P_POINT_TO_POINT).build()
      ).addOnFailureListener { e ->
        settle { promise.reject(Error("discovery failed: ${e.message}")) }
      }
    }
    return promise
  }

  private fun jsonString(s: String): String =
    "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

  companion object {
    private const val TYPE_HELLO_A: Byte = 0x01
    private const val TYPE_HELLO_B: Byte = 0x02
    private const val TYPE_FRAME: Byte = 0x03
    private const val TYPE_ACK: Byte = 0x04
    private const val ROLE_A: Byte = 0x01
    private const val ROLE_B: Byte = 0x02
    private const val MAX_BYTES_PAYLOAD = 32768
  }
}
