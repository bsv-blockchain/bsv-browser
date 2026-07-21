export type SecpBackendName = 'native' | 'noble'

export type SecpBackend = {
  name: SecpBackendName
  /** Compact 64-byte R||S, low-S normalized */
  ecdsaSign(msg32: Uint8Array, priv32: Uint8Array): Uint8Array
  ecdsaVerify(msg32: Uint8Array, sig64: Uint8Array, pub33: Uint8Array): boolean
  /** Compressed 33-byte pubkey */
  pubkeyCreate(priv32: Uint8Array): Uint8Array
}
