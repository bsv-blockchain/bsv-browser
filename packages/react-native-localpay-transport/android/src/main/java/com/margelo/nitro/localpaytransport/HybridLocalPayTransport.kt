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
 * be able to kill a live request by connecting to it. `hasAccepted` is the
 * payee's first-success-wins latch (mirrors Swift's own field of the same
 * name): the pairing QR is on public display, so a second PSK-holder reaching
 * FRAME after we've already accepted one must be refused outright, not merely
 * raced against — stealing the one `pendingAckEndpoint` slot would ack the
 * wrong endpoint while the real payer times out on a payment the payee
 * already credited.
 *
 * All mutable state is confined to the main-thread Handler: Nearby delivers
 * its callbacks on the main thread, and hopping everything we initiate onto
 * the same thread makes the state machine single-threaded by construction —
 * the same discipline the Swift side gets from its serial DispatchQueue.
 *
 * One race Android cannot close the way Swift does: `confirmFrame`'s ack
 * write can be in flight (an async `Task` from `sendPayload`/
 * `disconnectFromEndpoint`) at the same moment JS calls `stopListening()`.
 * Swift confines every touch of `live`/`pendingAck` to one serial
 * `DispatchQueue` and does its `stopListening` bookkeeping in a `queue.sync`
 * that completes before the ack's own `queue`-confined send completion can
 * run, so the two can never interleave destructively. `ConnectionsClient`
 * has no equivalent: `stopAllEndpoints()` is an app-global call with no way
 * to exclude "the endpoint an ack is mid-send on" the way Swift's queue
 * ordering does for free. This is structurally unclosable with the public
 * Nearby API as it stands — which is why the JS discipline in
 * utils/localpay/transport/socket.ts (never calling `stopListening()` on a
 * path that still holds a confirm handle — see `finish(teardown, ...)` in
 * `receive()`) is load-bearing, not merely tidy: it is what actually
 * prevents this race from being reachable in practice, since `stopListening`
 * only ever runs before a frame is delivered or after `confirmFrame` has
 * already completed its own teardown.
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
  /**
   * First-success-wins latch, mirroring Swift's `hasAccepted`. Set the
   * instant a FRAME is validated — before the ack is even sent — so a second
   * inbound connection that also reaches a valid FRAME in the window before
   * JS gets around to `stopListening()` can never be mistaken for a second
   * successful payment. Reset only by `startListening` (a fresh session)
   * and, defensively, `stopListening`.
   */
  private var hasAccepted = false

  /** Reapers for accepted-but-not-yet-FRAMEd connections, keyed by endpointId. */
  private val idleReapers = mutableMapOf<String, Runnable>()
  /** Reaper for `pendingAckEndpoint` — see `armAckReaper`. */
  private var ackReaper: Runnable? = null

  override fun isSupported(): Boolean {
    val context: Context = NitroModules.applicationContext ?: return false
    return GoogleApiAvailability.getInstance()
      .isGooglePlayServicesAvailable(context) == ConnectionResult.SUCCESS
  }

  /**
   * Ceiling on how long an accepted-but-not-yet-FRAMEd connection is
   * retained: a peer that connects (with or without a valid HELLO) and then
   * stalls would otherwise be held forever — a resource-exhaustion vector
   * against payment code on an open local network, and P2P_POINT_TO_POINT
   * means one staller occupies the only connection slot. Mirrors Swift's
   * `acceptedConnectionReadTimeout`.
   */
  private fun armIdleReaper(endpointId: String) {
    val reaper = Runnable {
      idleReapers.remove(endpointId)
      client()?.disconnectFromEndpoint(endpointId)
      // Unlike Swift's silent per-connection accept timeout (a stray probe
      // against the advertisement is not a failed payment attempt there),
      // this surfaces through listenOnError: it is JS's only signal that a
      // peer connected and then stalled, and a short, clearly-worded native
      // error is what lets it degrade toward the QR the same way any other
      // native failure does.
      listenOnError?.invoke("peer connected but never completed the handshake")
    }
    idleReapers[endpointId] = reaper
    main.postDelayed(reaper, IDLE_CONNECTION_TIMEOUT_MS)
  }

  private fun cancelIdleReaper(endpointId: String) {
    idleReapers.remove(endpointId)?.let { main.removeCallbacks(it) }
  }

  /**
   * Ceiling on how long the accepted connection is held open waiting for JS
   * to call `confirmFrame`. A JS crash, a backgrounded app, or a wedged
   * storage write must not leak the socket. Mirrors Swift's
   * `pendingAckConfirmTimeout`: expiry tears the connection down SILENTLY on
   * the wire (never a synthesized ack — the frame may already be durably
   * queued, and possibly spent, by JS by the time this fires) but still
   * records the fact through `listenOnError`, exactly like Swift's own
   * `onError("payee never confirmed the payment; connection released")`.
   * `hasAccepted` is deliberately left `true`: this listening session is
   * over either way (advertising was already stopped at FRAME), and only a
   * fresh `startListening()` gets a clean slate.
   */
  private fun armAckReaper(endpointId: String) {
    ackReaper?.let { main.removeCallbacks(it) }
    val reaper = Runnable {
      ackReaper = null
      pendingAckEndpoint = null
      client()?.disconnectFromEndpoint(endpointId)
      listenOnError?.invoke("payee never confirmed the payment; connection released")
    }
    ackReaper = reaper
    main.postDelayed(reaper, PENDING_ACK_TIMEOUT_MS)
  }

  private fun cancelAckReaper() {
    ackReaper?.let { main.removeCallbacks(it) }
    ackReaper = null
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
            cancelIdleReaper(endpointId)
            client()?.disconnectFromEndpoint(endpointId)
            return
          }
          boundEndpoint = endpointId
          val reply = byteArrayOf(TYPE_HELLO_B) + hmac(psk, name, ROLE_B)
          client()?.sendPayload(endpointId, Payload.fromBytes(reply))
            ?.addOnFailureListener { e ->
              cancelIdleReaper(endpointId)
              client()?.disconnectFromEndpoint(endpointId)
              if (boundEndpoint == endpointId) boundEndpoint = null
              listenOnError?.invoke("failed to reply to peer: ${e.message}")
            }
        }
        TYPE_FRAME -> {
          if (endpointId != boundEndpoint) {
            cancelIdleReaper(endpointId)
            client()?.disconnectFromEndpoint(endpointId)
            return
          }
          if (hasAccepted) {
            // First-success-wins: a second PSK-holder (or a race between two
            // legitimate-looking connections) reaching FRAME after we've
            // already accepted one must not steal the ack slot.
            cancelIdleReaper(endpointId)
            client()?.disconnectFromEndpoint(endpointId)
            return
          }
          // First-success-wins, like the Swift listener: stop advertising and
          // hold this connection open for the ack JS will decide on.
          cancelIdleReaper(endpointId)
          hasAccepted = true
          pendingAckEndpoint = endpointId
          client()?.stopAdvertising()
          armAckReaper(endpointId)
          val frame = bytes.copyOfRange(1, bytes.size)
          listenOnFrame?.invoke(Base64.encodeToString(frame, Base64.NO_WRAP))
        }
        else -> {
          cancelIdleReaper(endpointId)
          client()?.disconnectFromEndpoint(endpointId)
        }
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
      armIdleReaper(endpointId)
    }
    override fun onConnectionResult(endpointId: String, result: ConnectionResolution) {}
    override fun onDisconnected(endpointId: String) {
      cancelIdleReaper(endpointId)
      if (endpointId == boundEndpoint && pendingAckEndpoint == null && !hasAccepted) {
        boundEndpoint = null
      }
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

      // Self-reset before advertising: a fresh session must never inherit a
      // previous one's bookkeeping, and a startAdvertising failure below
      // (e.g. ALREADY_ADVERTISING) must not leave this half-reset. Targeted,
      // not stopAllEndpoints() — that call is app-global (see the class doc
      // comment) and would be a bigger hammer than a fresh start needs; only
      // endpoints THIS instance still remembers are torn down here.
      c.stopAdvertising()
      idleReapers.values.forEach { main.removeCallbacks(it) }
      val staleAccepted = idleReapers.keys.toList()
      idleReapers.clear()
      cancelAckReaper()
      val stale = (staleAccepted + listOfNotNull(boundEndpoint, pendingAckEndpoint)).distinct()
      stale.forEach { c.disconnectFromEndpoint(it) }
      hasAccepted = false
      boundEndpoint = null
      pendingAckEndpoint = null

      listening = true
      listenPsk = psk
      listenName = instanceName
      listenOnFrame = onFrame
      listenOnError = onError
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
      // success path (it would destroy the socket the ack must cross). This
      // is the one place that stays an app-global stopAllEndpoints() call, on
      // purpose: see the class doc comment for why that race is accepted
      // here rather than closed.
      client()?.stopAdvertising()
      client()?.stopAllEndpoints()
      idleReapers.values.forEach { main.removeCallbacks(it) }
      idleReapers.clear()
      cancelAckReaper()
      listening = false
      hasAccepted = false
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
      cancelAckReaper()
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
      // The endpoint we've committed to — set the instant requestConnection
      // is called, NOT only once onConnectionResult succeeds. A connect-
      // budget rejection must be able to tear down a connection that is
      // merely negotiating: without this, settle() had nothing to
      // disconnect, so a still-negotiating connection could go on to
      // complete, exchange HELLO, and deliver the frame to the payee on a
      // path the payer had already abandoned for the QR fallback — payment
      // delivered "successfully" on a connection this call believes is dead.
      var dialedEndpoint: String? = null

      fun settle(block: () -> Unit) {
        if (settled) return
        settled = true
        c.stopDiscovery()
        dialedEndpoint?.let { c.disconnectFromEndpoint(it) }
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
          if (settled) {
            c.disconnectFromEndpoint(endpointId)
            return
          }
          val bytes = payload.asBytes() ?: return
          if (bytes.isEmpty()) return
          when (bytes[0]) {
            TYPE_HELLO_B -> {
              val proof = bytes.copyOfRange(1, bytes.size)
              if (!constantTimeEquals(proof, hmac(psk, instanceName, ROLE_B))) {
                settle { promise.reject(Error("peer failed the session proof")) }
                return
              }
              c.sendPayload(endpointId, Payload.fromBytes(byteArrayOf(TYPE_FRAME) + frame))
                .addOnFailureListener { e ->
                  // Fail fast into the reject path rather than waiting out
                  // the whole-send timeout, so the QR fallback kicks in
                  // quickly instead of burning the rest of the budget.
                  settle { promise.reject(Error("failed to send frame: ${e.message}")) }
                }
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
          if (settled) {
            c.disconnectFromEndpoint(endpointId)
            return
          }
          c.acceptConnection(endpointId, payloads)
        }
        override fun onConnectionResult(endpointId: String, result: ConnectionResolution) {
          if (settled) {
            c.disconnectFromEndpoint(endpointId)
            return
          }
          if (!result.status.isSuccess) {
            settle { promise.reject(Error("connection refused: ${result.status.statusMessage}")) }
            return
          }
          // Connection established — the Nearby analogue of Swift's
          // NWConnection reaching `.ready`. The connect budget covers
          // discovery + connection only; from here the HELLO/FRAME/ACK
          // exchange is covered by the whole-send timeout instead.
          ready = true
          c.stopDiscovery()
          c.sendPayload(
            endpointId,
            Payload.fromBytes(byteArrayOf(TYPE_HELLO_A) + hmac(psk, instanceName, ROLE_A))
          ).addOnFailureListener { e ->
            settle { promise.reject(Error("failed to send HELLO_A: ${e.message}")) }
          }
        }
        override fun onDisconnected(endpointId: String) {
          settle { promise.reject(Error("peer disconnected before acking")) }
        }
      }

      val discovery = object : EndpointDiscoveryCallback() {
        override fun onEndpointFound(endpointId: String, info: DiscoveredEndpointInfo) {
          if (settled) {
            c.disconnectFromEndpoint(endpointId)
            return
          }
          // Sessions are one-per-payment: only the endpoint advertising THIS
          // session's name is our payee. Anything else on the serviceId is a
          // different payment happening nearby.
          if (info.endpointName != instanceName) return
          if (dialedEndpoint != null) return
          dialedEndpoint = endpointId
          c.requestConnection(instanceName, endpointId, lifecycle)
            .addOnFailureListener { e ->
              settle { promise.reject(Error("connection request failed: ${e.message}")) }
            }
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
    private const val IDLE_CONNECTION_TIMEOUT_MS = 30_000L
    private const val PENDING_ACK_TIMEOUT_MS = 60_000L
  }
}
