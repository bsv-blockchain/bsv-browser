import { BigNumber } from '@bsv/sdk'

/** secp256k1 field/order byte length */
export const SECP256K1_BYTES = 32

/**
 * Convert a BigNumber to a fixed 32-byte big-endian Uint8Array (left-padded).
 */
export function bigNumberToBytes32(bn: BigNumber): Uint8Array {
  return Uint8Array.from(bn.toArray('be', SECP256K1_BYTES))
}

/**
 * Convert a 32-byte (or shorter) big-endian byte array to a BigNumber.
 */
export function bytesToBigNumber(bytes: Uint8Array): BigNumber {
  return new BigNumber(Array.from(bytes))
}

/**
 * Split a compact 64-byte R||S signature into BigNumber components.
 */
export function compactSigToRS(sig64: Uint8Array): { r: BigNumber; s: BigNumber } {
  if (sig64.length !== 64) {
    throw new Error(`Expected 64-byte compact signature, got ${sig64.length}`)
  }
  return {
    r: bytesToBigNumber(sig64.subarray(0, 32)),
    s: bytesToBigNumber(sig64.subarray(32, 64))
  }
}

/**
 * Build a 64-byte compact R||S from Signature BigNumber components.
 */
export function rsToCompactSig(r: BigNumber, s: BigNumber): Uint8Array {
  const out = new Uint8Array(64)
  out.set(bigNumberToBytes32(r), 0)
  out.set(bigNumberToBytes32(s), 32)
  return out
}

/**
 * Compress a point (x, y) to a 33-byte SEC1 pubkey:
 * prefix 0x02 if y even, 0x03 if y odd, then 32-byte x.
 */
export function pointToCompressedPub33(x: BigNumber, y: BigNumber): Uint8Array {
  const out = new Uint8Array(33)
  out[0] = y.isEven() ? 0x02 : 0x03
  out.set(bigNumberToBytes32(x), 1)
  return out
}
