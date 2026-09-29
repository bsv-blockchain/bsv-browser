/**
 * Builds the BRC-100 response envelopes the page-side SDK accepts.
 *
 * `@bsv/sdk`'s ReactNativeWebView substrate settles an invocation only on
 * `status: 'success'` and on `status: 'error'` with an integer `code` from 1 to
 * 255 and a string `description` of at most 4096 UTF-8 bytes. Anything else is
 * ignored by the page, so every reply the host sends is normalized here before
 * it is injected. (Only the injected window.CWI still treats the historical
 * `status: 'ok'` as success; the SDK does not.)
 *
 * The SDK keeps a description only for the assigned codes 2-8 and reports every
 * other code as 'Wallet operation failed', so toolbox errors are mapped onto the
 * assigned codes they correspond to wherever one exists.
 */

export const WALLET_ERROR_UNKNOWN = 1
export const WALLET_ERROR_CODE_MAX = 255
export const WALLET_ERROR_DESCRIPTION_MAX_BYTES = 4096
export const WALLET_ERROR_DEFAULT_DESCRIPTION = 'Wallet operation failed'

export type WalletSuccessEnvelope = {
  type: 'CWI'
  id: string
  isInvocation: false
  status: 'success'
  result: unknown
}

export type WalletErrorEnvelope = {
  type: 'CWI'
  id: string
  isInvocation: false
  status: 'error'
  code: number
  description: string
  /** The toolbox's error name (WERR_* / ERR_*); window.CWI surfaces it as err.code. The SDK ignores it. */
  name?: string
}

export function buildWalletSuccessEnvelope(id: string, result: unknown): WalletSuccessEnvelope {
  return { type: 'CWI', id, isInvocation: false, status: 'success', result }
}

/**
 * Toolbox error names with an assigned BRC-100 code, as the SDK's own
 * WalletError.unknownToJson assigns them (walletErrors.reviewActions,
 * invalidParameter, insufficientFunds).
 */
const WALLET_ERROR_CODES_BY_NAME: Record<string, number> = {
  WERR_REVIEW_ACTIONS: 5,
  WERR_INVALID_PARAMETER: 6,
  WERR_INSUFFICIENT_FUNDS: 7
}

const WALLET_ERROR_NAME_PATTERN = /^W?ERR_[A-Z0-9_]{1,64}$/

/**
 * The toolbox identifies errors by string: WalletError's `code` getter returns
 * its WERR_* name, and the permissions manager sets `code = 'ERR_PERMISSION_DENIED'`
 * on a plain Error.
 */
export function walletErrorName(error: unknown): string | undefined {
  const source = error as { code?: unknown; name?: unknown } | null | undefined
  for (const candidate of [source?.code, source?.name]) {
    if (typeof candidate === 'string' && WALLET_ERROR_NAME_PATTERN.test(candidate)) return candidate
  }
  return undefined
}

/** The SDK accepts only integer codes 1–255; a toolbox name maps to its assigned code where it has one. */
export function normalizeWalletErrorCode(code: unknown, name?: string): number {
  if (typeof code === 'number' && Number.isSafeInteger(code) && code >= 1 && code <= WALLET_ERROR_CODE_MAX) {
    return code
  }
  return (name !== undefined && WALLET_ERROR_CODES_BY_NAME[name]) || WALLET_ERROR_UNKNOWN
}

export function normalizeWalletErrorDescription(description: unknown): string {
  if (typeof description !== 'string' || description.length === 0) return WALLET_ERROR_DEFAULT_DESCRIPTION
  if (utf8Length(description) <= WALLET_ERROR_DESCRIPTION_MAX_BYTES) return description
  // Trim by code point so a multi-byte character is never split.
  let out = ''
  let bytes = 0
  for (const char of description) {
    const size = utf8Length(char)
    if (bytes + size > WALLET_ERROR_DESCRIPTION_MAX_BYTES) break
    out += char
    bytes += size
  }
  return out.length > 0 ? out : WALLET_ERROR_DEFAULT_DESCRIPTION
}

export function buildWalletErrorEnvelope(id: string, error: unknown): WalletErrorEnvelope {
  const source = typeof error === 'string' ? { message: error } : (error as { code?: unknown; message?: unknown } | null | undefined)
  const name = walletErrorName(source)
  const envelope: WalletErrorEnvelope = {
    type: 'CWI',
    id,
    isInvocation: false,
    status: 'error',
    code: normalizeWalletErrorCode(source?.code, name),
    description: normalizeWalletErrorDescription(source?.message)
  }
  if (name !== undefined) envelope.name = name
  return envelope
}

function utf8Length(value: string): number {
  let bytes = 0
  for (const char of value) {
    const point = char.codePointAt(0) as number
    bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4
  }
  return bytes
}
