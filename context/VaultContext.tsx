/**
 * VaultContext — the React face of the ceremony singleton.
 *
 * Subscribes to the shared CeremonyController (services/vault/ceremonyHost) and
 * republishes its state to the ceremony sheet, and owns the *effects* of a
 * ceremony: on arm, play the open sound + success haptic; on relock, play the
 * close sound + confirm haptic and toast.
 *
 * WalletContext owns the unplug→relock wiring; this owns the user-facing
 * feedback. They never fire the same haptic twice — the pairing rules live in
 * hooks/useConfirmationSound.
 */
import React, { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react'
import { ceremony } from '@/services/vault/ceremonyHost'
import { CeremonyState } from '@/services/vault/ceremony'
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

  useEffect(() => ceremony.subscribe(setState), [])

  // Effects of a completed ceremony: the open cue, and nothing else. `onArmed`
  // deliberately ignores its VaultKeyHandle argument — the unwrapped node must
  // never reach React state or a closure that outlives the operation (see
  // VaultKeyHandle in services/vault/ceremony.ts). There is no key queue to
  // replenish here either: deposit addresses derive from the private node on
  // demand, and no xpub is stored anywhere.
  useEffect(() => {
    ceremony.onArmed = () => {
      haptics.success()
      sounds.vaultOpen()
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
  }, [])

  const submitPin = useCallback((pin: string) => ceremony.submitPin(pin), [])
  const cancel = useCallback(() => ceremony.cancel(), [])
  const retry = useCallback(() => ceremony.retry(), [])

  const value = useMemo(() => ({ state, submitPin, cancel, retry }), [state, submitPin, cancel, retry])
  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>
}

export const useVault = (): VaultContextValue => useContext(VaultContext)
