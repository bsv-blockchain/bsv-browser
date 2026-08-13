/**
 * Vault balance — the sum of outputs in the `admin vault` basket. Separate from
 * the main wallet balance (which is managed-change-only and deliberately
 * excludes vault funds). Refreshes on txStatusVersion bumps and on demand
 * after a transfer.
 */
import { useCallback, useEffect, useState } from 'react'
import { useWallet } from '@/context/WalletContext'
import { getVaultBalance, VaultWallet } from '@/services/vault/transfers'

export function useVaultBalance(): { balance: number | null; loading: boolean; refresh: () => void } {
  const { managers, adminOriginator, txStatusVersion } = useWallet()
  const [balance, setBalance] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(() => {
    const pm = managers?.permissionsManager
    if (!pm) return
    setLoading(prev => (balance === null ? true : prev))
    getVaultBalance(pm as unknown as VaultWallet, adminOriginator)
      .then(setBalance)
      .catch(() => {
        /* leave the last known balance in place on a transient failure */
      })
      .finally(() => setLoading(false))
  }, [managers?.permissionsManager, adminOriginator, balance])

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [managers?.permissionsManager, adminOriginator, txStatusVersion])

  return { balance, loading, refresh }
}
