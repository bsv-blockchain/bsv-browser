import type { HybridObject } from 'react-native-nitro-modules'

export interface LocalPayTransport extends HybridObject<{ ios: 'swift' }> {
  /** True when AWDL peer-to-peer networking is usable on this device. */
  isSupported(): boolean
  startListening(
    instanceName: string,
    pskBase64: string,
    onFrame: (frameBase64: string) => void,
    onError: (message: string) => void
  ): Promise<void>
  stopListening(): Promise<void>
  /**
   * Acknowledge the frame that `startListening`'s `onFrame` most recently
   * delivered, over the connection the native side is still holding open.
   *
   * Delivery and acknowledgement are deliberately separate calls. An ack is a
   * money-safety statement — it tells the payer the payee has DURABLY QUEUED
   * the payment — and only JS knows whether that happened. Acking at `onFrame`
   * time would ack "the bytes reached Swift", which stays true when JS then
   * fails to decode the frame, rejects it as belonging to another session, or
   * cannot write it to storage, leaving the payer on a green "Sent" with
   * nothing queued at the payee.
   *
   * `accepted: false` sends `{"ok":false,"error":reason}` and is an
   * instruction to the payer that nothing was queued, so it may release the
   * inputs its `noSend` action is holding. Only send it where that is provably
   * true. `reason` is a stable machine code (see DeclineReason in
   * utils/localpay/transport/types.ts), not display text — the payer maps it
   * into its own locale.
   *
   * Idempotent and safe to call late: with no held connection it resolves and
   * does nothing. Rejects only when the ack could not be written to the socket.
   */
  confirmFrame(accepted: boolean, reason: string): Promise<void>
  sendFrame(
    instanceName: string,
    pskBase64: string,
    frameBase64: string,
    timeoutMs: number
  ): Promise<string>
}
