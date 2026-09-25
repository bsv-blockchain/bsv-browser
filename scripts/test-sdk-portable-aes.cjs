const assert = require('node:assert/strict')
const crypto = require('node:crypto')
// Browser/mobile must exercise the SDK implementation, never Node's fast path.
process.getBuiltinModule = undefined
const { SymmetricKey } = require('@bsv/sdk')
const { AESGCM, AESGCMDecrypt } = require('@bsv/sdk/primitives/AESGCM')

async function run() {
  const esm = await import('@bsv/sdk/primitives/AESGCM')
  let cases = 0
  const key = new Uint8Array(32).fill(7)
  for (const impl of [{ AESGCM, AESGCMDecrypt }, esm]) {
    for (const ivLength of [12, 32]) {
      const iv = new Uint8Array(ivLength).fill(9)
      for (const size of [0, 1, 15, 16, 17, 64]) {
        const plaintext = new Uint8Array(size).fill(42)
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
        const tag = cipher.getAuthTag()
        const portable = impl.AESGCM(plaintext, iv, key)
        assert.deepEqual([...portable.result], [...ciphertext])
        assert.deepEqual([...portable.authenticationTag], [...tag])
        assert.deepEqual([...impl.AESGCMDecrypt(ciphertext, iv, tag, key)], [...plaintext])
        for (let i = 0; i < 16; i++) {
          const bad = Uint8Array.from(tag); bad[i] ^= 1
          assert.equal(impl.AESGCMDecrypt(ciphertext, iv, bad, key), null)
        }
        assert.equal(impl.AESGCMDecrypt(ciphertext, iv, tag.subarray(0, 15), key), null)
        assert.equal(impl.AESGCMDecrypt(ciphertext, iv, new Uint8Array(0), key), null)
        assert.equal(impl.AESGCMDecrypt(ciphertext, iv, tag, new Uint8Array(32).fill(8)), null)
        assert.equal(impl.AESGCMDecrypt(ciphertext, new Uint8Array(ivLength).fill(8), tag, key), null)
        if (ivLength === 32) {
          const envelope = [...iv, ...ciphertext, ...tag]
          assert.deepEqual(new SymmetricKey([...key]).decrypt(envelope), [...plaintext])
          const broken = [...envelope]; broken[broken.length - 1] ^= 1
          assert.throws(() => new SymmetricKey([...key]).decrypt(broken), /Decryption failed/)
        }
        cases++
      }
    }
  }
  assert.throws(() => new SymmetricKey([...key]).decrypt(new Array(47).fill(0)), /too short/)
  console.log(`Portable CJS/ESM AES-GCM: ${cases} cross-runtime cases, including empty fields, with tag/key/IV/truncation rejection passed.`)
}
run().catch(error => { console.error(error); process.exitCode = 1 })
