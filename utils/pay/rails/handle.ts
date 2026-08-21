/**
 * The handle rail — remote, asynchronous payments addressed by identity key and
 * delivered through a MessageBox (PeerPay).
 *
 * Ported from app/payments.tsx. The one invariant worth restating: the outbox
 * write happens BEFORE delivery is attempted. The payment token holds the
 * derivation data for a transaction that has already been broadcast, so losing
 * it between broadcast and delivery loses the money — persisting first is what
 * makes a crash recoverable.
 */
import type { IncomingPayment, PeerPayClient } from '@bsv/message-box-client'
import { P2PKH, PublicKey, Random, Transaction, Utils } from '@bsv/sdk'
import { BRC29_PROTOCOL_ID } from '@/utils/pay/rails/address'
import {
  markOutboxSent,
  removeOutboxEntry,
  saveOutboxEntry,
  updateOutboxEntry,
  type OutboxEntry
} from '@/utils/peerpay/outbox'

export const MESSAGE_BOX_URL_KEY = 'message_box_url'
export const DEFAULT_MESSAGE_BOX_URL = 'https://gmb.bsvblockchain.tech'
/** The previous default. A saved preference equal to it is treated as "use the
 * default", so existing installs follow the default forward. */
export const LEGACY_MESSAGE_BOX_URL = 'https://messagebox.babbage.systems'
/** The sentinel the config panel writes when the user opts out of a server. */
export const NO_MESSAGE_BOX = 'noMessageBox'

/** The message box outbound payments are delivered into. */
const PAYMENT_INBOX = 'payment_inbox'

interface StorageLike {
  getKeyValue: (key: string) => Promise<string | undefined>
  setKeyValue: (key: string, value: string) => Promise<void>
}

interface InternalizingWallet {
  internalizeAction(args: unknown, originator?: string): Promise<unknown>
}

/**
 * A shareable payment link for a handle.
 *
 * Deliberately the same `peerpay:` form the app already parses
 * (utils/parsePeerPayURI.ts) and already routes (app/+native-intent.ts), so a
 * tapped link lands on /pay with the recipient filled in. A non-positive amount
 * emits no query at all — `sats=0` would be an invalid link, and an open
 * request is exactly the absence of a figure.
 */
export function peerPayLinkFor(identityKey: string, sats?: number): string {
  const amount = sats !== undefined ? Math.round(Number(sats)) : NaN
  return Number.isFinite(amount) && amount > 0 ? `peerpay:${identityKey}?sats=${amount}` : `peerpay:${identityKey}`
}

/** Credit an incoming payment, then acknowledge it. Never acknowledge first. */
export async function internalizeIncoming(
  wallet: InternalizingWallet,
  client: Pick<PeerPayClient, 'acknowledgeMessage'>,
  adminOriginator: string,
  payment: IncomingPayment,
  description: string
): Promise<void> {
  // A note the sender attached to the token becomes the description the
  // recipient's wallet records — same field the sender's action carries.
  const note = (payment.token as { note?: unknown }).note
  const noted = typeof note === 'string' && note.trim().length > 0 ? note.trim().slice(0, 500) : undefined
  await wallet.internalizeAction(
    {
      tx: payment.token.transaction,
      outputs: [
        {
          paymentRemittance: {
            derivationPrefix: payment.token.customInstructions.derivationPrefix,
            derivationSuffix: payment.token.customInstructions.derivationSuffix,
            senderIdentityKey: payment.sender
          },
          outputIndex: payment.token.outputIndex ?? 0,
          protocol: 'wallet payment'
        }
      ],
      labels: ['peerpay'],
      // Same rule as the sender's side: the note verbatim, space-padded to the
      // 5-byte validation floor when it is shorter.
      description: noted ? noted.padEnd(5) : description
    },
    adminOriginator
  )
  await client.acknowledgeMessage({ messageIds: [payment.messageId] })
}

/**
 * One retry against a re-listed payment. A token can go stale between listing
 * and accepting (the sender re-sent, the box re-issued the message id), and the
 * fresh copy usually internalizes cleanly.
 */
