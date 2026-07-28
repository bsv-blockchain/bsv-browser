/**
 * Rail identity.
 *
 * A rail is never chosen by the user. It is derived from HOW the counterparty
 * was identified: a scanned nearby session, an identity key, or a base58
 * address. Everything in this file is pure — no wallet, no network — so the
 * classification a payment depends on is testable in isolation.
 */
import { PublicKey, Utils } from '@bsv/sdk'
import { decodeSession, type Session } from '@/utils/localpay/session'
import { validatePeerPayURI } from '@/utils/parsePeerPayURI'

export type RailId = 'nearby' | 'handle' | 'address'

/** How a counterparty was identified. Each variant carries only what its rail needs. */
export type PayTarget =
  | { kind: 'nearby'; session: Session }
  | { kind: 'handle'; identityKey: string; sats?: number }
  | { kind: 'address'; address: string; sats?: number }

/** The six cells of the grid: direction × counterparty. */
export type PayCell = 'pay-nearby' | 'pay-handle' | 'pay-address' | 'get-nearby' | 'get-handle' | 'get-address'

export const PAY_CELLS: readonly PayCell[] = [
  'pay-nearby',
  'pay-handle',
  'pay-address',
  'get-nearby',
  'get-handle',
  'get-address'
] as const

export function isPayCell(value: string | undefined): value is PayCell {
  return !!value && (PAY_CELLS as readonly string[]).includes(value)
}

/** Pure. Derived from how the counterparty was identified, never from a user choosing a transport. */
export function inferRail(target: PayTarget): RailId {
  return target.kind
}

/** What the user must already have for a rail to be possible. */
export const PRECONDITION_KEYS: Record<RailId, string> = {
  nearby: 'pay_pre_nearby',
  handle: 'pay_pre_handle',
  address: 'pay_pre_address'
}

/**
 * What happens after they tap Pay. The address line is the one that must never
 * be implicit: a user who pastes an address expecting messaging-style delivery
 * has effectively posted cash.
 */
export const CONSEQUENCE_KEYS: Record<RailId, string> = {
  nearby: 'pay_conseq_nearby',
  handle: 'pay_conseq_handle',
  address: 'pay_conseq_address'
}

/** Strips a `bitcoin:` scheme and any query string, leaving a bare address candidate. */
export function normalizeAddressInput(raw: string): string {
  return raw.replace(/^bitcoin:/i, '').split('?')[0].trim()
}

export function isValidBsvAddress(text: string): boolean {
  if (!text) return false
  try {
    Utils.fromBase58Check(text)
    return true
  } catch {
    return false
  }
}

function isCompressedPublicKey(text: string): boolean {
  try {
    PublicKey.fromString(text)
    return true
  } catch {
    return false
  }
}

/**
 * The one place a scanned or pasted string becomes a rail.
 *
 * Order matters: the two schemed forms are unambiguous and go first, then the
 * localpay session envelope, then the two bare forms. A string that matches
 * nothing returns null — the caller shows "not recognised" rather than
 * guessing a rail, because guessing wrong on this input sends money the wrong
 * way.
 */
export function classifyScan(raw: string): PayTarget | null {
  const text = raw.trim()
  if (!text) return null

  if (text.toLowerCase().startsWith('peerpay:')) {
    const result = validatePeerPayURI(text)
    if (!result.identityKey || result.errors.identityKey) return null
    return { kind: 'handle', identityKey: result.identityKey, sats: result.sats }
  }

  if (/^bitcoin:/i.test(text)) {
    const address = normalizeAddressInput(text)
    return isValidBsvAddress(address) ? { kind: 'address', address } : null
  }

  try {
    return { kind: 'nearby', session: decodeSession(text) }
  } catch {
    // Not a session envelope. Fall through to the bare forms.
  }

  if (isCompressedPublicKey(text)) return { kind: 'handle', identityKey: text }
  if (isValidBsvAddress(text)) return { kind: 'address', address: text }
  return null
}

/**
 * Where an old route sends the user now.
 *
 * `/payments` carried the only external deep link in the app (`peerpay:` via
 * +native-intent), so its params are forwarded verbatim; the other two never
 * took params.
 */
export function legacyRedirectTarget(
  route: 'payments' | 'legacy-payments' | 'local-payments',
  params: Record<string, string | undefined>
): { pathname: '/pay'; params: Record<string, string> } {
  const cell: PayCell =
    route === 'payments' ? 'pay-handle' : route === 'legacy-payments' ? 'get-address' : 'get-nearby'
  const forwarded: Record<string, string> = { cell }
  for (const key of ['peerpay', 'identityKey', 'sats'] as const) {
    const value = params[key]
    if (value !== undefined) forwarded[key] = value
  }
  return { pathname: '/pay', params: forwarded }
}
