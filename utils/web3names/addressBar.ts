/**
 * Address-bar hook. Conservative by design: an input is only classified as
 * a web3 name when it parses as one AND its TLD is in the recognised set —
 * everything else falls through untouched to the existing URL/search logic,
 * so normal browsing behaviour never changes.
 */

import { parseWeb3Name } from './names'
import { isKnownTld } from './tlds'

export type AddressClassification =
  | { kind: 'web3', address: string, name: string, mailbox: string | null }
  | { kind: 'passthrough' }

export function classifyAddressInput (input: string): AddressClassification {
  const parsed = parseWeb3Name(input)
  if (!parsed) return { kind: 'passthrough' }
  if (!isKnownTld(parsed.tld)) return { kind: 'passthrough' }
  return { kind: 'web3', address: parsed.address, name: parsed.name, mailbox: parsed.mailbox }
}
