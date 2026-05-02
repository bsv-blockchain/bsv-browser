import { PublicKey } from '@bsv/sdk'

export interface PeerPayParams {
  identityKey: string
  sats?: number
}

export interface PeerPayValidationResult {
  isPeerPay: boolean
  identityKey?: string
  sats?: number
  errors: {
    identityKey?: string
    sats?: string
  }
}

const PEERPAY_SCHEME = 'peerpay:'
const COMPRESSED_PUBLIC_KEY_REGEX = /^0[23][0-9a-f]{64}$/

export function parsePeerPayURI(uri: string): PeerPayParams | null {
  const result = validatePeerPayURI(uri)
  if (!result.isPeerPay || !result.identityKey || result.errors.identityKey || result.errors.sats) return null
  return { identityKey: result.identityKey, sats: result.sats }
}

export function validatePeerPayURI(uri: string): PeerPayValidationResult {
  if (!uri.toLowerCase().startsWith(PEERPAY_SCHEME)) {
    return { isPeerPay: false, errors: { identityKey: 'Not a peerpay link' } }
  }

  const withoutScheme = uri.slice(PEERPAY_SCHEME.length)
  const queryIndex = withoutScheme.indexOf('?')
  const keyPart = queryIndex === -1 ? withoutScheme : withoutScheme.slice(0, queryIndex)
  const queryPart = queryIndex === -1 ? '' : withoutScheme.slice(queryIndex + 1)
  const rawIdentityKey = keyPart
  const errors: PeerPayValidationResult['errors'] = {}

  let identityKey: string | undefined
  if (isValidIdentityKey(rawIdentityKey)) {
    identityKey = rawIdentityKey
  } else {
    errors.identityKey = 'PeerPay link contains an invalid identity key'
  }

  let sats: number | undefined
  if (queryPart) {
    const params = new URLSearchParams(queryPart)
    if (params.has('sats')) {
      const satsStr = params.get('sats') ?? ''
      if (/^(0|[1-9][0-9]*)$/.test(satsStr)) {
        const parsed = Number(satsStr)
        if (Number.isSafeInteger(parsed)) {
          if (parsed > 0) sats = parsed
        } else {
          errors.sats = 'PeerPay link contains an invalid sats amount'
        }
      } else {
        errors.sats = 'PeerPay link contains an invalid sats amount'
      }
    }
  }

  return { isPeerPay: true, identityKey, sats, errors }
}

function isValidIdentityKey(identityKey: string) {
  if (!COMPRESSED_PUBLIC_KEY_REGEX.test(identityKey)) return false
  try {
    PublicKey.fromString(identityKey)
    return true
  } catch {
    return false
  }
}
