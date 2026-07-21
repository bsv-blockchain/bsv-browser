/**
 * Package wiring: native-secp256k1 resolves and soft-fails under Jest.
 */
import { installFastEcdsa, getSecpBackend } from '@/utils/crypto/installFastEcdsa'

// Jest maps native-secp256k1 to the mock
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nativeSecp = require('native-secp256k1') as {
  isAvailable: () => boolean
  ecdsaSign: (a: Uint8Array, b: Uint8Array) => Uint8Array
}

describe('native-secp256k1 package', () => {
  it('resolves and reports unavailable under Jest', () => {
    expect(typeof nativeSecp.isAvailable).toBe('function')
    expect(nativeSecp.isAvailable()).toBe(false)
  })

  it('installFastEcdsa still selects noble when native is unavailable', () => {
    const result = installFastEcdsa()
    expect(result.backend).toBe('noble')
    expect(getSecpBackend().name).toBe('noble')
  })
})
