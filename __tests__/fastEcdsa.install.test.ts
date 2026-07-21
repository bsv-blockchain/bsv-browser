import { installFastEcdsa, isFastEcdsaInstalled, getSecpBackend } from '@/utils/crypto/installFastEcdsa'

describe('installFastEcdsa', () => {
  it('installs a backend and reports noble in Jest', () => {
    const result = installFastEcdsa()
    expect(isFastEcdsaInstalled()).toBe(true)
    expect(result.backend).toMatch(/noble|native/)
    const backend = getSecpBackend()
    expect(backend.ecdsaSign).toEqual(expect.any(Function))
    expect(backend.ecdsaVerify).toEqual(expect.any(Function))
    expect(backend.pubkeyCreate).toEqual(expect.any(Function))
  })
})