export async function acceptWithRetry(
  client: Pick<PeerPayClient, 'listIncomingPayments'>,
  messageBoxUrl: string,
  payment: IncomingPayment,
  description: string,
  internalize: (p: IncomingPayment, d: string) => Promise<void>
): Promise<void> {
  try {
    await internalize(payment, description)
  } catch {
    const list = await client.listIncomingPayments(messageBoxUrl)
    const fresh = list.find(x => String(x.messageId) === String(payment.messageId))
    if (!fresh) throw new Error('Payment not found on refresh')
    await internalize(fresh, description)
  }
}

// ── The inbox ──
//
// An arriving payment is credited automatically. Accepting was never a decision
// a user could act on — the money is already theirs, the token is already in
// their box, and refusing it only leaves it there — so the tap it required was
// ceremony. What IS a decision is what to do about one the wallet cannot credit,
// and that is the only case the UI shows.

/** A payment the wallet has failed to credit, and how many times. */
export interface InboxAttempt {
  attempts: number
  error: string
}

/**
 * How many times a payment is credited automatically before a human is asked.
 *
 * Two, not one: the common failure is transient (offline, a locked database, a
 * stale token) and a second pass usually clears it. Not unbounded, because a
 * structurally corrupt payment can never succeed, and retrying it every poll
 * forever is a wallet write per tick against money that will never arrive.
 */
export const MAX_AUTO_ATTEMPTS = 2

/** Whether this payment has stopped being retried and now needs a person. */
export function needsAttention(state: InboxAttempt | undefined): boolean {
  return !!state && state.attempts >= MAX_AUTO_ATTEMPTS
}

/**
 * Credit everything in the box that is still worth attempting.
 *
 * The credit itself is injected, so this function holds only the policy: what to
 * attempt, what to leave alone, and what to remember. Returns a fresh attempt
 * map rather than mutating, and that map is rebuilt from the payments actually
 * present — a message that has left the box takes its state with it, so the map
 * cannot grow without bound across a long-lived screen.
 */
export async function autoAcceptInbox<T extends { messageId: string | number }>(args: {
  payments: T[]
  attempts: Record<string, InboxAttempt>
  accept: (payment: T) => Promise<void>
  /** Message ids to attempt even though they had given up — a user pressed Retry. */
  force?: string[]
}): Promise<{ accepted: number; attempts: Record<string, InboxAttempt> }> {
  const { payments, attempts, accept } = args
  const forced = new Set(args.force ?? [])
  const next: Record<string, InboxAttempt> = {}
  let accepted = 0

  for (const payment of payments) {
    const id = String(payment.messageId)
    const state = attempts[id]

    // Already given up on, and nobody asked again: keep the row and its error
    // exactly as it is. This is the line that stops the retry loop.
    if (needsAttention(state) && !forced.has(id)) {
      next[id] = state
      continue
    }

    try {
      await accept(payment)
      accepted++
      // Success clears the history: the payment is credited and acknowledged, so
      // there is nothing left to show or retry.
    } catch (e) {
      next[id] = {
        attempts: (state?.attempts ?? 0) + 1,
        error: e instanceof Error && e.message ? e.message : String(e)
      }
    }
  }

  return { accepted, attempts: next }
}

/**
 * Give up on a payment: acknowledge it without crediting it.
 *
 * This ABANDONS money. The acknowledge removes the message from the box, so the
 * payment will never be listed again and this wallet can never credit it — the
 * only recovery is asking the sender to send again. It exists because a
 * structurally corrupt payment would otherwise sit in the list for good, and it
 * must never be one tap away.
 */
export async function discardIncoming(
  client: Pick<PeerPayClient, 'acknowledgeMessage'>,
  payment: { messageId: string }
): Promise<void> {
  await client.acknowledgeMessage({ messageIds: [payment.messageId] })
}

/** What the handle rail needs from the wallet: mint a noSend BRC-29 action,
 * broadcast it later with sendWith, and abort it if the payment is cancelled. */
export interface HandleRailWallet {
  getPublicKey(args: unknown, originator?: string): Promise<{ publicKey: string }>
  createAction(args: unknown, originator?: string): Promise<{ txid?: string; tx?: number[] }>
  listActions(args: unknown, originator?: string): Promise<{ actions: { txid?: string; reference?: string }[] }>
  abortAction(args: unknown, originator?: string): Promise<unknown>
}

