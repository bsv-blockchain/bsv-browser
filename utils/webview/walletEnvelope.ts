/**
 * Builds the BRC-100 response envelopes the page-side SDK accepts.
 *
 * `@bsv/sdk`'s ReactNativeWebView substrate settles an invocation only on
 * `status: 'success'` (or the historical alias 'ok') and on `status: 'error'`
 * with an integer `code` from 1 to 255 and a string `description` of at most
 * 4096 UTF-8 bytes. Anything else is ignored by the page, so every reply the
 * host sends is normalized here before it is injected.
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
}

export function buildWalletSuccessEnvelope(id: string, result: unknown): WalletSuccessEnvelope {
  return { type: 'CWI', id, isInvocation: false, status: 'success', result }
}

/** Wallet-toolbox throws string codes such as ERR_PERMISSION_DENIED; the SDK accepts only 1–255. */
export function normalizeWalletErrorCode(code: unknown): number {
  if (typeof code === 'number' && Number.isSafeInteger(code) && code >= 1 && code <= WALLET_ERROR_CODE_MAX) {
    return code
  }
  return WALLET_ERROR_UNKNOWN
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
  return {
    type: 'CWI',
    id,
    isInvocation: false,
    status: 'error',
    code: normalizeWalletErrorCode(source?.code),
    description: normalizeWalletErrorDescription(source?.message)
  }
}

function utf8Length(value: string): number {
  let bytes = 0
  for (const char of value) {
    const point = char.codePointAt(0) as number
    bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4
  }
  return bytes
}
