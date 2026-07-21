/**
 * Drop-in replacement for `@bsv/sdk` primitives/ECDSA sign/verify.
 *
 * Routes the common path through the installed secp backend (native or noble)
 * and delegates custom-k signing (and verify fallback) to the original pure-JS
 * ECDSA implementation.
 *
 * Note: both noble and native backends always produce low-S signatures. When
 * `forceLowS` is false this is still a valid ECDSA signature; BSV
 * `PrivateKey.sign` defaults to forceLowS=true in practice for chain use.
 */
import { BigNumber, Signature, type Point } from '@bsv/sdk'
import * as OriginalECDSAModule from '@bsv/sdk-original-ecdsa'
import { getSecpBackend, installFastEcdsa, isFastEcdsaInstalled } from './installFastEcdsa'
import {
  bigNumberToBytes32,
  compactSigToRS,
  pointToCompressedPub33,
  rsToCompactSig
} from './bnBytes'

/** secp256k1 curve order n is 256 bits — match original ECDSA rejection rule */
const N_BIT_LENGTH = 256

type CustomK = BigNumber | ((iter: number) => BigNumber)

type OriginalEcdsa = {
  sign: (
    msg: BigNumber,
    key: BigNumber,
    forceLowS?: boolean,
    customK?: CustomK
  ) => Signature
  verify: (msg: BigNumber, sig: Signature, key: Point) => boolean
}

function resolveOriginal(): OriginalEcdsa {
  const mod = OriginalECDSAModule as OriginalEcdsa & {
    default?: OriginalEcdsa
  }
  const sign = mod.sign ?? mod.default?.sign
  const verify = mod.verify ?? mod.default?.verify
  if (typeof sign !== 'function' || typeof verify !== 'function') {
    throw new Error('Failed to resolve original @bsv/sdk ECDSA exports')
  }
  return { sign, verify }
}

const original = resolveOriginal()

function ensureInstalled(): void {
  if (!isFastEcdsaInstalled()) {
    installFastEcdsa()
  }
}

/**
 * ECDSA sign compatible with `@bsv/sdk` primitives/ECDSA.sign.
 *
 * @param msg - Message hash as BigNumber (must be hashed by caller; max 256 bits)
 * @param key - Private key as BigNumber (or PrivateKey)
 * @param forceLowS - Prefer low-S; backends always emit low-S (see file note)
 * @param customK - Fixed or iterative k; when set, uses pure-JS original path
 */
export function sign(
  msg: BigNumber,
  key: BigNumber,
  forceLowS: boolean = false,
  customK?: CustomK
): Signature {
  if (msg.bitLength() > N_BIT_LENGTH) {
    throw new Error(
      `ECDSA message is too large: expected <= ${N_BIT_LENGTH} bits. Callers must hash messages before signing.`
    )
  }

  // Deterministic custom-k (RFC6979 overrides / tests) needs pure-JS path.
  if (customK !== undefined) {
    return original.sign(msg, key, forceLowS, customK)
  }

  ensureInstalled()
  const backend = getSecpBackend()
  const msg32 = bigNumberToBytes32(msg)
  const priv32 = bigNumberToBytes32(key)
  const sig64 = backend.ecdsaSign(msg32, priv32)
  const { r, s } = compactSigToRS(sig64)
  // forceLowS is intentionally unused on the fast path: native/noble always low-S.
  void forceLowS
  return new Signature(r, s)
}

/**
 * ECDSA verify compatible with `@bsv/sdk` primitives/ECDSA.verify.
 *
 * Tries the installed secp backend first; on backend rejection/error falls back
 * to the original pure-JS verifier (high-S and edge cases).
 */
export function verify(msg: BigNumber, sig: Signature, key: Point): boolean {
  if (msg.bitLength() > N_BIT_LENGTH) {
    return false
  }

  if (key.x == null || key.y == null) {
    throw new Error('Invalid public key: missing coordinates.')
  }

  ensureInstalled()
  try {
    const backend = getSecpBackend()
    const msg32 = bigNumberToBytes32(msg)
    const sig64 = rsToCompactSig(sig.r, sig.s)
    const pub33 = pointToCompressedPub33(key.x, key.y)
    if (backend.ecdsaVerify(msg32, sig64, pub33)) {
      return true
    }
  } catch {
    // fall through to original
  }

  return original.verify(msg, sig, key)
}

// Named exports also available as a namespace-style object for CJS interop consumers.
export const ECDSA = { sign, verify }
export default { sign, verify }
