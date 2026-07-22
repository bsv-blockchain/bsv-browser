import * as mnemonicWallet from '@/utils/mnemonicWallet'
import { generateRandomMnemonic, getMnemonicWordCount } from '@/utils/mnemonicWallet'

describe('generateRandomMnemonic', () => {
  it('defaults to a 12-word (128-bit) phrase', () => {
    expect(getMnemonicWordCount(generateRandomMnemonic())).toBe(12)
  })

  it('honors the requested entropy strength instead of ignoring it', () => {
    expect(getMnemonicWordCount(generateRandomMnemonic(256))).toBe(24)
    expect(getMnemonicWordCount(generateRandomMnemonic(160))).toBe(15)
  })
})

describe('dead base64 helpers', () => {
  it('are removed (they were an unencrypted footgun)', () => {
    expect((mnemonicWallet as Record<string, unknown>).encodeMnemonicForStorage).toBeUndefined()
    expect((mnemonicWallet as Record<string, unknown>).decodeMnemonicFromStorage).toBeUndefined()
  })
})
