import { useState, useCallback, useRef } from 'react'

interface UsePermissionQueueOptions {
  /** Open/close the associated modal. Omit for queues without a modal (e.g. BTMS). */
  openModal?: (open: boolean) => void
  isFocused: () => Promise<boolean>
  onFocusRequested: () => void | Promise<void>
  onFocusRelinquished: () => void | Promise<void>
}

interface PermissionQueue<T> {
  requests: T[]
  /** Add an item to the queue. Handles focus request and modal open on first item. */
  enqueue: (item: T) => void
  /** Remove the first item. Closes modal and relinquishes focus when empty. */
  advance: (onAdvance?: (head: T) => void) => void
}

/**
 * Generic permission request queue with focus management.
 *
 * Deduplicates the identical queue logic used by basket, certificate,
 * protocol, spending, and BTMS permission systems.
 */
export function usePermissionQueue<T>(opts: UsePermissionQueueOptions): PermissionQueue<T> {
  const { openModal, isFocused, onFocusRequested, onFocusRelinquished } = opts
  const [requests, setRequests] = useState<T[]>([])
  const wasOriginallyFocusedRef = useRef(false)

  const enqueue = useCallback(
    (item: T) => {
      // Read length before updating so the side-effect runs outside the updater.
      // React may double-invoke updaters in Strict Mode; this avoids double focus requests.
      setRequests(prev => {
        if (prev.length === 0) {
          // Schedule focus/modal on next microtask, outside the updater
          Promise.resolve().then(() => {
            isFocused().then(currentlyFocused => {
              wasOriginallyFocusedRef.current = currentlyFocused
              if (!currentlyFocused) onFocusRequested()
              openModal?.(true)
            })
          })
        }
        return [...prev, item]
      })
    },
    [isFocused, onFocusRequested, openModal]
  )

  const advance = useCallback(
    (onAdvance?: (head: T) => void) => {
      setRequests(prev => {
        if (prev.length > 0 && onAdvance) {
          onAdvance(prev[0])
        }
        const newQueue = prev.slice(1)
        if (newQueue.length === 0) {
          openModal?.(false)
          if (!wasOriginallyFocusedRef.current) onFocusRelinquished()
        }
        return newQueue
      })
    },
    [openModal, onFocusRelinquished]
  )

  return { requests, enqueue, advance }
}
