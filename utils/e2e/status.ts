/**
 * A tiny status string the e2e build paints with a stable testID.
 * Maestro reads the id (`e2e-status-page-home`) instead of WebView text,
 * which is unreliable across Android and iOS accessibility trees.
 *
 * Production builds call `noteE2E` and it returns immediately.
 */

import { isE2EBuild } from './policy'

type Listener = (status: string) => void

let status = 'boot'
const listeners = new Set<Listener>()

export function getE2EStatus(): string {
  return status
}

export function subscribeE2EStatus(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function setE2EStatus(next: string): void {
  const trimmed = next.slice(0, 80)
  if (trimmed === status) return
  status = trimmed
  listeners.forEach(listener => listener(status))
}

/** Safe to call from any build. No-ops unless this is the e2e bundle. */
export function noteE2E(next: string): void {
  if (!isE2EBuild()) return
  setE2EStatus(next)
}
