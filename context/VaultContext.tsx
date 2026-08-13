/**
 * VaultContext — the React face of the ceremony singleton.
 *
 * Subscribes to the shared CeremonyController (services/vault/ceremonyHost) and
 * republishes its state to the ceremony sheet, and owns the *effects* of a
 * ceremony: on arm, replenish the deposit-key queue (reusing the just-armed
 * retention window, so no extra touch) and play the open sound + success
 * haptic; on relock, play the close sound + confirm haptic and toast.
 *
 * WalletContext owns the keyGetter and the unplug→relock wiring; this owns the
 * user-facing feedback. They never fire the same haptic twice — the pairing
 * rules live in hooks/useConfirmationSound.
 */
import React, { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react'
import { ceremony } from '@/services/vault/ceremonyHost'
import { CeremonyState } from '@/services/vault/ceremony'
import { replenishDepositKeys, VaultWallet } from '@/services/vault/transfers'
import { vaultStore } from '@/services/vault/vaultStore'
import { useWallet } from '@/context/WalletContext'
import { sounds } from '@/hooks/useConfirmationSound'
import { haptics } from '@/hooks/useHaptics'
import { showToast } from '@/components/ui/Toast'
import i18n from '@/context/i18n/translations'

interface VaultContextValue {
  state: CeremonyState
  submitPin: (pin: string) => void
  cancel: () => void
  retry: () => void
}

const VaultContext = createContext<VaultContextValue>({
  state: { phase: 'idle' },
  submitPin: () => {},
  cancel: () => {},
  retry: () => {}
})

export const VaultProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, setState] = useState<CeremonyState>(ceremony.state)
  const { managers, adminOriginator } = useWallet()

  useEffect(() => ceremony.subscribe(setState), [])

  // Effects of a completed ceremony: reuse the armed window to top up deposit
  // keys, then the open cue.
  useEffect(() => {
    ceremony.onArmed = () => {
      haptics.success()
      sounds.vaultOpen()
      const pm = managers?.permissionsManager
      if (pm) {
        vaultStore
          .isEnrolled()
          .then(enrolled => {
            if (enrolled) return replenishDepositKeys(pm as unknown as VaultWallet, adminOriginator)
          })
          .catch(() => {
            /* replenish is best-effort; a deposit will re-request a ceremony if the queue is empty */
          })
      }
    }
    ceremony.onRelock = () => {
      haptics.confirm()
      sounds.vaultClose()
      showToast(i18n.t('vault_locked'), { type: 'info' })
    }
    return () => {
      ceremony.onArmed = undefined
      ceremony.onRelock = undefined
    }
  }, [managers?.permissionsManager, adminOriginator])

  const submitPin = useCallback((pin: string) => ceremony.submitPin(pin), [])
  const cancel = useCallback(() => ceremony.cancel(), [])
  const retry = useCallback(() => ceremony.retry(), [])

  const value = useMemo(() => ({ state, submitPin, cancel, retry }), [state, submitPin, cancel, retry])
  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>
}

export const useVault = (): VaultContextValue => useContext(VaultContext)
