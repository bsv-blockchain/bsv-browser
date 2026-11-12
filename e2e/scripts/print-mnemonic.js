/**
 * Print one fresh 12-word BIP-39 phrase to stdout and nothing else.
 * Callers pass it to Maestro as E2E_MNEMONIC. Do not commit the output.
 * The e2e build forces testnet and points Arcade at a mock that refuses
 * broadcasts, so this phrase cannot move mainnet or testnet funds.
 */

const { Mnemonic } = require('@bsv/sdk/compat')

const phrase = Mnemonic.fromRandom(128).mnemonic
const words = phrase.trim().split(/\s+/)
if (words.length !== 12) {
  console.error(`[e2e] expected 12 words, got ${words.length}`)
  process.exit(1)
}
process.stdout.write(phrase.trim())
