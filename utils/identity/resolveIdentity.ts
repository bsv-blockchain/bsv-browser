/**
 * Identity resolution — turning a bare BSV identity key into something a person
 * recognises.
 *
 * Lifted verbatim out of app/payments.tsx so more than one screen can use it.
 * Nothing here is new behaviour; the only change is the file it lives in.
 *
 * Every entry point is NETWORK-DEPENDENT and BEST-EFFORT. `resolveByIdentityKey`
 * reaches an overlay through the wallet, and avatar resolution can add a second
 * hop through UHRP storage. Callers must treat a null result as "not known
 * here, right now" and never as a fact about the peer — and must never make a
 * money decision wait on one. A nearby payment in particular may well be
 * happening precisely because the network is unreachable.
 */
import { IdentityClient, StorageDownloader } from '@bsv/sdk'
import type { DisplayableIdentity, WalletInterface } from '@bsv/sdk'

/** Drops repeats by identityKey, keeping the first occurrence. */
export const uniqueIdentities = (results: DisplayableIdentity[]) => {
  return results.filter((identity, index) => {
    return results.findIndex(i => i.identityKey === identity.identityKey) === index
  })
}

/**
 * Picks a usable avatar URL. An http(s) URL wins outright; anything else is
 * treated as a UHRP hash and resolved through storage, falling back to the raw
 * value so a downloader outage degrades to a broken image rather than a throw.
 */
export async function resolveAvatarURL(urls: (string | undefined)[]): Promise<string | undefined> {
  const defined = urls.filter((u): u is string => !!u)
  const httpUrl = defined.find(u => u.startsWith('http'))
  if (httpUrl) return httpUrl
  const nonHttp = defined.find(u => !!u)
  if (!nonHttp) return undefined
  try {
    const downloader = new StorageDownloader()
    const resolved = await downloader.resolve(nonHttp)
    return resolved[0] ?? nonHttp
  } catch {
    return nonHttp
  }
}

/** Folds several certificates into one record, first non-empty value winning. */
export async function mergeIdentityRecords(
  records: DisplayableIdentity[]
): Promise<DisplayableIdentity | null> {
  const merged = records.reduce<DisplayableIdentity | null>((acc, cur) => {
    if (!acc) return cur
    return {
      identityKey: acc.identityKey,
      name: acc.name || cur.name,
      avatarURL: acc.avatarURL || cur.avatarURL,
      abbreviatedKey: acc.abbreviatedKey || cur.abbreviatedKey,
      badgeIconURL: acc.badgeIconURL || cur.badgeIconURL,
      badgeLabel: acc.badgeLabel || cur.badgeLabel,
      badgeClickURL: acc.badgeClickURL || cur.badgeClickURL
    }
  }, null)
  if (!merged) return null
  const avatarURL = (await resolveAvatarURL(records.map(r => r.avatarURL))) || ''
  return { ...merged, avatarURL }
}

/**
 * Resolves one identity key. Never rejects — a lookup failure and an unknown
 * peer are indistinguishable to the caller by design, because the UI treatment
 * is the same in both cases.
 */
export async function resolveIdentity(
  idClient: IdentityClient,
  sender: string
): Promise<readonly [string, DisplayableIdentity | null]> {
  try {
    const results = await idClient.resolveByIdentityKey({ identityKey: sender, seekPermission: false })
    return [sender, await mergeIdentityRecords(results)] as const
  } catch {
    return [sender, null] as const
  }
}

/** Attribute search. Unlike resolveIdentity this one DOES throw; callers catch. */
export async function searchIdentities(
  idClient: IdentityClient,
  text: string
): Promise<DisplayableIdentity[]> {
  const results = await idClient.resolveByAttributes({
    attributes: { any: text.trim() },
    limit: 5,
    seekPermission: false
  })
  return uniqueIdentities(results)
}

/**
 * An IdentityClient for this wallet, or null if one cannot be constructed.
 *
 * Swallowing the throw is deliberate and matches the original call site: every
 * identity feature is decorative relative to the payment itself, so a client
 * that will not build must leave the screen fully usable.
 */
export function makeIdentityClient(
  wallet: WalletInterface | null | undefined,
  adminOriginator: string | undefined
): IdentityClient | null {
  if (!wallet) return null
  try {
    return new IdentityClient(wallet, undefined, adminOriginator)
  } catch {
    return null
  }
}

/**
 * The best short label for a peer: their resolved name, else null.
 *
 * Returns null rather than a placeholder so callers decide how an unknown peer
 * reads in their own context — "Unknown" is wrong in a status line that is
 * otherwise silent about identity.
 */
export function identityLabel(identity: DisplayableIdentity | null | undefined): string | null {
  const name = identity?.name?.trim()
  return name ? name : null
}