/** Broadcast a previously-minted noSend transaction. A createAction call whose
 * only job is `options.sendWith` — no new outputs are created. */
async function broadcastNoSend(
  wallet: Pick<HandleRailWallet, 'createAction'>,
  adminOriginator: string,
  txid: string
): Promise<void> {
  await wallet.createAction(
    { description: 'PeerPay payment broadcast', options: { sendWith: [txid] } },
    adminOriginator
  )
}

/**
 * Pay a handle. Five steps, in this order:
 *   1 mint the token with noSend (nothing hits the network yet)
 *   2 persist it   3 deliver it   4 broadcast   5 mark sent
 * The transaction is only broadcast once the recipient's message box has the
 * token: a delivery failure therefore leaves nothing on-chain, and the entry
 * can be retried — or cancelled, which aborts the action and frees its inputs.
 * A throw from step 3 or 4 leaves an `unsent` entry with `delivered` recording
 * how far it got, so retry re-attempts only what is still outstanding.
 */
export async function sendViaHandle(args: {
  wallet: HandleRailWallet
  adminOriginator: string
  client: Pick<PeerPayClient, 'sendMessage'>
  storage: StorageLike
  recipient: string
  satoshis: number
  messageBoxUrl: string
  /** User's note for the payment. Becomes the action description and rides in
   * the token, so the recipient's wallet can show it too. */
  note?: string
  /** Resolved display name, used only for the default description. */
  recipientName?: string
}): Promise<{ outboxId: string; satoshis: number }> {
  const { wallet, adminOriginator, client, storage, recipient, messageBoxUrl, recipientName } = args
  const sats = Math.round(Number(args.satoshis))
  if (!Number.isFinite(sats) || sats <= 0) throw new Error('Invalid amount')

  // The note IS the description when one was given — verbatim; otherwise
  // "Pay <who>". BRC-100 requires 5–2000 bytes and the validator does not
  // trim, so a very short note is padded with trailing spaces rather than
  // decorated, and everything is clamped at the top end.
  const note = args.note?.trim() || undefined
  const description = (note ?? `Pay ${recipientName?.trim() || recipient.slice(0, 8)}`).slice(0, 500).padEnd(5)

  // Standard BRC-29: fresh prefix/suffix, key derived toward the recipient.
  const derivationPrefix = Utils.toBase64(Random(8))
  const derivationSuffix = Utils.toBase64(Random(8))
  const { publicKey } = await wallet.getPublicKey(
    {
      protocolID: BRC29_PROTOCOL_ID,
      keyID: `${derivationPrefix} ${derivationSuffix}`,
      counterparty: recipient
    },
    adminOriginator
  )
  const lockingScript = new P2PKH().lock(PublicKey.fromString(publicKey).toAddress()).toHex()

  const car = await wallet.createAction(
    {
      description,
      labels: ['peerpay'],
      outputs: [
        {
          lockingScript,
          satoshis: sats,
          outputDescription: 'PeerPay payment',
          customInstructions: JSON.stringify({ derivationPrefix, derivationSuffix, type: 'BRC29' })
        }
      ],
      // noSend: broadcast is deferred until the token is delivered. Output 0 is
      // pinned so a send-max rewrite (maxPossibleSatoshis) can be read back.
      options: { noSend: true, randomizeOutputs: false }
    },
    adminOriginator
  )
  if (!car.tx || !car.txid) throw new Error('Wallet did not return a signed transaction')

  // Authoritative amount off the transaction itself — covers send-max, where
  // the requested figure is the sentinel and the wallet wrote the real one.
  const paid = Transaction.fromAtomicBEEF(car.tx).outputs[0]?.satoshis
  if (typeof paid !== 'number' || paid <= 0) throw new Error('Could not determine paid amount')

  const token = {
    customInstructions: { derivationPrefix, derivationSuffix },
    transaction: car.tx,
    amount: paid,
    // Not in the PaymentToken spec, but harmless extra JSON to wallets that
    // ignore it — and this app's receive side shows it as the description.
    ...(note ? { note } : {})
  }
  const outboxId = await saveOutboxEntry(storage, { recipient, token, messageBoxUrl, txid: car.txid })
  await client.sendMessage({
    recipient,
    messageBox: PAYMENT_INBOX,
    body: JSON.stringify(token)
  })
  // Delivered is persisted before the broadcast is attempted: from here the
  // recipient holds the token, so a retry must never re-mint or cancel-abort —
  // only the broadcast is still outstanding.
  await updateOutboxEntry(storage, outboxId, { delivered: true })
  await broadcastNoSend(wallet, adminOriginator, car.txid)
  await markOutboxSent(storage, outboxId)
  return { outboxId, satoshis: paid }
}

