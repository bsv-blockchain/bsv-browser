/**
 * Spendable wallet balance for the send surfaces — the same figure the wallet
 * screen shows, read the same two ways: the cached figure immediately (so the
 * line never opens empty), then straight to our own SQLite rather than through
 * WalletStorageManager's FIFO reader lock (see storage/methods/walletBalanceSql
 * and the storage-lock notes in app/wallet.tsx). The wallet's own listOutputs
 * path stays as the fallback for the window before storage and the user id are
 * known. Refreshes on txStatusVersion bumps so a completed send updates it.
 */
import { useEffect, useRef, useState } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { sdk } from '@bsv/wallet-toolbox-mobile'
import { useWallet } from '@/context/WalletContext'
import { readWalletBalance } from '@/storage/methods/walletBalanceSql'

export function useSpendableBalance(): number | null {
  const { managers, adminOriginator, selectedNetwork, storage, txStatusVersion, walletUserId } = useWallet()
  const [balance, setBalance] = useState<number | null>(null)
  const cacheKey = `cached_wallet_balance_${selectedNetwork}`
  // One read at a time; a bump arriving mid-read is served by that read.
  const inFlightRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const cached = await AsyncStorage.getItem(cacheKey)
      if (!cancelled && cached != null) setBalance(prev => (prev == null ? Number(cached) : prev))

      if (inFlightRef.current) return
      inFlightRef.current = true
      try {
        let total: number | null = null
        if (storage && walletUserId != null) {
          total = await readWalletBalance(storage, walletUserId)
        }
        if (total == null) {
          const pm = managers?.permissionsManager
          if (!pm) return
          const { totalOutputs } = await pm.listOutputs({ basket: sdk.specOpWalletBalance }, adminOriginator)
          total = totalOutputs ?? 0
        }
        if (!cancelled) setBalance(total)
        await AsyncStorage.setItem(cacheKey, String(total))
      } catch {
        // Keep the last known figure: a failed read is not "zero satoshis".
      } finally {
        inFlightRef.current = false
      }
    })()
    return () => {
      cancelled = true
    }
    // Data deps only — see app/wallet.tsx on why callback identity must not
    // be a dependency here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, storage, walletUserId, managers?.permissionsManager, txStatusVersion])

  return balance
}
