/**
 * Vault balance — the sum of outputs in the `admin vault` basket. Separate from
 * the main wallet balance (which is managed-change-only and deliberately
 * excludes vault funds). Refreshes on txStatusVersion bumps and on demand
 * after a transfer.
 *
 * FROZEN while a transfer is mid-flight (ceremony phase 'preparing' /
 * 'broadcasting'): in that window the spent vault UTXO is gone and its change
 * is still unsent, so a fetch reads 0 — a partial withdrawal would flash
 * "balance: 0" mid-operation. The last known figure stays up; the busy→idle
 * transition refetches, covering any txStatusVersion bumps the freeze
 * swallowed.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useWallet } from '@/context/WalletContext'
import { useVault } from '@/context/VaultContext'
import { getVaultBalance, VaultWallet } from '@/services/vault/transfers'

export function useVaultBalance(): { balance: number | null; loading: boolean; refresh: () => void } {
  const { managers, adminOriginator, txStatusVersion } = useWallet()
  const { state: vaultState } = useVault()
  // The zero-read window: both transfer paths note 'preparing' BEFORE their
  // createAction and stay busy until the broadcast settles (transfers.ts).
  const transferInFlight = vaultState.phase === 'preparing' || vaultState.phase === 'broadcasting'
  const [balance, setBalance] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  // Kept in a ref so `refresh` has a stable identity. With `balance` in its deps
  // every callers' effect that lists `refresh` (app/vault.tsx does) re-ran and
  // refetched each time the figure changed.
  const balanceRef = useRef<number | null>(null)
  balanceRef.current = balance

  const refresh = useCallback(() => {
    const pm = managers?.permissionsManager
    if (!pm) return
    setLoading(prev => (balanceRef.current === null ? true : prev))
    getVaultBalance(pm as unknown as VaultWallet, adminOriginator)
      .then(setBalance)
      .catch(() => {
        /* leave the last known balance in place on a transient failure */
      })
      .finally(() => setLoading(false))
  }, [managers?.permissionsManager, adminOriginator])

  useEffect(() => {
    if (transferInFlight) return // freeze: a fetch now would read a false 0
    refresh() // also runs on the busy→idle transition, adopting the real figure
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [managers?.permissionsManager, adminOriginator, txStatusVersion, transferInFlight])

  return { balance, loading, refresh }
}
