/**
 * Vendored, gzip-compressed reference copy of the R1-K1 vault locking
 * script's constant template -- see the "vendor the template" decision in
 * services/vault/templateCodec.ts.
 *
 * WHY THIS EXISTS: templateCodec.ts used to rebuild the ~960 KB template from
 * whatever @bsv/templates happens to be installed (package.json pins
 * ^1.10.0, so a routine npm i can move it), and only pinned a SHA-256 of the
 * result. That meant a routine dependency bump that drifted the template
 * even by one byte made describeVaultTemplate() throw 'template-unknown' for
 * EVERY previously-compressed record -- including ones stored long before
 * the bump -- because the 40 payload bytes those records carry were being
 * spliced into a freshly (and now differently) rebuilt reference, not the
 * one they were originally compressed against. The 40 bytes needed to
 * reconstruct exactly were sitting right there in the stored blob the whole
 * time; nothing about the drift made them unrecoverable. Re-pinning the hash
 * to match the new library output would "fix" the throw but silently
 * reconstruct OLD records against the NEW template -- wrong bytes, no error.
 *
 * The fix is to stop asking the installed library at all. This asset IS the
 * version-2 reference template, byte for byte, frozen at the moment this
 * codec was verified against a real mined mainnet transaction. Reconstruction
 * reads only this file (via templateCodec.ts's ensureTemplateCache); an
 * @bsv/templates upgrade -- or removal -- cannot change what a previously
 * (or newly) compressed record expands back into. PINNED_CONSTANT_HASH in
 * templateCodec.ts now serves as a CROSS-CHECK on this vendored asset (and,
 * separately, on whatever @bsv/templates is currently installed, via the
 * "installed library still matches the vendored template" test in
 * templateCodec.test.ts) rather than the only thing standing between a
 * dependency bump and an unrecoverable deposit record.
 *
 * PROVENANCE: built from @bsv/templates@1.10.0's R1K1Wallet().lock() output
 * (R1K1_LOCK_LEN = 959,632 bytes), with both variable runs -- offsets 17..36
 * (the 20-byte R1 commitment) and 959609..959628 (the 20-byte
 * k1PublicKeyHash) -- zeroed before compression. Those runs are never read
 * back out of this asset: expandScript always overwrites them with a
 * compressed record's own payload bytes, so it does not matter that this
 * copy holds zeros there rather than any particular real script's values.
 * Zeroing them here (rather than vendoring one arbitrary instance's real
 * random values) is what lets PINNED_CONSTANT_HASH's masking-then-hashing
 * cross-check reduce to a plain SHA-256 of this asset, as documented there.
 *
 * Regenerating this file (only ever appropriate alongside minting a new
 * template version, never as a routine refresh):
 *   1. const bytes = (await new R1K1Wallet().lock(new Array(20).fill(0), new Array(20).fill(0))).toBinary()
 *   2. zero bytes[17..36] and bytes[959609..959628] (they already are, with
 *      the all-zero inputs above, but do it explicitly -- see templateCodec.ts)
 *   3. gzip level 9 (measured: 959,632 -> 8,059 bytes) -- Node's zlib is fine
 *      for this one-off, maintainer-run build step; only the RUNTIME decode
 *      path needs to avoid it (see below)
 *   4. base64-encode the gzip bytes and split into the lines below
 *
 * Decoded at runtime with fflate's gunzipSync, never Node's zlib or the DOM
 * DecompressionStream -- this file ships to React Native/Hermes, which has
 * neither. fflate is already a real dependency (see package.json and
 * patches/@bsv+templates+1.10.0.patch, which moved @bsv/templates itself
 * onto fflate.gunzipSync for exactly this reason) and is a standard gzip
 * decoder, so it reads gzip bytes produced by any conformant encoder
 * (verified: Node zlib's output here decodes byte-identically via
 * fflate.gunzipSync).
 *
 * Do not hand-edit the payload below.
 */

/** Gzip-compressed bytes of the 959,632-byte zeroed reference template,
 * base64-encoded and split across lines for a readable diff. Join and
 * base64-decode, then gunzip, to recover the raw template -- see
 * ensureTemplateCache in templateCodec.ts. */
