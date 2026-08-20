/**
 * Types for `@bsv/templates/R1K1Wallet.artifact.ts`.
 *
 * The package maps that subpath through its `exports` map (`./*.ts` ->
 * `./dist/src/*.d.ts`), but this project's tsconfig inherits Expo's classic
 * `node` module resolution, which does not read `exports` — so the subpath
 * resolves at runtime and is untyped at compile time. Declaring it here keeps
 * the upstream cross-check in __tests__/vault/templateUpstream.test.ts fully
 * typed instead of pushing it through an `any`.
 *
 * Only the names upstream actually exports are declared. `R1_K1_R1_SLOT_OFFSET`
 * and `R1_K1_R1_CODE_SEPARATOR_OFFSET` exist in its source but are absent from
 * its export list, and adding them here would compile against something that is
 * `undefined` at runtime.
 */
declare module '@bsv/templates/R1K1Wallet.artifact.ts' {
  /** Length of the compiled, UNBAKED R1-K1 template. */
  export const R1_K1_TEMPLATE_BYTE_LENGTH: number
  /** SHA-256 of that template. */
  export const R1_K1_TEMPLATE_SHA256: string
  /** Offset of the k1 constructor slot within the unbaked template. */
  export const R1_K1_K1_SLOT_OFFSET: number
  /** Base64 gzip of the unbaked template. */
  export const R1_K1_TEMPLATE_GZIP_BASE64: string
}