/**
 * Cancel an undelivered outbox entry: abort the noSend action (freeing its
 * inputs — nothing was ever broadcast) and remove the entry.
 *
 * Once `delivered` is set the token is in the recipient's message box and the
 * transaction must not be aborted out from under them, so only the entry is
 * removed; the transaction remains in the wallet's activity, where the nosend
 * row still offers a manual abort if the user truly wants it.
 *
 * Legacy entries (no txid) were broadcast at creation; there is nothing to
 * abort for them either.
 */
export async function cancelOutboxPayment(args: {
  wallet: Pick<HandleRailWallet, 'listActions' | 'abortAction'>
  adminOriginator: string
  storage: StorageLike
  entry: Pick<OutboxEntry, 'id' | 'txid' | 'delivered'>
}): Promise<{ aborted: boolean }> {
  const { wallet, adminOriginator, storage, entry } = args
  let aborted = false
  if (entry.txid && entry.delivered !== true) {
    try {
      // createAction returns no reference for a completed noSend action, so the
      // abort handle is recovered from listActions by txid.
      const { actions } = await wallet.listActions({ labels: ['peerpay'], limit: 1000 }, adminOriginator)
      const match = actions.find(a => a.txid === entry.txid)
      if (match?.reference) {
        await wallet.abortAction({ reference: match.reference }, adminOriginator)
        aborted = true
      }
    } catch {
      // The entry is still removed: the nosend row remains visible in wallet
      // activity with its own abort control, so the money is never stranded
      // invisibly.
    }
  }
  await removeOutboxEntry(storage, entry.id)
  return { aborted }
}

/**
 * Whether an error from the handle rail means "the message box server could not
 * be reached" rather than anything about the payment itself. The raw shapes —
 * whatwg-fetch's `TypeError: Network request failed`, the auth middleware's
 * "Network error while sending authenticated request to <host>/.well-known/auth",
 * timeouts — all point the user at the same fix: the message box URL in
 * settings. The UI maps this to that message instead of surfacing the raw text.
 */
export function isMessageBoxNetworkError(e: unknown): boolean {
  const message = e instanceof Error ? e.message : typeof e === 'string' ? e : ''
  return /network request failed|network error|timed? ?out|timeout/i.test(message)
}

/**
 * Retry a stuck entry, resuming from wherever it failed: deliver the token if
 * the recipient never got it, then broadcast if the transaction is still
 * noSend. Legacy entries (no txid) were broadcast at creation, so only their
 * delivery is retried.
 */
export async function retryDelivery(args: {
  wallet: Pick<HandleRailWallet, 'createAction'>
  adminOriginator: string
  client: Pick<PeerPayClient, 'sendMessage'>
  storage: StorageLike
  entry: OutboxEntry
}): Promise<void> {
  const { wallet, adminOriginator, client, storage, entry } = args
  await updateOutboxEntry(storage, entry.id, { lastAttemptAt: new Date().toISOString() })
  try {
    if (entry.delivered !== true) {
      await client.sendMessage({
        recipient: entry.recipient,
        messageBox: PAYMENT_INBOX,
        body: JSON.stringify(entry.token)
      })
      await updateOutboxEntry(storage, entry.id, { delivered: true })
    }
    if (entry.txid) {
      await broadcastNoSend(wallet, adminOriginator, entry.txid)
    }
    await markOutboxSent(storage, entry.id)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    await updateOutboxEntry(storage, entry.id, { lastError: message })
    throw e
  }
}