export const VAULT_TEMPLATE_GZIP_BASE64: string = [
  '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',
  '4hKXuMQlLgW59EYucYlLXOISl4Jc2plLXOISl7jEpSCXduISl7jEJS5xKcilN3CJS1ziEpe4FOTS67nEJS5xiUtcCnJpRy5xiUtc4hKXglzagUtc4hKX',
  'uMSlIJdexyUucYlLXOJSkEuv5RKXuMQlLnEpyKXtucQlLnGJS1wKcuk1XOISl7jEJS4FufRqLnGJS1ziEpeCXHoVl7jEJS5xiUtBLm3HJS5xiUtc4lKQ',
  'S6/kEpe4xCUucSnIpW25xCUucYlLXApy6RVc4hKXuMQlLgW51M4lLnGJS1ziUpBLbVziEpe4xCUuBbn0ci5xiUtc4hKXglx6GZe4xCUucYlLQS5twyUu',
  'cYlLXOJSkEsv5RKXuMQlLnEpyKWtucQlLnGJS1wKcuklXOISl7jEJS4FufRiLnGJS1ziEpeCXHoRl7jEJS5xiUtBLo3nEpe4xCUucSnIpa24xCUucYlL',
  'XApy6YVc4hKXuMQlLgW5tCWXuMQlLnGJS0EuvYBLXOISl7jEpSCXns8lLnGJS1ziUpBLz+MSl7jEJS5xKcelaVjCEpawhCUs5bB0KJawhCUsYQlLOSxN',
  'xRKWsIQlLGEph6VDsIQlLGEJS1jKYWkKlrCEJSxhCUs5LE3GEpawhCUsYSmHpYOxhCUsYQlLWMphaRKWsIQlLGEJSzks9WIJS1jCEpawlMNSD5awhCUs',
  'YQlLOSx1YwlLWMISlrCUw1IXlrCEJSxhCUs5LFWxhCUsYQlLWMphqYIlLGEJS1jCUg5LnVjCEpawhCUs5bC0kEpUohKVqESlnB+Wlk4fuQCbtt56d723',
  '3lPvHU2cphS6QycXw2lSIZx6i6Rnj5yfrnr3aPLUXSjdNcJTb30Snv7uJI4WT12Feao2FlUbi4ZHXKs0ujd9AQtYwPqnwWo2m9317pGfEors9IU2yNbi',
  'Intw1yiupVpoLdVGdRTXUim0lmLfl/cX2TH06tWrV69evXr16n2GemVlZWVl7dWysrKysrKysrKysrKysrKyfmeuV69evXr16tWrV69evXr16tWrV69e',
  'vXr16tWrV69evXr16n2m1tDqqxWblFJrFpqhV2ikUbPYML9NM0H6WuX2ueW2wb5Sq2Ow2WwNPHufxtKhDswqtw2OgeMslwbmtcbKcTZd02fdcVbqnfVl',
  'm/7obw23+ocWdda76oVGR/UUifcUmi9WZHJZpdAqioywqhca0tVVH7WxTJ3FVlItNO6uyEKMh9KrV69evXr16tVrPJSsrKysrL1aVlZWVlZWVlZWVlZW',
  'VlbW7zX06tWrV69evXr16tWrV69evXr16tWrV69evXr16tWrV69evcZDbfZ4qCKLKDZJqrvYmJChIs39Q0UmVywpMp2jyDoafV2Nvv8aVNXqrC9pNZf0',
  'tXdsN/2RNdeu2nDC8vErL3h4/eonNj3p1bNmNZsLho/sOL12zpalf/A48fwZ/wk8uGjfkKQOAA=='
].join('')

/** Length of the raw (post-gunzip) template -- equal to R1K1_LOCK_LEN in
 * services/vault/r1k1.ts. Recorded here too so templateCodec.ts can
 * sanity-check the inflated size without importing r1k1.ts just for this one
 * constant. */
export const VAULT_TEMPLATE_RAW_LENGTH = 959_632
