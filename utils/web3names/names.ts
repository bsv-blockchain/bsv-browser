/**
 * Address detection and normalization — ODNCA-STD-001 §2, ODNCA-STD-003.
 *
 * <address> := [ <mailbox> "@" ] <name> "." <tld>
 * Normalization: trim; strip a leading sns:/ordns: scheme or @; TLD lowercased;
 * name and mailbox lowercased only when pure ASCII (non-ASCII names match on
 * exact UTF-8 bytes — no Unicode normalization, ever). More than one @ rejects.
 */

const SCHEME_RE = /^(sns:|ordns:|web3:\/\/|ord:\/\/)/i
const ASCII_RE = /^[\x00-\x7F]*$/

export interface ParsedName {
  /** Full resolver input: mailbox@name.tld or name.tld. */
  address: string
  /** The domain part: name.tld. */
  name: string
  mailbox: string | null
  tld: string
}

const lowerAsciiOnly = (s: string): string => (ASCII_RE.test(s) ? s.toLowerCase() : s)

/**
 * Parse a candidate web3 address. Returns null when the shape is not a
 * web3 name at all; throws never. TLD membership is checked by the caller.
 */
export function parseWeb3Name (raw: string): ParsedName | null {
  let s = String(raw || '').trim()
  s = s.replace(SCHEME_RE, '').replace(/^@/, '').replace(/\/.*$/, '').trim()
  if (!s || /\s/.test(s)) return null
  const at = s.indexOf('@')
  if (at !== s.lastIndexOf('@')) return null
  let mailbox: string | null = null
  let name = s
  if (at > -1) {
    mailbox = s.slice(0, at)
    name = s.slice(at + 1)
    if (!mailbox || !name) return null
  }
  const dot = name.indexOf('.')
  if (dot <= 0 || dot !== name.lastIndexOf('.') || dot === name.length - 1) return null
  const label = lowerAsciiOnly(name.slice(0, dot))
  const tld = name.slice(dot + 1).toLowerCase()
  const canonical = `${label}.${tld}`
  const mb = mailbox === null ? null : lowerAsciiOnly(mailbox)
  return {
    address: mb === null ? canonical : `${mb}@${canonical}`,
    name: canonical,
    mailbox: mb,
    tld
  }
}
