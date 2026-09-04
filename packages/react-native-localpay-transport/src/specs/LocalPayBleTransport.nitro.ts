import type { HybridObject } from 'react-native-nitro-modules'

/**
 * BLE rung of the local-payment transport (GATT profile bsvpay-ble/1, spec
 * docs/superpowers/specs/2026-09-02-ble-transport-and-qr-caps-design.md §2-§3).
 *
 * The four transport methods have signatures identical to LocalPayTransport so
 * core/localpay/transport/socket.ts drives both HybridObjects through one
 * structural type (`LocalPayNative`). The three probes are prompt-free by
 * contract: reading them at any time never shows the iOS Bluetooth dialog.
 * `prepare()` is the ONE method that may.
 */
export interface LocalPayBleTransport extends HybridObject<{ ios: 'swift'; android: 'kotlin' }> {
  /** Hardware present and not denied. Prompt-free. `notDetermined` counts as supported. */
  isSupported(): boolean
  /** 'poweredOn' | 'poweredOff' | 'unauthorized' | 'unsupported' | 'unknown'. Prompt-free. */
  bluetoothState(): string
  /** NFC reader hardware available and enabled. Prompt-free. */
  nfcAvailable(): boolean
  /**
   * Instantiate the peripheral and central managers and resolve their state.
   * THE ONE CALL THAT MAY SHOW THE iOS BLUETOOTH PROMPT. Resolves the same
   * string as bluetoothState() once the managers settle or timeoutMs elapses.
   */
  prepare(timeoutMs: number): Promise<string>
  startListening(
    instanceName: string,
    pskBase64: string,
    onFrame: (frameBase64: string) => void,
    onError: (message: string) => void
  ): Promise<void>
  stopListening(): Promise<void>
  /**
   * Same contract as LocalPayTransport.confirmFrame (see that spec's doc
   * comment: an ack is a money-safety statement JS makes after its durable
   * write). On BLE the ack additionally carries an HMAC over the wire; the
   * payer's native side verifies and strips it, so JS sees identical bytes.
   */
  confirmFrame(accepted: boolean, reason: string): Promise<void>
  sendFrame(
    instanceName: string,
    pskBase64: string,
    frameBase64: string,
    /** Whole-exchange budget: scan + connect + transfer + the payee's save + ack. */
    timeoutMs: number,
    /**
     * Connect-phase budget (scan, connect, MTU, discovery, subscribe). Rejects
     * with "connect timeout: no route to peer" — the string the JS layer
     * already treats as radios-off/peer-gone so the UI falls to the QR fast.
     */
    connectTimeoutMs: number
  ): Promise<string>
  /**
   * Reversed role, payee side (spec 2026-09-03): scan for a payer advertising
   * this session's service UUID, connect, subscribe to ACK, expect the payer's
   * HELLO_A as an indication, write HELLO_B, receive FRAME indications. Runs
   * alongside startListening() on the same object: one first-success-wins
   * latch covers both links, and the loser is torn down the instant a FRAME is
   * accepted on either. confirmFrame() and stopListening() are unchanged and
   * act on whichever link holds the frame. Resolves once scanning is on;
   * rejects only if scanning cannot start ("bluetooth unavailable"). A scan
   * that never hits is not an error.
   */
  startScanning(
    instanceName: string,
    pskBase64: string,
    onFrame: (frameBase64: string) => void,
    onError: (message: string) => void
  ): Promise<void>
  /**
   * Reversed role, payer side: advertise this session's service UUID and serve
   * GATT; when a central subscribes to ACK, indicate HELLO_A, expect a HELLO_B
   * write, indicate FRAME, resolve with the bare ackJson of a MAC-verified ACK
   * write. Same budgets and rejection strings as sendFrame(): "connect timeout:
   * no route to peer" if no central subscribed within connectTimeoutMs, "timed
   * out waiting for peer" at timeoutMs.
   */
  sendFrameAdvertising(
    instanceName: string,
    pskBase64: string,
    frameBase64: string,
    timeoutMs: number,
    connectTimeoutMs: number
  ): Promise<string>
}
