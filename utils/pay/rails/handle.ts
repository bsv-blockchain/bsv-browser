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
import type { IncomingPayment, PaymentToken, PeerPayClient } from '@bsv/message-box-client'
import { Transaction } from '@bsv/sdk'
import { markOutboxSent, saveOutboxEntry, updateOutboxEntry, type OutboxEntry } from '@/utils/peerpay/outbox'

export const MESSAGE_BOX_URL_KEY = 'message_box_url'
export const DEFAULT_MESSAGE_BOX_URL = 'https://messagebox.babbage.systems'
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
      description
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

/**
 * Pay a handle. Four steps, in this order, for the reason in the file header:
 *   1 mint + broadcast the token   2 persist it   3 deliver it   4 mark sent
 * A throw from step 3 leaves an `unsent` entry, which the Outgoing list offers
 * for manual retry.
 */
export async function sendViaHandle(args: {
  client: Pick<PeerPayClient, 'createPaymentToken' | 'sendMessage'>
  storage: StorageLike
  recipient: string
  satoshis: number
  messageBoxUrl: string
}): Promise<{ outboxId: string; satoshis: number }> {
  const { client, storage, recipient, messageBoxUrl } = args
  const sats = Math.round(Number(args.satoshis))
  if (!Number.isFinite(sats) || sats <= 0) throw new Error('Invalid amount')

  const token = await client.createPaymentToken({ recipient, amount: sats })
  // A send-max request asks for maxPossibleSatoshis and the wallet rewrites the
  // output to whatever the inputs could fund, so the token minted above still
  // carries the sentinel as its amount. The recipient displays token.amount, so
  // deliver the real figure: the BRC-29 module builds with randomizeOutputs:
  // false and outputIndex 0, making output 0 authoritative.
  if (sats === 2099999999999999) {
    const tx = Transaction.fromAtomicBEEF(token.transaction as number[])
    const paid = tx.outputs[0]?.satoshis
    if (typeof paid !== 'number' || paid <= 0) throw new Error('Could not determine send-max amount')
    token.amount = paid
  }
  const outboxId = await saveOutboxEntry(storage, {
    recipient,
    token: token as PaymentToken & { transaction: number[] },
    messageBoxUrl
  })
  await client.sendMessage({
    recipient,
    messageBox: PAYMENT_INBOX,
    body: JSON.stringify(token)
  })
  await markOutboxSent(storage, outboxId)
  return { outboxId, satoshis: token.amount }
}

/** Re-deliver a persisted token. The transaction is already broadcast; only delivery is retried. */
export async function retryDelivery(args: {
  client: Pick<PeerPayClient, 'sendMessage'>
  storage: StorageLike
  entry: OutboxEntry
}): Promise<void> {
  const { client, storage, entry } = args
  await updateOutboxEntry(storage, entry.id, { lastAttemptAt: new Date().toISOString() })
  try {
    await client.sendMessage({
      recipient: entry.recipient,
      messageBox: PAYMENT_INBOX,
      body: JSON.stringify(entry.token)
    })
    await markOutboxSent(storage, entry.id)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    await updateOutboxEntry(storage, entry.id, { lastError: message })
    throw e
  }
}
