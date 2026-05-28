import React, { createContext, useCallback, useContext, useMemo, useRef, useState, useEffect } from 'react'
import { Platform } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { useLocalStorage } from './LocalStorageProvider'
import { useWallet } from './WalletContext'

interface BrowserModeContextType {
  isWeb2Mode: boolean
  setWeb2Mode: (enabled: boolean) => void
  toggleMode: () => void
  showWeb3Benefits: (onContinue: () => void, onGoToLogin: () => void) => void
  hideWeb3Benefits: () => void
  web3BenefitsVisible: boolean
  web3BenefitsCallbacks: {
    onContinue: (() => void) | null
    onGoToLogin: (() => void) | null
  }
  isAuthenticated: boolean
}

const BrowserModeContext = createContext<BrowserModeContextType>({
  isWeb2Mode: true,
  setWeb2Mode: () => {},
  toggleMode: () => {},
  showWeb3Benefits: () => {},
  hideWeb3Benefits: () => {},
  web3BenefitsVisible: false,
  web3BenefitsCallbacks: {
    onContinue: null,
    onGoToLogin: null
  },
  isAuthenticated: false
})

export const useBrowserMode = () => {
  const context = useContext(BrowserModeContext)
  if (!context) {
    throw new Error('useBrowserMode must be used within a BrowserModeProvider')
  }
  return context
}

interface BrowserModeProviderProps {
  children: React.ReactNode
}

export const BrowserModeProvider: React.FC<BrowserModeProviderProps> = ({ children }) => {
  const [isWeb2Mode, setIsWeb2Mode] = useState(true)
  const [web3BenefitsVisible, setWeb3BenefitsVisible] = useState(false)
  const [web3BenefitsCallbacks, setWeb3BenefitsCallbacks] = useState<{
    onContinue: (() => void) | null
    onGoToLogin: (() => void) | null
  }>({
    onContinue: null,
    onGoToLogin: null
  })
  const { getItem, setItem } = useLocalStorage()
  const { managers, walletBuilding } = useWallet()
  const params = useLocalSearchParams()

  // Track whether the init effect has resolved so the auth effect doesn't
  // race against it on the very first render cycle.
  const initResolved = useRef(false)

  // Check if user is authenticated (logged in with Web3 identity)
  const isAuthenticated = !!managers?.walletManager?.authenticated

  // Debug logging for authentication state changes
  useEffect(() => {
    console.log('[BrowserMode] Authentication state changed:', {
      isAuthenticated,
      walletManager: !!managers?.walletManager,
      authenticated: managers?.walletManager?.authenticated,
      isWeb2Mode,
      platform: Platform.OS
    })
  }, [isAuthenticated, managers?.walletManager, managers?.walletManager?.authenticated, isWeb2Mode])

  // Initialize mode from URL params or stored preference (runs once on mount)
  useEffect(() => {
    const initializeMode = async () => {
      console.log('[BrowserMode] Initializing mode with params:', params.mode)

      // Check if mode is specified in URL params
      if (params.mode === 'web2') {
        console.log('[BrowserMode] Setting web2 mode from URL params')
        setIsWeb2Mode(true)
        await setItem('browserMode', 'web2')
      } else if (params.mode === 'web3') {
        console.log('[BrowserMode] Setting web3 mode from URL params')
        setIsWeb2Mode(false)
        await setItem('browserMode', 'web3')
      } else {
        // Load from stored preference
        const stored = await getItem('browserMode')
        if (stored === 'web3') {
          console.log('[BrowserMode] Restoring web3 mode from storage')
          setIsWeb2Mode(false)
        } else {
          // No stored value or stored as 'web2' → default to web2
          console.log('[BrowserMode] Defaulting to web2 mode (stored:', stored, ')')
          setIsWeb2Mode(true)
        }
      }
      initResolved.current = true
    }

    initializeMode()
  }, [params.mode, getItem, setItem])

  // Auto-switch mode based on authentication state.
  // When the wallet becomes authenticated, switch to web3 mode.
  // When the wallet is torn down (logout), switch to web2 mode.
  // NOTE: isWeb2Mode is intentionally excluded from deps to avoid a
  // feedback loop where the effect triggers itself.
  useEffect(() => {
    // Don't race with the init effect on the first mount
    if (!initResolved.current) return

    const updateModeBasedOnAuth = async () => {
      if (isAuthenticated) {
        // User is logged in with Web3 identity, switch to web3 mode
        console.log('[BrowserMode] User authenticated, switching to web3 mode')
        setIsWeb2Mode(false)
        await setItem('browserMode', 'web3')
      } else if (managers?.walletManager === undefined && !walletBuilding) {
        // Wallet manager was cleared (logout) AND no build is in progress.
        // If walletBuilding is true, the wallet is still initializing (e.g.
        // biometric auth pending) — don't flip to web2 prematurely.
        console.log('[BrowserMode] Wallet manager cleared, switching to web2 mode')
        setIsWeb2Mode(true)
        await setItem('browserMode', 'web2')
      }
    }

    updateModeBasedOnAuth()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, setItem, managers, walletBuilding])

  const setWeb2Mode = useCallback(
    async (enabled: boolean) => {
      setIsWeb2Mode(enabled)
      await setItem('browserMode', enabled ? 'web2' : 'web3')
    },
    [setItem]
  )

  // Keep a ref in sync with isWeb2Mode so toggleMode can read current state
  const isWeb2ModeRef = useRef(isWeb2Mode)
  useEffect(() => {
    isWeb2ModeRef.current = isWeb2Mode
  }, [isWeb2Mode])

  const toggleMode = useCallback(async () => {
    const newMode = !isWeb2ModeRef.current
    setIsWeb2Mode(newMode)
    await setItem('browserMode', newMode ? 'web2' : 'web3')
  }, [setItem])

  const showWeb3Benefits = useCallback((onContinue: () => void, onGoToLogin: () => void) => {
    setWeb3BenefitsCallbacks({ onContinue, onGoToLogin })
    setWeb3BenefitsVisible(true)
  }, [])

  const hideWeb3Benefits = useCallback(() => {
    setWeb3BenefitsVisible(false)
    setWeb3BenefitsCallbacks({ onContinue: null, onGoToLogin: null })
  }, [])

  const value = useMemo(
    () => ({
      isWeb2Mode,
      setWeb2Mode,
      toggleMode,
      showWeb3Benefits,
      hideWeb3Benefits,
      web3BenefitsVisible,
      web3BenefitsCallbacks,
      isAuthenticated
    }),
    [
      isWeb2Mode,
      setWeb2Mode,
      toggleMode,
      showWeb3Benefits,
      hideWeb3Benefits,
      web3BenefitsVisible,
      web3BenefitsCallbacks,
      isAuthenticated
    ]
  )

  return <BrowserModeContext.Provider value={value}>{children}</BrowserModeContext.Provider>
}
