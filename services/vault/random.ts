/**
 * Entropy for vault crypto. Prefers expo-crypto's native RNG; falls back to
 * the WebCrypto global (present under Jest/Node) so pure-TS tests run without
 * native modules. Throws rather than degrade to weak randomness.
 */
export function randomBytes(length: number): number[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getRandomBytes } = require('expo-crypto') as { getRandomBytes: (n: number) => Uint8Array }
    return Array.from(getRandomBytes(length))
  } catch {
    const g = globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }
    if (g.crypto?.getRandomValues) {
      const out = new Uint8Array(length)
      g.crypto.getRandomValues(out)
      return Array.from(out)
    }
    throw new Error('No secure random source available')
  }
}
