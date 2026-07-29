package com.margelo.nitro.localpaytransport

import com.margelo.nitro.core.Promise

/**
 * Android backend of the LocalPayTransport Nitro spec, over Google Nearby
 * Connections. This skeleton keeps the module honest while Task 15 lands the
 * implementation: isSupported() = false makes the JS ladder treat this device
 * exactly as it does today (QR only).
 */
class HybridLocalPayTransport : HybridLocalPayTransportSpec() {
  override fun isSupported(): Boolean = false

  override fun startListening(
    instanceName: String,
    pskBase64: String,
    onFrame: (String) -> Unit,
    onError: (String) -> Unit
  ): Promise<Unit> = Promise.rejected(Error("not implemented"))

  override fun stopListening(): Promise<Unit> = Promise.resolved(Unit)

  override fun confirmFrame(accepted: Boolean, reason: String): Promise<Unit> =
    Promise.rejected(Error("not implemented"))

  override fun sendFrame(
    instanceName: String,
    pskBase64: String,
    frameBase64: String,
    timeoutMs: Double,
    connectTimeoutMs: Double
  ): Promise<String> = Promise.rejected(Error("not implemented"))
}
