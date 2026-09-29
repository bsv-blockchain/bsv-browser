import {
  WALLET_ERROR_DEFAULT_DESCRIPTION,
  WALLET_ERROR_DESCRIPTION_MAX_BYTES,
  WALLET_ERROR_UNKNOWN,
  buildWalletErrorEnvelope,
  buildWalletSuccessEnvelope,
  normalizeWalletErrorCode,
  normalizeWalletErrorDescription
} from '@/utils/webview/walletEnvelope'

describe('buildWalletSuccessEnvelope', () => {
  it('reports success with the canonical status the SDK requires', () => {
    expect(buildWalletSuccessEnvelope('req-1', { version: 'wallet-brc100-1.0.0' })).toEqual({
      type: 'CWI',
      id: 'req-1',
      isInvocation: false,
      status: 'success',
      result: { version: 'wallet-brc100-1.0.0' }
    })
  })
})

describe('normalizeWalletErrorCode', () => {
  it('keeps an assigned BRC-100 code', () => {
    expect(normalizeWalletErrorCode(8)).toBe(8)
    expect(normalizeWalletErrorCode(255)).toBe(255)
  })

  it.each([['ERR_PERMISSION_DENIED'], [0], [256], [-1], [1.5], [undefined], [null], [{}]])(
    'maps %p to the unknown-error code',
    code => {
      expect(normalizeWalletErrorCode(code)).toBe(WALLET_ERROR_UNKNOWN)
    }
  )

  it('prefers an explicit numeric code over the name mapping', () => {
    expect(normalizeWalletErrorCode(3, 'WERR_INSUFFICIENT_FUNDS')).toBe(3)
    expect(normalizeWalletErrorCode('WERR_INSUFFICIENT_FUNDS', 'WERR_INSUFFICIENT_FUNDS')).toBe(7)
  })
})

describe('normalizeWalletErrorDescription', () => {
  it('keeps a short string', () => {
    expect(normalizeWalletErrorDescription('Permission denied.')).toBe('Permission denied.')
  })

  it('replaces a non-string or empty description', () => {
    expect(normalizeWalletErrorDescription(undefined)).toBe(WALLET_ERROR_DEFAULT_DESCRIPTION)
    expect(normalizeWalletErrorDescription({ message: 'x' })).toBe(WALLET_ERROR_DEFAULT_DESCRIPTION)
    expect(normalizeWalletErrorDescription('')).toBe(WALLET_ERROR_DEFAULT_DESCRIPTION)
  })

  it('truncates to the SDK byte ceiling without splitting a character', () => {
    // 'é' is two UTF-8 bytes; 2049 of them are 4098 bytes.
    const description = normalizeWalletErrorDescription('é'.repeat(2049))
    expect(Buffer.byteLength(description, 'utf8')).toBeLessThanOrEqual(WALLET_ERROR_DESCRIPTION_MAX_BYTES)
    expect(description).toBe('é'.repeat(2048))
  })
})

describe('buildWalletErrorEnvelope', () => {
  it('forwards a numeric toolbox code and message', () => {
    const error = Object.assign(new Error('Insufficient funds.'), { code: 7 })
    expect(buildWalletErrorEnvelope('req-2', error)).toEqual({
      type: 'CWI',
      id: 'req-2',
      isInvocation: false,
      status: 'error',
      code: 7,
      description: 'Insufficient funds.'
    })
  })

  it('normalizes a string permission-denied code so the SDK can parse the envelope', () => {
    const error = Object.assign(new Error('Permission denied.'), { code: 'ERR_PERMISSION_DENIED' })
    expect(buildWalletErrorEnvelope('req-3', error)).toEqual({
      type: 'CWI',
      id: 'req-3',
      isInvocation: false,
      status: 'error',
      code: WALLET_ERROR_UNKNOWN,
      description: 'Permission denied.',
      name: 'ERR_PERMISSION_DENIED'
    })
  })

  // Shaped like the toolbox's WalletError: `code` is a getter over the WERR_* name.
  class ToolboxError extends Error {
    constructor(name: string, message: string) {
      super(message)
      this.name = name
    }
    get code() {
      return this.name
    }
  }

  it.each([
    ['WERR_REVIEW_ACTIONS', 5],
    ['WERR_INVALID_PARAMETER', 6],
    ['WERR_INSUFFICIENT_FUNDS', 7]
  ])('maps toolbox %s onto its assigned code %i so the SDK keeps the description', (name, code) => {
    expect(buildWalletErrorEnvelope('req-7', new ToolboxError(name, 'Specific reason.'))).toEqual({
      type: 'CWI',
      id: 'req-7',
      isInvocation: false,
      status: 'error',
      code,
      description: 'Specific reason.',
      name
    })
  })

  it('keeps an unassigned toolbox error on the unknown code but still names it', () => {
    expect(buildWalletErrorEnvelope('req-8', new ToolboxError('WERR_UNAUTHORIZED', 'Denied.'))).toMatchObject({
      code: WALLET_ERROR_UNKNOWN,
      name: 'WERR_UNAUTHORIZED'
    })
  })

  it('omits a name that is not a toolbox error identifier', () => {
    const envelope = buildWalletErrorEnvelope('req-9', Object.assign(new TypeError('bad'), { code: 'lowercase oops' }))
    expect(envelope).not.toHaveProperty('name')
    expect(envelope.code).toBe(WALLET_ERROR_UNKNOWN)
  })

  it('accepts a bare description string and a code-less error', () => {
    expect(buildWalletErrorEnvelope('req-4', 'Wallet is disabled in Web2 mode')).toMatchObject({
      status: 'error',
      code: WALLET_ERROR_UNKNOWN,
      description: 'Wallet is disabled in Web2 mode'
    })
    expect(buildWalletErrorEnvelope('req-5', new Error('boom'))).toMatchObject({
      code: WALLET_ERROR_UNKNOWN,
      description: 'boom'
    })
    expect(buildWalletErrorEnvelope('req-6', undefined)).toMatchObject({
      code: WALLET_ERROR_UNKNOWN,
      description: WALLET_ERROR_DEFAULT_DESCRIPTION
    })
  })
})
