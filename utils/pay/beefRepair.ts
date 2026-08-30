/**
 * Re-fetch a payment's proof from WhatsOnChain when the one the sender shipped
 * no longer verifies.
 *
 * A PeerPay token carries an AtomicBEEF minted at send time. Its merkle path
 * proves an ancestor against the block that contained it *then*. If that block
 * is later reorged out, the path is stale: the transaction is still perfectly
 * real and still has the same txid, but no chain tracker will confirm its root,
 * and `internalizeAction` rejects the whole thing as
 * "The tx parameter must be valid AtomicBEEF" — an error about the proof,
 * phrased as if the transaction were malformed.
 *
 * Re-fetching by txid repairs exactly that. What comes back is the same
 * transaction — the txid pins it, so nothing about the outputs, the amount or
 * the derivation can change under us — carrying whatever proof is current. The
 * sender is not trusted any further than they already were: we ask the network
 * for the ancestry of a transaction the sender named, and a mismatched or
 * unusable answer is discarded rather than passed on.
 *
 * This CANNOT repair the offline case. When `isValidRootForHeight` refuses
 * because the device has no network (OfflineFirstChaintracks.ts:55), a fetch
 * cannot succeed either — that payment is retryable later, not repairable now,
 * and `makeBeefRepair` declines rather than burning an attempt on it.
 */
import { Beef, Utils } from '@bsv/sdk'
import type { WocConfig } from '@/utils/pay/rails/address'

/** Injectable for tests; production uses global fetch. */
export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>

/**
 * The current AtomicBEEF for `txid`, or undefined if the network cannot supply
 * a usable one.
 *
 * Every failure returns undefined rather than throwing: the caller is already
 * handling a failed payment, and a repair that cannot be made must leave that
 * original failure intact rather than replacing it with a fetch error.
 */
export async function refetchAtomicBeef(args: {
  woc: WocConfig
  txid: string
  fetchImpl?: FetchLike
}): Promise<number[] | undefined> {
  const { woc, txid } = args
  const doFetch = args.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)

  let bytes: number[]
  try {
    const resp = await doFetch(`${woc.apiBase}/v1/bsv/${woc.segment}/tx/${txid}/beef`)
    // Checked, because the body of a 404 is prose. `Utils.toArray(prose, 'hex')`
    // throws "Invalid hex string", and an empty body parses to a Beef whose
    // magic check fails — both of which would surface as a confusing error from
    // a code path the user never asked for.
    if (!resp.ok) return undefined
    const hex = (await resp.text()).trim()
    if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return undefined
    bytes = Utils.toArray(hex, 'hex')
  } catch {
    return undefined
  }

  try {
    const beef = new Beef()
    beef.mergeBeef(bytes)
    // findAtomicTransaction walks the beef and hangs every ancestor and merkle
    // path off the transaction, which is what makes toAtomicBEEF able to emit a
    // self-contained proof. It returns undefined if the service answered about
    // some other transaction.
    const tx = beef.findAtomicTransaction(txid)
    if (!tx) return undefined

    // Throws rather than emitting a partial beef when an input has no source
    // transaction — precisely the ancestry gap we must not hand onward.
    const atomic = tx.toAtomicBEEF()

    // Do not return something that will fail the same way. This is the exact
    // structural half of the toolbox's own check
    // (signer/methods/internalizeAction.js:92, allowTxidOnly = false); the
    // merkle roots are the wallet's chain tracker to judge, not ours.
    const check = Beef.fromBinary(atomic)
    if (check.atomicTxid !== txid) return undefined
    if (!check.verifyValid(false).valid) return undefined

    return atomic
  } catch {
    return undefined
  }
}

/**
 * A repair function for `internalizeIncoming`, or undefined when repair is not
 * possible right now.
 *
 * `online` is consulted first so an offline device declines instead of
 * attempting a fetch that must fail — see the note at the top of this file.
 */
export function makeBeefRepair(args: {
  woc: WocConfig
  online: () => Promise<boolean>
  fetchImpl?: FetchLike
}): (txid: string) => Promise<number[] | undefined> {
  return async (txid: string) => {
    if (!(await args.online())) return undefined
    return refetchAtomicBeef({ woc: args.woc, txid, fetchImpl: args.fetchImpl })
  }
}
