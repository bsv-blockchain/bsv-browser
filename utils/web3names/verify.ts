/**
 * Answer verification — ODNCA-STD-001 §6 (signature scheme).
 *
 * fields    = v, name, mailbox, holder_script, origin.txid, origin.vout,
 *             current.txid, current.vout, as_of_height, fallback, expires
 * canonical = fields joined with 0x1f (booleans "true"/"false", decimal numbers, UTF-8)
 * sighash   = SHA256(SHA256("ORDNS-RESOLVE" || 0x1f || canonical))
 * sig       = ECDSA secp256k1 over sighash, DER hex
 *
 * Fixed field order and a byte separator — no JSON canonicalization dependency,
 * so every language serializes bit-identically.
 */

import type { CryptoDeps, ResolveAnswer } from './types'

const SEP = 0x1f
const DOMAIN_TAG = 'ORDNS-RESOLVE'

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

export const bytesToHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

/** Build the exact signed preimage for an answer. Exported for conformance testing. */
export function signedPreimage (a: ResolveAnswer): Uint8Array {
  const fields = [
    String(a.v),
    a.name,
    a.mailbox || '',
    a.holder_script,
    a.origin.txid,
    String(a.origin.vout),
    a.current.txid,
    String(a.current.vout),
    String(a.as_of_height),
    a.fallback ? 'true' : 'false',
    String(a.expires)
  ]
  const canonical = utf8(fields.join(String.fromCharCode(SEP)))
  const tag = utf8(DOMAIN_TAG)
  const pre = new Uint8Array(tag.length + 1 + canonical.length)
  pre.set(tag, 0)
  pre[tag.length] = SEP
  pre.set(canonical, tag.length + 1)
  return pre
}

export function sighashOf (a: ResolveAnswer, deps: CryptoDeps): string {
  return bytesToHex(deps.sha256(deps.sha256(signedPreimage(a))))
}

export interface VerifyOptions {
  /** Pinned resolver key. The answer's own signer field is never the authority. */
  resolverPubKey: string
  nowSeconds?: number
}

export type VerifyVerdict =
  | { valid: true }
  | { valid: false, reason: 'expired' | 'bad_signature' | 'unknown_signer' }

/** Level 2 verification: signature + expiry against the pinned key. */
export function verifyAnswer (a: ResolveAnswer, deps: CryptoDeps, opts: VerifyOptions): VerifyVerdict {
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000)
  if (a.expires <= now) return { valid: false, reason: 'expired' }
  if (a.signer && a.signer !== opts.resolverPubKey) return { valid: false, reason: 'unknown_signer' }
  const ok = deps.ecdsaVerifyDer(sighashOf(a, deps), a.sig, opts.resolverPubKey)
  return ok ? { valid: true } : { valid: false, reason: 'bad_signature' }
}
