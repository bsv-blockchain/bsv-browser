/**
 * Trust anchors for the local header window.
 *
 * A checkpoint is the last header we trust WITHOUT having validated it, so the
 * window starts at `height + 1` and its first header must name `hash` as its
 * previous hash. Nothing enters the store unless it chains back to one of these
 * — which is what stops a compromised or wrong chaintracks deployment from
 * feeding us a merkle root we would then accept money against.
 *
 * Values fetched from the arcade chaintracks deployments on 2026-07-28.
 *
 *  · main — height 907,324, mined 2025-07-27, about one year and 52,560 blocks
 *    behind the 959,884 tip at the time of writing. One year of headers is
 *    ~4.2 MB. Bump this in a future release to prune.
 *  · test — height 1,697,402, about 52,560 blocks behind its 1,749,962 tip.
 *  · ttn — height 0. The whole teratest chain was 27,502 blocks (~2.2 MB), so
 *    windowing it buys nothing and starting from genesis costs nothing.
 */
export interface HeaderCheckpoint {
  /** Height of the last a-priori-trusted header. The window starts above it. */
  height: number
  /** Block hash in display order. */
  hash: string
}

export const HEADER_CHECKPOINTS: Record<'main' | 'test' | 'ttn', HeaderCheckpoint> = {
  main: {
    height: 907324,
    hash: '00000000000000000ccc802efeef429acb6b670a6b2bac373ece30f7d2df3e26'
  },
  test: {
    height: 1697402,
    hash: '0000000000ae922fff32ff94055b7b1c3963c6b5fd04e2b25f3c52d1708498e7'
  },
  ttn: {
    height: 0,
    hash: '000000000499eabba0a88f5b3747231c74b9191c1a4a04b2c2ea817976b7776d'
  }
}
