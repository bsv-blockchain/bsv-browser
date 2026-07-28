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
}): Promise<{ outboxId: string }> {
  const { client, storage, recipient, messageBoxUrl } = args
  const sats = Math.round(Number(args.satoshis))
  if (!Number.isFinite(sats) || sats <= 0) throw new Error('Invalid amount')

  const token = await client.createPaymentToken({ recipient, amount: sats })
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
  return { outboxId }
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
