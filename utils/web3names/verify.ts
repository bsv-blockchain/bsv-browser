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
import { parseWeb3Name } from './names'

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
  /**
   * The address that was actually requested. Required: a signature covers the
   * answer's OWN name, so without this there is nothing to bind the answer to
   * and verification cannot mean anything.
   */
  expectName: string
}

export type VerifyVerdict =
  | { valid: true }
  | { valid: false, reason: 'expired' | 'bad_signature' | 'unknown_signer' | 'not_ok' | 'malformed' | 'no_expected_name' | 'name_mismatch' | 'mailbox_mismatch' }

/**
 * Level 2 verification: the answer answers the question that was asked, it
 * says it succeeded, it has not expired, and it is signed by the pinned key —
 * in that order.
 *
 * The binding is the part that is easy to leave out and expensive to omit. A
 * correctly signed, unexpired answer for attacker.web3 is still a valid
 * signature; only comparing it against what the caller asked for makes it an
 * answer. Without that, any cache, proxy or relay in the path is a
 * substitution point.
 */
export function verifyAnswer (a: ResolveAnswer, deps: CryptoDeps, opts: VerifyOptions): VerifyVerdict {
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000)

  if (a == null || typeof a !== 'object') return { valid: false, reason: 'malformed' }
  if ((a as any).ok !== true) return { valid: false, reason: 'not_ok' }

  if (typeof opts.expectName !== 'string' || opts.expectName === '') {
    return { valid: false, reason: 'no_expected_name' }
  }
  const asked = parseWeb3Name(opts.expectName)
  if (!asked) return { valid: false, reason: 'no_expected_name' }
  if (a.name !== asked.name) return { valid: false, reason: 'name_mismatch' }
  const answeredMailbox = a.mailbox == null ? null : String(a.mailbox)
  // A mailbox question may be answered by the domain holder, but only when the
  // resolver declares it as a fallback (ODNCA-STD-001 §5).
  if (asked.mailbox !== null && answeredMailbox !== asked.mailbox && a.fallback !== true) {
    return { valid: false, reason: 'mailbox_mismatch' }
  }
  if (asked.mailbox === null && answeredMailbox !== null && answeredMailbox !== '') {
    return { valid: false, reason: 'mailbox_mismatch' }
  }

  // Every non-numeric value makes this comparison false, so a missing, NaN or
  // string `expires` used to mean "never expires" — on a field the whole
  // freshness model rests on. A resolver could sign an eternally valid answer
  // by omitting it. Numeric-and-finite is now a precondition, not an
  // assumption.
  if (!Number.isFinite(a.expires) || a.expires <= now) return { valid: false, reason: 'expired' }
  if (a.signer && a.signer !== opts.resolverPubKey) return { valid: false, reason: 'unknown_signer' }
  const ok = deps.ecdsaVerifyDer(sighashOf(a, deps), a.sig, opts.resolverPubKey)
  return ok ? { valid: true } : { valid: false, reason: 'bad_signature' }
}
