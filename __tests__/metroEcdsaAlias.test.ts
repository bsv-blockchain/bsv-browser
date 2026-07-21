// CJS helper — require so Jest loads the Metro shim as written
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { shouldAliasBsvEcdsa } = require('../metro-shims/ecdsaResolve')

describe('shouldAliasBsvEcdsa', () => {
  it('aliases relative ECDSA from sdk private key', () => {
    expect(
      shouldAliasBsvEcdsa(
        './ECDSA.js',
        '/app/node_modules/@bsv/sdk/dist/esm/src/primitives/PrivateKey.js'
      )
    ).toBe(true)
  })

  it('aliases ./ECDSA without extension from sdk', () => {
    expect(
      shouldAliasBsvEcdsa(
        './ECDSA',
        '/app/node_modules/@bsv/sdk/dist/esm/src/primitives/PrivateKey.js'
      )
    ).toBe(true)
  })

  it('aliases ../primitives/ECDSA.js from nested sdk package', () => {
    expect(
      shouldAliasBsvEcdsa(
        '../primitives/ECDSA.js',
        '/app/node_modules/@bsv/sdk/dist/esm/src/wallet/Something.js'
      )
    ).toBe(true)
  })

  it('aliases absolute-style primitives/ECDSA path fragments', () => {
    expect(
      shouldAliasBsvEcdsa(
        '/app/node_modules/@bsv/sdk/dist/esm/src/primitives/ECDSA.js',
        '/app/node_modules/@bsv/sdk/dist/esm/src/primitives/PrivateKey.js'
      )
    ).toBe(true)
  })

  it('does not alias unrelated modules', () => {
    expect(shouldAliasBsvEcdsa('./ECDSA.js', '/app/utils/foo.js')).toBe(false)
  })

  it('does not alias when origin is missing', () => {
    expect(shouldAliasBsvEcdsa('./ECDSA.js', undefined)).toBe(false)
    expect(shouldAliasBsvEcdsa('./ECDSA.js', null)).toBe(false)
  })

  it('does not alias non-ECDSA imports from sdk', () => {
    expect(
      shouldAliasBsvEcdsa(
        './BigNumber.js',
        '/app/node_modules/@bsv/sdk/dist/esm/src/primitives/PrivateKey.js'
      )
    ).toBe(false)
  })
})
