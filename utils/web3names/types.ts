/**
 * web3names — on-chain name resolution for BSV Browser.
 *
 * Resolves ODNCA-governed web3 names (alex.web3, pay@alex.web3) to their
 * current on-chain holder, with every answer independently verifiable:
 * signature (ODNCA-STD-001 §6), live outpoint, and merkle proof against
 * the on-chain state commitment (ODNCA-STD-004 §6). The resolver endpoint
 * is configurable data transport — never a trust anchor.
 */

export interface Outpoint {
  txid: string
  vout: number
}

/** Signed resolver answer — ODNCA-STD-001 §4. */
export interface ResolveAnswer {
  ok: true
  v: number
  input: string
  name: string
  mailbox: string | null
  source: string
  fallback: boolean
  holder_address: string
  holder_script: string
  origin: Outpoint
  current: Outpoint
  as_of_height: number
  expires: number
  sig: string
  signer: string
}

export interface ResolveError {
  ok: false
  error: string
  message?: string
}

export type ResolveResult = ResolveAnswer | ResolveError

/** One step of a merkle inclusion path (ODNCA proof object). */
export interface MerkleStep {
  hash: string
  pos: 'left' | 'right'
}

/** Injected primitives — the module itself has zero dependencies. */
export interface CryptoDeps {
  /** SHA-256 over raw bytes. */
  sha256: (data: Uint8Array) => Uint8Array
  /** Verify a DER-hex ECDSA (secp256k1) signature over a 32-byte hash. */
  ecdsaVerifyDer: (msgHash32Hex: string, derSigHex: string, compressedPubKeyHex: string) => boolean
}

/** Fetch a raw transaction by txid (hex) — any source; integrity is proven by the txid itself. */
export type TxSource = (txid: string) => Promise<string>

export interface Web3NamesConfig {
  /** Conformant resolver endpoint. Any operator works; this is transport, not trust. */
  resolverUrl: string
  /** Pinned resolver signing key (compressed hex). Pin on first use; rotate via signed announcement. */
  resolverPubKey: string
  /** Refresh interval for the TLD set, ms. */
  tldRefreshMs: number
}

export const DEFAULT_CONFIG: Web3NamesConfig = {
  resolverUrl: 'https://sns.ordnet.io',
  resolverPubKey: '03088f1da3bfc998c1bc7bbc1ffcb7d96c47e094624a52d78406f8c3105b0d0b46',
  tldRefreshMs: 10 * 60 * 1000
}
