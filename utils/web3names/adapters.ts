/**
 * Ready-made CryptoDeps built from packages already in this repo's tree
 * (@bsv/sdk ships via @bsv/wallet-toolbox-mobile). Kept in its own file so
 * the rest of the module stays dependency-free and unit-testable anywhere.
 *
 * NOTE for reviewers: this is the one file that binds to @bsv/sdk API
 * names — exercise it in the dev build alongside the pure unit suite.
 */

import { Hash, ECDSA, Signature, PublicKey, BigNumber } from '@bsv/sdk'
import type { CryptoDeps } from './types'

export function bsvSdkCryptoDeps (): CryptoDeps {
  return {
    sha256: (data) => new Uint8Array(Hash.sha256(Array.from(data))),
    ecdsaVerifyDer: (msgHash32Hex, derSigHex, compressedPubKeyHex) => {
      try {
        const msg = new BigNumber(msgHash32Hex, 16)
        const sig = Signature.fromDER(derSigHex, 'hex')
        const pub = PublicKey.fromString(compressedPubKeyHex)
        return ECDSA.verify(msg, sig, pub)
      } catch {
        return false
      }
    }
  }
}
