/** Jest/Metro alias to the unmodified @bsv/sdk pure-JS ECDSA module. */
declare module '@bsv/sdk-original-ecdsa' {
  import type { BigNumber, Signature, Point } from '@bsv/sdk'

  export function sign(
    msg: BigNumber,
    key: BigNumber,
    forceLowS?: boolean,
    customK?: BigNumber | ((iter: number) => BigNumber)
  ): Signature

  export function verify(msg: BigNumber, sig: Signature, key: Point): boolean
}
