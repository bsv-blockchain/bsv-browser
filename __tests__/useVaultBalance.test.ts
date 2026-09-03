/**
 * `useVaultBalance` must not refetch while a vault transfer is mid-flight
 * (ceremony phase 'preparing' / 'broadcasting'): in that window the spent
 * vault UTXO is gone and its change is still unsent, so `listOutputs` reads 0
 * — a partial withdrawal would flash "balance: 0" at exactly the moment the
 * user is most nervous. The last known figure stays up until the ceremony
 * leaves the busy window, then one refresh adopts the real post-transfer
 * balance (the busy→idle transition itself must refetch, because any
 * txStatusVersion bumps that landed DURING the freeze were deliberately
 * swallowed).
 */
let mockWalletCtx: { managers: unknown; adminOriginator: string; txStatusVersion: number }
let mockVaultPhase: string

jest.mock('@/context/WalletContext', () => ({
  useWallet: () => mockWalletCtx
}))
jest.mock('@/context/VaultContext', () => ({
  useVault: () => ({ state: { phase: mockVaultPhase }, submitPin: () => {}, cancel: () => {}, retry: () => {} })
}))
jest.mock('@/services/vault/transfers', () => ({
  getVaultBalance: jest.fn()
}))

import { act, renderHook } from '@testing-library/react-native'
import { getVaultBalance } from '@/services/vault/transfers'
import { useVaultBalance } from '@/hooks/useVaultBalance'

const fetchBalance = getVaultBalance as jest.Mock

const settle = async () => {
  await act(async () => {
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))
  })
}

beforeEach(() => {
  fetchBalance.mockReset()
  mockWalletCtx = { managers: { permissionsManager: {} }, adminOriginator: 'admin', txStatusVersion: 0 }
  mockVaultPhase = 'idle'
})

describe('useVaultBalance', () => {
  test('idle: fetches on mount and again on a txStatusVersion bump', async () => {
    fetchBalance.mockResolvedValue(500)
    const { result, rerender } = renderHook(() => useVaultBalance())
    await settle()
    expect(result.current.balance).toBe(500)
    expect(fetchBalance).toHaveBeenCalledTimes(1)

    mockWalletCtx = { ...mockWalletCtx, txStatusVersion: 1 }
    rerender(undefined)
    await settle()
    expect(fetchBalance).toHaveBeenCalledTimes(2)
  })

  test.each(['preparing', 'broadcasting'])(
    'freezes during %s: a txStatusVersion bump does not refetch and the last figure stays up',
    async phase => {
      fetchBalance.mockResolvedValue(500)
      const { result, rerender } = renderHook(() => useVaultBalance())
      await settle()
      expect(result.current.balance).toBe(500)

      // Transfer in flight: the vault UTXO is spent, its change not yet
      // spendable — a fetch here would read 0.
      mockVaultPhase = phase
      fetchBalance.mockResolvedValue(0)
      mockWalletCtx = { ...mockWalletCtx, txStatusVersion: 1 }
      rerender(undefined)
      await settle()

      expect(fetchBalance).toHaveBeenCalledTimes(1) // no refetch during the freeze
      expect(result.current.balance).toBe(500) // last known figure survives
    }
  )

  test('leaving the busy window refetches once and adopts the real post-transfer balance', async () => {
    fetchBalance.mockResolvedValue(500)
    const { result, rerender } = renderHook(() => useVaultBalance())
    await settle()

    mockVaultPhase = 'broadcasting'
    mockWalletCtx = { ...mockWalletCtx, txStatusVersion: 1 } // bump swallowed by the freeze
    rerender(undefined)
    await settle()
    expect(fetchBalance).toHaveBeenCalledTimes(1)

    // Broadcast done, ceremony released → the change output is now real.
    mockVaultPhase = 'idle'
    fetchBalance.mockResolvedValue(320)
    rerender(undefined)
    await settle()
    expect(fetchBalance).toHaveBeenCalledTimes(2) // the thaw itself refetches
    expect(result.current.balance).toBe(320)
  })
})
