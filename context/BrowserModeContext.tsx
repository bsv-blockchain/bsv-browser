import React, { createContext, useContext, useState, useEffect } from 'react'
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
  const { managers } = useWallet()
  const params = useLocalSearchParams()

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

  // Initialize mode from URL params or stored preference
  useEffect(() => {
    const initializeMode = async () => {
      console.log('[BrowserMode] Initializing mode with params:', params.mode)

      // Check if mode is specified in URL params
      if (params.mode === 'web2') {
        console.log('[BrowserMode] Setting web2 mode from URL params')
        setIsWeb2Mode(true)
        // Store this preference
        await setItem('browserMode', 'web2')
      } else if (params.mode === 'web3') {
        console.log('[BrowserMode] Setting web3 mode from URL params')
        setIsWeb2Mode(false)
        await setItem('browserMode', 'web3')
      } else {
        // Load from stored preference
        try {
          const storedMode = await getItem('browserMode')
          setIsWeb2Mode(false)
        } catch (error) {
          setIsWeb2Mode(true)
        }
      }
    }

    initializeMode()
  }, [params.mode, getItem, setItem])

  // Auto-switch to web3 mode when user logs in
  // Note: Don't auto-switch to web2 when logged out, respect user's choice
  useEffect(() => {
    const updateModeBasedOnAuth = async () => {
      if (isAuthenticated) {
        // User is logged in with Web3 identity, switch to web3 mode
        console.log('[BrowserMode] User authenticated, switching to web3 mode')
        setIsWeb2Mode(false)
        await setItem('browserMode', 'web3')
      }
      // Don't automatically switch to web2 mode when not authenticated
      // This allows users who chose "Continue without login" to stay in their chosen mode
    }

    updateModeBasedOnAuth()
  }, [isAuthenticated, setItem])

  const setWeb2Mode = async (enabled: boolean) => {
    setIsWeb2Mode(enabled)
    await setItem('browserMode', enabled ? 'web2' : 'web3')
  }

  const toggleMode = async () => {
    const newMode = !isWeb2Mode
    setIsWeb2Mode(newMode)
    await setItem('browserMode', newMode ? 'web2' : 'web3')
  }

  const showWeb3Benefits = (onContinue: () => void, onGoToLogin: () => void) => {
    setWeb3BenefitsCallbacks({ onContinue, onGoToLogin })
    setWeb3BenefitsVisible(true)
  }

  const hideWeb3Benefits = () => {
    setWeb3BenefitsVisible(false)
    setWeb3BenefitsCallbacks({ onContinue: null, onGoToLogin: null })
  }

  const value = {
    isWeb2Mode,
    setWeb2Mode,
    toggleMode,
    showWeb3Benefits,
    hideWeb3Benefits,
    web3BenefitsVisible,
    web3BenefitsCallbacks,
    isAuthenticated
  }

  return <BrowserModeContext.Provider value={value}>{children}</BrowserModeContext.Provider>
}
