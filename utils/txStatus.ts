/**
 * Transaction status, collapsed into four tones for at-a-glance reading.
 *
 * The old list gave EVERY row a tinted pill, so a healthy wallet was a wall of
 * green and the one row that actually needed the user could not win attention.
 * Here the settled tone carries NO chroma at all: quiet text, no pill. Colour
 * is spent only where the user might have to act.
 *
 * Labels and translation keys are unchanged — this only changes how a status is
 * rendered, never what it is called.
 */

export type StatusTone = 'settled' | 'inflight' | 'attention' | 'failed'

export interface TxStatusView {
  /** i18n key for the human label. */
  key: string
  tone: StatusTone
}

/**
 * Map a raw action status (and any live offline-queue state) to a tone.
 *
 * The offline queue row outranks the raw status: a held transaction sits at
 * 'unproven' (which would read as a settled "Accepted") or at 'nosend' when
 * payer-side promotion failed, so without this the user would see a confirmed
 * payment that has not actually gone anywhere.
 */
export function txStatusView(status: string, offlineStatus?: string): TxStatusView {
  switch (offlineStatus) {
    case 'queued':
      return { key: 'tx_status_offline_queued', tone: 'inflight' }
    case 'posting':
      return { key: 'tx_status_offline_sending', tone: 'inflight' }
    case 'rejected':
      return { key: 'tx_status_offline_rejected', tone: 'failed' }
  }

  switch (status) {
    case 'completed':
      return { key: 'tx_status_confirmed', tone: 'settled' }
    case 'unproven':
      return { key: 'tx_status_accepted', tone: 'settled' }
    case 'sending':
      return { key: 'tx_status_broadcasting', tone: 'inflight' }
    case 'nosend':
      return { key: 'tx_status_not_sent', tone: 'attention' }
    case 'unsigned':
      return { key: 'tx_status_unsigned', tone: 'attention' }
    case 'nonfinal':
      return { key: 'tx_status_nonfinal', tone: 'attention' }
    case 'failed':
      return { key: 'tx_status_failed', tone: 'failed' }
    default:
      return { key: status, tone: 'settled' }
  }
}

/** Colour for a tone. `settled` deliberately returns the quiet text colour. */
export function toneColor(tone: StatusTone, colors: Record<string, string>): string {
  switch (tone) {
    case 'settled':
      return colors.textSecondary
    case 'inflight':
      return colors.info
    case 'attention':
      return colors.warning
    case 'failed':
      return colors.error
  }
}

/** Settled rows get no pill — only states the user might act on are boxed. */
export const tonePill = (tone: StatusTone): boolean => tone !== 'settled'
