import * as secp from '@noble/secp256k1'
import { sha256 } from '@noble/hashes/sha2'
import { hmac } from '@noble/hashes/hmac'
import type { SecpBackend } from './types'

let hashesWired = false

function wireNobleHashes(): void {
  if (hashesWired) return
  secp.hashes.sha256 = sha256
  secp.hashes.hmacSha256 = (key, msg) => hmac(sha256, key, msg)
  hashesWired = true
}

/**
 * Audited pure-JS secp256k1 backend via @noble/secp256k1.
 * Always available (web, Jest, missing native build).
 */
export function createNobleSecpBackend(): SecpBackend {
  wireNobleHashes()

  return {
    name: 'noble',
    ecdsaSign(msg32: Uint8Array, priv32: Uint8Array): Uint8Array {
      // Message is already a 32-byte hash; produce compact 64-byte R||S, low-S.
      return secp.sign(msg32, priv32, { prehash: false, lowS: true, format: 'compact' })
    },
    ecdsaVerify(msg32: Uint8Array, sig64: Uint8Array, pub33: Uint8Array): boolean {
      try {
        return secp.verify(sig64, msg32, pub33, { prehash: false, lowS: true })
      } catch {
        return false
      }
    },
    pubkeyCreate(priv32: Uint8Array): Uint8Array {
      return secp.getPublicKey(priv32, true)
    }
  }
}
