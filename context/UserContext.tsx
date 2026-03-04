import React, { createContext, Dispatch, SetStateAction, useMemo, useState } from 'react'
import packageJson from '../package.json'

// Define the NativeHandlers interface here to avoid circular dependency
export interface NativeHandlers {
  isFocused: () => Promise<boolean>
  onFocusRequested: () => Promise<void>
  onFocusRelinquished: () => Promise<void>
  onDownloadFile: (fileData: Blob, fileName: string) => Promise<boolean>
}

// Default no-op implementations for Tauri functions
const defaultNativeHandlers: NativeHandlers = {
  isFocused: async () => false,
  onFocusRequested: async () => {},
  onFocusRelinquished: async () => {},
  // Default implementation uses browser's download API
  onDownloadFile: async (fileData: Blob, fileName: string) => {
    try {
      // Create a URL for the blob
      const url = window.URL.createObjectURL(fileData)

      // Create a temporary link element
      const link = document.createElement('a')
      link.href = url
      link.download = fileName

      // Append to body, click, and clean up
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)

      // Release the blob URL
      window.URL.revokeObjectURL(url)

      return true
    } catch (error) {
      console.error('Download failed:', error)
      return false
    }
  }
}

// -----
// UserContextProps Component Props
// -----
interface UserContextProps {
  appVersion?: string
  appName?: string
  children?: React.ReactNode
  nativeHandlers?: NativeHandlers
}

export interface UserContextValue {
  isFocused: () => Promise<boolean>
  onFocusRequested: () => Promise<void>
  onFocusRelinquished: () => Promise<void>
  onDownloadFile: (fileData: Blob, fileName: string) => Promise<boolean>
  appVersion: string
  appName: string
  basketAccessModalOpen: boolean
  setBasketAccessModalOpen: Dispatch<SetStateAction<boolean>>
  certificateAccessModalOpen: boolean
  setCertificateAccessModalOpen: Dispatch<SetStateAction<boolean>>
  protocolAccessModalOpen: boolean
  setProtocolAccessModalOpen: Dispatch<SetStateAction<boolean>>
  spendingAuthorizationModalOpen: boolean
  setSpendingAuthorizationModalOpen: Dispatch<SetStateAction<boolean>>
  btmsAccessModalOpen: boolean
  setBtmsAccessModalOpen: Dispatch<SetStateAction<boolean>>
  pageLoaded: boolean
  setPageLoaded: Dispatch<SetStateAction<boolean>>
}

export const UserContext = createContext<UserContextValue>({} as UserContextValue)

/**
 * The UserInterface component supports both new and returning users.
 * For returning users, if a snapshot exists it is loaded and once authenticated
 * the AuthRedirector (inside Router) sends them to the dashboard.
 * New users see the WalletConfig UI.
 */
export const UserContextProvider: React.FC<UserContextProps> = ({
  appVersion = packageJson.version,
  appName = 'BSV Browser',
  children,
  nativeHandlers = defaultNativeHandlers
}) => {
  const [basketAccessModalOpen, setBasketAccessModalOpen] = useState(false)
  const [certificateAccessModalOpen, setCertificateAccessModalOpen] = useState(false)
  const [protocolAccessModalOpen, setProtocolAccessModalOpen] = useState(false)
  const [spendingAuthorizationModalOpen, setSpendingAuthorizationModalOpen] = useState(false)
  const [btmsAccessModalOpen, setBtmsAccessModalOpen] = useState(false)
  const [pageLoaded, setPageLoaded] = useState(false)

  const userContext = useMemo(
    () => ({
      isFocused: nativeHandlers.isFocused,
      onFocusRequested: nativeHandlers.onFocusRequested,
      onFocusRelinquished: nativeHandlers.onFocusRelinquished,
      onDownloadFile: nativeHandlers.onDownloadFile,
      appVersion,
      appName,
      basketAccessModalOpen,
      setBasketAccessModalOpen,
      certificateAccessModalOpen,
      setCertificateAccessModalOpen,
      protocolAccessModalOpen,
      setProtocolAccessModalOpen,
      spendingAuthorizationModalOpen,
      setSpendingAuthorizationModalOpen,
      btmsAccessModalOpen,
      setBtmsAccessModalOpen,
      pageLoaded,
      setPageLoaded
    }),
    [
      appVersion,
      appName,
      basketAccessModalOpen,
      certificateAccessModalOpen,
      protocolAccessModalOpen,
      spendingAuthorizationModalOpen,
      btmsAccessModalOpen,
      pageLoaded
    ]
  )

  return <UserContext.Provider value={userContext}>{children}</UserContext.Provider>
}
