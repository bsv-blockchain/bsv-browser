const F = 'context/WalletContext'

import React, { useState, useEffect, createContext, useMemo, useCallback, useContext, useRef } from 'react'
import {
  Wallet,
  WalletPermissionsManager,
  PrivilegedKeyManager,
  WalletStorageManager,
  WalletSigner,
  Services,
  PermissionRequest,
  SimpleWalletManager,
  Monitor,
  ChaintracksServiceClient
} from '@bsv/wallet-toolbox-mobile'
import { Beef, KeyDeriver, PrivateKey, Transaction } from '@bsv/sdk'
import {
  DEFAULT_SETTINGS,
  WalletSettings,
  WalletSettingsManager
} from '@bsv/wallet-toolbox-mobile/out/src/WalletSettingsManager'
import { toast } from 'react-toastify'
import 'react-toastify/dist/ReactToastify.css'
import { DEFAULT_WAB_URL, DEFAULT_STORAGE_URL, DEFAULT_CHAIN, ADMIN_ORIGINATOR } from './config'
import { UserContext } from './UserContext'
import { useBrowserMode } from './BrowserModeContext'
import isImageUrl from '../utils/isImageUrl'
import parseAppManifest from '../utils/parseAppManifest'
import { useLocalStorage } from '@/context/LocalStorageProvider'
import { router } from 'expo-router'
import { logWithTimestamp } from '@/utils/logging'
import { recoverMnemonicWallet } from '@/utils/mnemonicWallet'
import { StorageProvider } from '@bsv/wallet-toolbox-mobile'
import { StorageExpoSQLite } from '@/storage'
import { createBtmsModule } from '@bsv/btms-permission-module'
import { BsvExchangeRate, WalletServicesOptions, PostBeefResult, PostTxResultForTxid } from '@bsv/wallet-toolbox-mobile/out/src/sdk'
import { AppState, AppStateStatus } from 'react-native'
import RNEventSource from 'react-native-sse'


// -----
// Context Types
// -----

interface ManagerState {
  walletManager?: SimpleWalletManager
  permissionsManager?: WalletPermissionsManager
  settingsManager?: WalletSettingsManager
}

type ConfigStatus = 'editing' | 'configured' | 'initial'

export interface WalletContextValue {
  // Managers:
  managers: ManagerState
  updateManagers: (newManagers: ManagerState) => void
  // Settings
  settings: WalletSettings
  updateSettings: (newSettings: WalletSettings) => Promise<void>
  // Logout
  logout: () => void
  adminOriginator: string
  snapshotLoaded: boolean
  basketRequests: BasketAccessRequest[]
  certificateRequests: CertificateAccessRequest[]
  protocolRequests: ProtocolAccessRequest[]
  spendingRequests: SpendingRequest[]
  advanceBasketQueue: () => void
  advanceCertificateQueue: () => void
  advanceProtocolQueue: () => void
  advanceSpendingQueue: () => void
  recentApps: any[]
  finalizeConfig: (wabConfig: WABConfig) => boolean
  setConfigStatus: (status: ConfigStatus) => void
  configStatus: ConfigStatus
  selectedWabUrl: string
  selectedStorageUrl: string
  selectedMethod: string
  selectedNetwork: 'main' | 'test'
  setWalletBuilt: (current: boolean) => void
  buildWalletFromMnemonic: (mnemonic?: string) => Promise<void>
  switchNetwork: (network: 'main' | 'test') => Promise<void>
  storage: StorageExpoSQLite | null
  /** Incremented when a transaction status changes via SSE, triggers UI refresh */
  txStatusVersion: number
}

export const WalletContext = createContext<WalletContextValue>({
  managers: {},
  updateManagers: () => {},
  settings: DEFAULT_SETTINGS,
  updateSettings: async () => {},
  logout: () => {},
  adminOriginator: ADMIN_ORIGINATOR,
  snapshotLoaded: false,
  basketRequests: [],
  certificateRequests: [],
  protocolRequests: [],
  spendingRequests: [],
  advanceBasketQueue: () => {},
  advanceCertificateQueue: () => {},
  advanceProtocolQueue: () => {},
  advanceSpendingQueue: () => {},
  recentApps: [],
  finalizeConfig: () => false,
  setConfigStatus: () => {},
  configStatus: 'initial',
  selectedWabUrl: '',
  selectedStorageUrl: '',
  selectedMethod: '',
  selectedNetwork: 'main',
  setWalletBuilt: (current: boolean) => {},
  buildWalletFromMnemonic: async () => {},
  switchNetwork: async () => {},
  storage: null,
  txStatusVersion: 0
})

type PermissionType = 'identity' | 'protocol' | 'renewal' | 'basket'

type BasketAccessRequest = {
  requestID: string
  basket?: string
  originator: string
  reason?: string
  renewal?: boolean
}

type CertificateAccessRequest = {
  requestID: string
  certificate?: {
    certType?: string
    fields?: Record<string, any>
    verifier?: string
  }
  originator: string
  reason?: string
  renewal?: boolean
}

type ProtocolAccessRequest = {
  requestID: string
  protocolSecurityLevel: number
  protocolID: string
  counterparty?: string
  originator?: string
  description?: string
  renewal?: boolean
  type?: PermissionType
}

type SpendingRequest = {
  requestID: string
  originator: string
  description?: string
  transactionAmount: number
  totalPastSpending: number
  amountPreviouslyAuthorized: number
  authorizationAmount: number
  renewal?: boolean
  lineItems: any[]
}

export interface WABConfig {
  wabUrl: string
  wabInfo?: any // Optional for noWAB (self-custodial) mode
  method: string
  network: 'main' | 'test'
  storageUrl: string
}

interface WalletContextProps {
  children: React.ReactNode
}

export const WalletContextProvider: React.FC<WalletContextProps> = ({ children = <></> }) => {
  const [managers, setManagers] = useState<ManagerState>({})
  const [storage, setStorage] = useState<StorageExpoSQLite | null>(null)
  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
  const [txStatusVersion, setTxStatusVersion] = useState(0)
  const appStateRef = useRef<AppStateStatus>(AppState.currentState)
  const adminOriginator = ADMIN_ORIGINATOR
  const [recentApps, setRecentApps] = useState<any[]>([])
  const [walletBuilt, setWalletBuilt] = useState<boolean>(false)

  const { getSnap, deleteSnap, getItem, setItem, setMnemonic, getMnemonic, deleteMnemonic } = useLocalStorage()
  const { setWeb2Mode } = useBrowserMode()

  const {
    isFocused,
    onFocusRequested,
    onFocusRelinquished,
    setBasketAccessModalOpen,
    setCertificateAccessModalOpen,
    setProtocolAccessModalOpen,
    setSpendingAuthorizationModalOpen
  } = useContext(UserContext)

  // Track if we were originally focused
  const [wasOriginallyFocused, setWasOriginallyFocused] = useState(false)

  // Separate request queues for basket and certificate access
  const [basketRequests, setBasketRequests] = useState<BasketAccessRequest[]>([])
  const [certificateRequests, setCertificateRequests] = useState<CertificateAccessRequest[]>([])
  const [protocolRequests, setProtocolRequests] = useState<ProtocolAccessRequest[]>([])
  const [spendingRequests, setSpendingRequests] = useState<SpendingRequest[]>([])

  // Pop the first request from the basket queue, close if empty, relinquish focus if needed
  const advanceBasketQueue = () => {
    setBasketRequests(prev => {
      const newQueue = prev.slice(1)
      if (newQueue.length === 0) {
        setBasketAccessModalOpen(false)
        if (!wasOriginallyFocused) {
          onFocusRelinquished()
        }
      }
      return newQueue
    })
    logWithTimestamp(F, 'Advanced basket queue')
  }

  // Pop the first request from the certificate queue, close if empty, relinquish focus if needed
  const advanceCertificateQueue = () => {
    setCertificateRequests(prev => {
      const newQueue = prev.slice(1)
      if (newQueue.length === 0) {
        setCertificateAccessModalOpen(false)
        if (!wasOriginallyFocused) {
          onFocusRelinquished()
        }
      }
      return newQueue
    })
    logWithTimestamp(F, 'Advanced certificate queue')
  }

  // Pop the first request from the protocol queue, close if empty, relinquish focus if needed
  const advanceProtocolQueue = () => {
    setProtocolRequests(prev => {
      const newQueue = prev.slice(1)
      if (newQueue.length === 0) {
        setProtocolAccessModalOpen(false)
        if (!wasOriginallyFocused) {
          onFocusRelinquished()
        }
      }
      return newQueue
    })
    logWithTimestamp(F, 'Advanced protocol queue')
  }

  // Pop the first request from the spending queue, close if empty, relinquish focus if needed
  const advanceSpendingQueue = () => {
    setSpendingRequests(prev => {
      const newQueue = prev.slice(1)
      if (newQueue.length === 0) {
        setSpendingAuthorizationModalOpen(false)
        if (!wasOriginallyFocused) {
          onFocusRelinquished()
        }
      }
      return newQueue
    })
    logWithTimestamp(F, 'Advanced spending queue')
  }

  const updateSettings = useCallback(
    async (newSettings: WalletSettings) => {
      if (!managers.settingsManager) {
        throw new Error('The user must be logged in to update settings!')
      }
      await managers.settingsManager.set(newSettings)
      setSettings(newSettings)
      logWithTimestamp(F, 'Settings updated')
    },
    [managers.settingsManager]
  )

  // Provide a handler for basket-access requests that enqueues them
  const basketAccessCallback = useCallback(
    (
      incomingRequest: PermissionRequest & {
        requestID: string
        basket?: string
        originator: string
        reason?: string
        renewal?: boolean
      }
    ) => {
      // Enqueue the new request
      if (incomingRequest?.requestID) {
        setBasketRequests(prev => {
          const wasEmpty = prev.length === 0

          // If no requests were queued, handle focusing logic right away
          if (wasEmpty) {
            isFocused().then(currentlyFocused => {
              setWasOriginallyFocused(currentlyFocused)
              if (!currentlyFocused) {
                onFocusRequested()
              }
              setBasketAccessModalOpen(true)
            })
          }

          return [
            ...prev,
            {
              requestID: incomingRequest.requestID,
              basket: incomingRequest.basket,
              originator: incomingRequest.originator,
              reason: incomingRequest.reason,
              renewal: incomingRequest.renewal
            }
          ]
        })
        logWithTimestamp(F, 'Basket access request enqueued')
      }
    },
    [isFocused, onFocusRequested]
  )

  // Provide a handler for certificate-access requests that enqueues them
  const certificateAccessCallback = useCallback(
    (
      incomingRequest: PermissionRequest & {
        requestID: string
        certificate?: {
          certType?: string
          fields?: string[]
          verifier?: string
        }
        originator: string
        reason?: string
        renewal?: boolean
      }
    ) => {
      // Enqueue the new request
      if (incomingRequest?.requestID) {
        setCertificateRequests(prev => {
          const wasEmpty = prev.length === 0

          // If no requests were queued, handle focusing logic right away
          if (wasEmpty) {
            isFocused().then(currentlyFocused => {
              setWasOriginallyFocused(currentlyFocused)
              if (!currentlyFocused) {
                onFocusRequested()
              }
              setCertificateAccessModalOpen(true)
            })
          }

          // Extract certificate data, safely handling potentially undefined values
          const certificate = incomingRequest.certificate as any
          const certType = certificate?.certType || ''
          const fields = certificate?.fields || []

          // Extract field names as an array for the CertificateChip component
          const fieldsArray = fields

          const verifier = certificate?.verifier || ''

          return [
            ...prev,
            {
              requestID: incomingRequest.requestID,
              originator: incomingRequest.originator,
              verifierPublicKey: verifier,
              certificateType: certType,
              fieldsArray,
              description: incomingRequest.reason,
              renewal: incomingRequest.renewal
            }
          ]
        })
        logWithTimestamp(F, 'Certificate access request enqueued')
      }
    },
    [isFocused, onFocusRequested]
  )

  // Provide a handler for protocol permission requests that enqueues them
  const protocolPermissionCallback = useCallback(
    (args: PermissionRequest & { requestID: string }): Promise<void> => {
      const { requestID, counterparty, originator, reason, renewal, protocolID } = args

      if (!requestID || !protocolID) {
        return Promise.resolve()
      }

      const [protocolSecurityLevel, protocolNameString] = protocolID

      // Determine type of permission
      let permissionType: PermissionType = 'protocol'
      if (protocolNameString === 'identity resolution') {
        permissionType = 'identity'
      } else if (renewal) {
        permissionType = 'renewal'
      } else if (protocolNameString.includes('basket')) {
        permissionType = 'basket'
      }

      // Create the new permission request
      const newItem: ProtocolAccessRequest = {
        requestID,
        protocolSecurityLevel,
        protocolID: protocolNameString,
        counterparty,
        originator,
        description: reason,
        renewal,
        type: permissionType
      }

      // Enqueue the new request
      return new Promise<void>(resolve => {
        setProtocolRequests(prev => {
          const wasEmpty = prev.length === 0

          // If no requests were queued, handle focusing logic right away
          if (wasEmpty) {
            isFocused().then(currentlyFocused => {
              setWasOriginallyFocused(currentlyFocused)
              if (!currentlyFocused) {
                onFocusRequested()
              }
              setProtocolAccessModalOpen(true)
            })
          }

          resolve()
          return [...prev, newItem]
        })
        logWithTimestamp(F, 'Protocol permission request enqueued')
      })
    },
    [isFocused, onFocusRequested]
  )

  // Provide a handler for spending authorization requests that enqueues them
  const spendingAuthorizationCallback = useCallback(
    async (args: PermissionRequest & { requestID: string }): Promise<void> => {
      const { requestID, originator, reason, renewal, spending } = args

      if (!requestID || !spending) {
        return Promise.resolve()
      }

      let { satoshis, lineItems } = spending

      if (!lineItems) {
        lineItems = []
      }

      // TODO: support these
      const transactionAmount = 0
      const totalPastSpending = 0
      const amountPreviouslyAuthorized = 0

      // Create the new permission request
      const newItem: SpendingRequest = {
        requestID,
        originator,
        description: reason,
        transactionAmount,
        totalPastSpending,
        amountPreviouslyAuthorized,
        authorizationAmount: satoshis,
        renewal,
        lineItems
      }

      // DEBUG: log the full spending request object so we can capture a real example
      console.log('[SpendingRequest] full object:', JSON.stringify(newItem, null, 2))

      // Enqueue the new request
      return new Promise<void>(resolve => {
        setSpendingRequests(prev => {
          const wasEmpty = prev.length === 0

          // If no requests were queued, handle focusing logic right away
          if (wasEmpty) {
            isFocused().then(currentlyFocused => {
              setWasOriginallyFocused(currentlyFocused)
              if (!currentlyFocused) {
                onFocusRequested()
              }
              setSpendingAuthorizationModalOpen(true)
            })
          }

          resolve()
          return [...prev, newItem]
        })
        logWithTimestamp(F, 'Spending authorization request enqueued')
      })
    },
    [isFocused, onFocusRequested]
  )

  // ---- WAB + network + storage configuration ----
  const [selectedWabUrl, setSelectedWabUrl] = useState<string>(DEFAULT_WAB_URL)
  const [selectedMethod, setSelectedMethod] = useState<string>('')
  const [selectedNetwork, setSelectedNetwork] = useState<'main' | 'test'>(DEFAULT_CHAIN) // "test" or "main"
  const [selectedStorageUrl, setSelectedStorageUrl] = useState<string>(DEFAULT_STORAGE_URL)

  // Flag that indicates configuration is complete. For returning users,
  // if a snapshot exists we auto-mark configComplete.
  const [configStatus, setConfigStatus] = useState<ConfigStatus>('initial')
  // Used to trigger a re-render after snapshot load completes.
  const [snapshotLoaded, setSnapshotLoaded] = useState<boolean>(false)

  // Mark configuration complete. Auto-configured for local-only mode.
  const finalizeConfig = (wabConfig: WABConfig): boolean => {
    const { method, network, storageUrl } = wabConfig
    try {
      if (!network) {
        console.error('Network selection is required')
        return false
      }

      setSelectedWabUrl('noWAB')
      setSelectedMethod(method || 'mnemonic')
      setSelectedNetwork(network)
      setSelectedStorageUrl(storageUrl || 'local')

      setConfigStatus('configured')
      logWithTimestamp(F, 'Configuration finalized successfully')
      return true
    } catch (error: any) {
      console.error('Error applying configuration:', error)
      logWithTimestamp(F, 'Error applying configuration', error.message)
      return false
    }
  }

  // Auto-configure on first launch: if no stored config, set defaults
  useEffect(() => {
    ;(async () => {
      if (configStatus !== 'initial') return
      const storedConfig = await getItem('finalConfig')
      if (storedConfig) {
        try {
          const config = JSON.parse(storedConfig)
          finalizeConfig(config)
          logWithTimestamp(F, 'Auto-loaded stored configuration')
          // If mnemonic exists, auto-build wallet
          const mnemonic = await getMnemonic()
          if (mnemonic) {
            logWithTimestamp(F, 'Mnemonic found, will auto-build wallet')
          }
        } catch {
          logWithTimestamp(F, 'Failed to parse stored config, using defaults')
          finalizeConfig({ wabUrl: 'noWAB', method: 'mnemonic', network: DEFAULT_CHAIN, storageUrl: 'local' })
          await setItem('finalConfig', JSON.stringify({ wabUrl: 'noWAB', method: 'mnemonic', network: DEFAULT_CHAIN, storageUrl: 'local' }))
        }
      } else {
        // First launch: auto-configure with defaults
        logWithTimestamp(F, 'No stored config found, auto-configuring with defaults')
        finalizeConfig({ wabUrl: 'noWAB', method: 'mnemonic', network: DEFAULT_CHAIN, storageUrl: 'local' })
        await setItem('finalConfig', JSON.stringify({ wabUrl: 'noWAB', method: 'mnemonic', network: DEFAULT_CHAIN, storageUrl: 'local' }))
      }
    })()
  }, [configStatus]) // Re-run whenever configStatus resets to 'initial' (e.g. after logout)

  const getExchangeRate = async (): Promise<BsvExchangeRate> => {
    try {
      const rate = await fetch('https://api.whatsonchain.com/v1/bsv/main/exchangerate')
      const data = await rate.json()
      return {
        timestamp: new Date(),
        rate: data.rate,
        base: 'USD'
      }
    } catch (error) {
      console.error('Error fetching exchange rate:', error)
      return { 
        rate: 16.75,
        timestamp: new Date(),
        base: 'USD'
      }
    }
  }

  // Build wallet function
  const buildWallet = useCallback(
    async (primaryKey: number[], privilegedKeyManager: PrivilegedKeyManager): Promise<any> => {
      try {
        logWithTimestamp(F, 'Building wallet')
        const newManagers = {} as any
        const chain = selectedNetwork
        const keyDeriver = new KeyDeriver(new PrivateKey(primaryKey))
        const storageManager = new WalletStorageManager(keyDeriver.identityKey)
        const signer = new WalletSigner(chain, keyDeriver, storageManager)

        const bsvExchangeRate = await getExchangeRate()

        // Derive a stable callback token for ARC SSE event streaming
        const callbackToken = keyDeriver.identityKey.substring(0, 32)

        const mainnetServices: WalletServicesOptions = {
          chain: selectedNetwork,
          arcUrl: process.env?.EXPO_PUBLIC_ARC_URL ?? '',
          arcConfig: {
            apiKey: process.env?.EXPO_PUBLIC_ARC_API_KEY ?? '',
            callbackToken
          },
          bsvUpdateMsecs: 60 * 60 * 1000,
          fiatExchangeRates: {
            timestamp: new Date(),
            base: 'USD',
            rates: {
              USD: 1
            }
          },
          fiatUpdateMsecs: 60 * 60 * 1000,
          whatsOnChainApiKey: process.env?.EXPO_PUBLIC_WOC_API_KEY ?? '',
          taalApiKey: process.env?.EXPO_PUBLIC_WOC_API_KEY ?? '',
          chaintracks: new ChaintracksServiceClient(selectedNetwork, process.env?.EXPO_PUBLIC_CHAINTRACKS_URL ?? 'https://chaintracks-us-1.bsvb.tech'),
          bsvExchangeRate
        }

        const testnetServices: WalletServicesOptions = {
          chain: selectedNetwork,
          chaintracks: new ChaintracksServiceClient(selectedNetwork, process.env?.EXPO_PUBLIC_TEST_CHAINTRACKS_URL ?? 'https://chaintracks-testnet-us-1.bsvb.tech'),
          bsvExchangeRate,
          arcUrl: process.env?.EXPO_PUBLIC_TEST_ARC_URL ?? '',
          arcConfig: {
            apiKey: process.env?.EXPO_PUBLIC_TEST_ARC_API_KEY ?? '',
            callbackToken
          },
          bsvUpdateMsecs: 60 * 60 * 1000000,
          fiatExchangeRates: {
            timestamp: new Date(),
            base: 'USD',
            rates: {
              USD: 1
            }
          },
          fiatUpdateMsecs: 60 * 60 * 1000000,
          whatsOnChainApiKey: process.env?.EXPO_PUBLIC_TEST_WOC_API_KEY ?? '',
          taalApiKey: process.env?.EXPO_PUBLIC_TEST_TAAL_API_KEY ?? ''
        }

        const serviceOptions = selectedNetwork === 'main' ? mainnetServices : testnetServices
        const services = new Services(serviceOptions)

        // Replace all default broadcast providers with a single Arcade-specific one.
        // Arcade expects EF format posted to /tx, and we need all broadcasts to go
        // through our Arcade instance so SSE status events work.
        const arcadeUrl = serviceOptions.arcUrl!
        services.postBeefServices.remove('GorillaPoolArcBeef')
        services.postBeefServices.remove('TaalArcBeef')
        services.postBeefServices.add({
          name: 'Arcade',
          service: async (beef: Beef, txids: string[]): Promise<PostBeefResult> => {
            const r: PostBeefResult = { name: 'Arcade', status: 'success', txidResults: [] }
            try {
              const tx = Transaction.fromBEEF(beef.toBinary())
              const ef = tx.toEF()
              const response = await fetch(`${arcadeUrl}/tx`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/octet-stream',
                  'X-CallbackToken': callbackToken,
                  'X-FullStatusUpdates': 'true'
                },
                body: new Uint8Array(ef)
              })
              const data = await response.json()
              console.log(`[Arcade] POST /tx ${response.status}`, JSON.stringify(data))
              const txResult: PostTxResultForTxid = {
                txid: data.txid || txids[0],
                status: response.ok ? 'success' : 'error',
                notes: [{ when: new Date().toISOString(), what: 'arcadePostEF', txStatus: data.txStatus }]
              }
              if (data.txStatus === 'DOUBLE_SPEND_ATTEMPTED') {
                txResult.doubleSpend = true
                txResult.status = 'error'
              }
              r.txidResults.push(txResult)
              r.status = txResult.status
            } catch (err: any) {
              console.log(`[Arcade] POST /tx error: ${err.message}`)
              r.status = 'error'
              r.txidResults.push({
                txid: txids[0],
                status: 'error',
                serviceError: true,
                data: err.message
              })
            }
            return r
          }
        })

        const wallet = new Wallet(signer, services, undefined, privilegedKeyManager)
        newManagers.settingsManager = wallet.settingsManager

        logWithTimestamp(F, 'Wallet built successfully')

        // Use user-selected storage provider
        // Check if user selected local storage
        let phoneStorage: StorageExpoSQLite | undefined
        if (selectedStorageUrl === 'local') {
          console.log('[WalletContext] Using local SQLite storage')

          const identityKey = keyDeriver.identityKey
          phoneStorage = new StorageExpoSQLite({
            ...StorageProvider.createStorageBaseOptions(chain),
            feeModel: { model: 'sat/kb', value: 100 },
            identityKey
          })
          phoneStorage.setServices(services)
          await phoneStorage.migrate('bsv-wallet', identityKey)

          console.log('[WalletContext] Local SQLite storage initialized successfully')
          setStorage(phoneStorage)

          // addWalletStorageProvider calls makeAvailable internally
          try {
            await storageManager.addWalletStorageProvider(phoneStorage as any)
            console.log('[WalletContext] Local storage provider added to wallet')
          } catch (error) {
            console.error('[WalletContext] Failed to add local storage provider:', error)
          }
        }
        // TODO: Re-add remote storage support in future version

        logWithTimestamp(F, 'Storage manager built successfully')
        
        // Create BTMS permission module
        const btmsModule = createBtmsModule({ wallet })

        // Setup permissions with provided callbacks and BTMS module.
        const permissionsManager = new WalletPermissionsManager(wallet, adminOriginator, {
          differentiatePrivilegedOperations: true,
          seekBasketInsertionPermissions: false,
          seekBasketListingPermissions: false,
          seekBasketRemovalPermissions: false,
          seekCertificateAcquisitionPermissions: false,
          seekCertificateDisclosurePermissions: false,
          seekCertificateRelinquishmentPermissions: false,
          seekCertificateListingPermissions: false,
          seekGroupedPermission: true,
          seekPermissionsForIdentityKeyRevelation: false,
          seekPermissionsForIdentityResolution: false,
          seekPermissionsForKeyLinkageRevelation: false,
          seekPermissionsForPublicKeyRevelation: false,
          seekPermissionWhenApplyingActionLabels: false,
          seekPermissionWhenListingActionsByLabel: false,
          seekProtocolPermissionsForEncrypting: false,
          seekProtocolPermissionsForHMAC: false,
          seekProtocolPermissionsForSigning: false,
          seekSpendingPermissions: true,
          permissionModules: { btms: btmsModule }
        } as any)

        logWithTimestamp(F, 'Permissions manager built successfully')

        if (protocolPermissionCallback) {
          permissionsManager.bindCallback('onProtocolPermissionRequested', protocolPermissionCallback)
        }
        if (basketAccessCallback) {
          permissionsManager.bindCallback('onBasketAccessRequested', basketAccessCallback)
        }
        if (spendingAuthorizationCallback) {
          permissionsManager.bindCallback('onSpendingAuthorizationRequested', spendingAuthorizationCallback)
        }
        if (certificateAccessCallback) {
          permissionsManager.bindCallback('onCertificateAccessRequested', certificateAccessCallback)
        }

        // Store in window for debugging
        ;(window as any).permissionsManager = permissionsManager
        newManagers.permissionsManager = permissionsManager

        // Start background monitor for transaction status updates (sending → unproven → completed)
        try {
          const monitorOptions = Monitor.createDefaultWalletMonitorOptions(chain, storageManager, services)
          monitorOptions.callbackToken = callbackToken
          monitorOptions.EventSourceClass = RNEventSource
          monitorOptions.onTransactionStatusChanged = async (_txid: string, _newStatus: string) => {
            setTxStatusVersion(v => v + 1)
          }
          if (phoneStorage) {
            const SSE_KEY = 'sse_last_event_id'
            monitorOptions.loadLastSSEEventId = () => phoneStorage!.getKeyValue(SSE_KEY)
            monitorOptions.saveLastSSEEventId = (id: string) => phoneStorage!.setKeyValue(SSE_KEY, id)
          }
          const monitor = new Monitor(monitorOptions)
          monitor.addDefaultTasks()
          // startTasks runs in background — don't await (it never resolves until stopTasks)
          monitor.startTasks().catch(e => console.error('[WalletContext] Monitor error:', e))
          ;(window as any).walletMonitor = monitor
          logWithTimestamp(F, 'Monitor started with ARC SSE support')
        } catch (error: any) {
          console.warn('[WalletContext] Failed to start monitor:', error.message)
        }

        setManagers(m => ({ ...m, ...newManagers }))
        logWithTimestamp(F, 'Wallet build completed successfully')

        return permissionsManager
      } catch (error: any) {
        console.error('Error building wallet:', error)
        toast.error('Failed to build wallet: ' + error.message)
        logWithTimestamp(F, 'Error building wallet', error.message)
        return null
      }
    },
    [
      selectedNetwork,
      selectedStorageUrl,
      adminOriginator,
      protocolPermissionCallback,
      basketAccessCallback,
      spendingAuthorizationCallback,
      certificateAccessCallback
    ]
  )

  // Watch for wallet authentication state
  useEffect(() => {
    ;(async () => {
      logWithTimestamp(F, 'Checking authentication state')
      const snap = await getSnap()
      if (managers?.walletManager?.authenticated && snap) {
        setSnapshotLoaded(true)
        logWithTimestamp(F, 'Authentication confirmed, snapshot loaded')
      } else if (!snap && snapshotLoaded) {
        setSnapshotLoaded(false)
        logWithTimestamp(F, 'Snapshot no longer exists, resetting snapshotLoaded state')
      }
      logWithTimestamp(F, 'Authentication state check complete')
    })()
  }, [managers?.walletManager?.authenticated, snapshotLoaded, getSnap])

  // TODO: Re-add WAB (WalletAuthenticationManager) support in future version

  const buildWalletFromMnemonic = useCallback(async (providedMnemonic?: string) => {
    // Skip if wallet already built
    if (walletBuilt) {
      return
    }

    // Only build if wallet is properly configured
    if (configStatus !== 'configured') {
      return
    }

    logWithTimestamp(F, 'Checking for noWAB primary key')

    try {
      // Use provided mnemonic directly (e.g. from mnemonic screen) or read from secure storage
      const mnemonic = providedMnemonic || await getMnemonic()
      if (!mnemonic) {
        logWithTimestamp(F, 'No noWAB mnemonic found')
        return
      }

      const { rootKey, primaryKey } = recoverMnemonicWallet(mnemonic)
      logWithTimestamp(F, 'NoWAB primary key found, building wallet')

      // For noWAB, we don't need a PrivilegedKeyManager from WAB
      // We can create a simple one that always returns the primary key
      const privilegedKeyManager = new PrivilegedKeyManager(async () => rootKey)

      logWithTimestamp(F, 'privilegedKeyManager built successfully')

      // Create SimpleWalletManager and provide keys for authentication
      const snap = await getSnap()

      logWithTimestamp(F, 'snap built successfully')
      const swm = new SimpleWalletManager(ADMIN_ORIGINATOR, buildWallet, snap || undefined)

      logWithTimestamp(F, 'SimpleWalletManager built successfully')

      // Provide the primary key and privileged key manager to authenticate the wallet
      await swm.providePrimaryKey(primaryKey)

      logWithTimestamp(F, 'primaryKey provided successfully')

      await swm.providePrivilegedKeyManager(privilegedKeyManager)

      logWithTimestamp(F, 'privilegedKeyManager provided successfully')

      setManagers(m => ({
        ...m,
        walletManager: swm
      }))
      setWalletBuilt(true)
      setWeb2Mode(false)

      logWithTimestamp(F, 'walletManager built successfully')

      // Save mnemonic for next time
      await setMnemonic(mnemonic);

      logWithTimestamp(F, 'NoWAB wallet initialization completed')
    } catch (error: any) {
      console.error('[WalletContext] Error initializing noWAB wallet:', error)
      logWithTimestamp(F, 'Error initializing noWAB wallet', error.message)
    }
  }, [
    walletBuilt,
    configStatus,
    getMnemonic,
    getSnap,
    setMnemonic,
    buildWallet
  ]);

  // Switch network: tear down wallet, update config, and rebuild on new chain
  const switchNetwork = useCallback(async (network: 'main' | 'test') => {
    if (network === selectedNetwork) return
    logWithTimestamp(F, `Switching network from ${selectedNetwork} to ${network}`)

    // Stop any running monitor
    try {
      const monitor = (window as any).walletMonitor as Monitor | undefined
      if (monitor) {
        await monitor.stopTasks()
        ;(window as any).walletMonitor = undefined
      }
    } catch (e) {
      console.warn('[WalletContext] Failed to stop monitor during network switch:', e)
    }

    // Tear down current wallet state (but keep mnemonic)
    setManagers({})
    setWalletBuilt(false)
    setSnapshotLoaded(false)

    // Persist new config
    const newConfig = { wabUrl: 'noWAB', method: 'mnemonic', network, storageUrl: 'local' }
    await setItem('finalConfig', JSON.stringify(newConfig))

    // Re-finalize with new network — this triggers the auto-build effect
    finalizeConfig(newConfig)
    logWithTimestamp(F, `Network switched to ${network}`)
  }, [selectedNetwork, setItem])

  // Auto-build wallet from mnemonic for returning users
  useEffect(() => {
    if (configStatus === 'configured' && !walletBuilt) {
      buildWalletFromMnemonic()
    }
  }, [configStatus, walletBuilt, buildWalletFromMnemonic])

  // When Settings manager becomes available, populate the user's settings
  useEffect(() => {
    logWithTimestamp(F, 'Checking settings manager availability')
    const loadSettings = async () => {
      if (managers.settingsManager) {
        try {
          const userSettings = await managers.settingsManager.get()
          setSettings(userSettings)
          logWithTimestamp(F, 'Settings loaded successfully')
        } catch {
          logWithTimestamp(F, 'Failed to load settings')
          // Unable to load settings, defaults are already loaded.
        }
      }
    }

    loadSettings()
  }, [managers])

  // Fetch Arcade status events when app returns to foreground
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState: AppStateStatus) => {
      const wasBackground = appStateRef.current.match(/inactive|background/)
      const isNowForeground = nextAppState === 'active'

      if (wasBackground && isNowForeground) {
        const monitor = (window as any).walletMonitor as Monitor | undefined
        if (monitor) {
          monitor.fetchSSEEvents().then(count => {
            if (count > 0) setTxStatusVersion(v => v + 1)
          })
        }
      }

      appStateRef.current = nextAppState
    })

    return () => subscription.remove()
  }, [])

  const logout = useCallback(() => {
    // Clear localStorage to prevent auto-login
    logWithTimestamp(F, 'Initiating logout process')
    deleteSnap().then(async () => {
      // Reset manager state
      setManagers({})
      logWithTimestamp(F, 'Managers reset')

      // Reset configuration state
      // Set to 'initial' - wallet building requires 'configured' status
      setConfigStatus('initial')
      setSnapshotLoaded(false)
      setWalletBuilt(false)
      deleteMnemonic()
      logWithTimestamp(F, 'Configuration and state reset')

      // Clear recent apps (web3-specific data)
      setRecentApps([])

      // Set to web2 mode after logout so user can browse normally
      // When they try to use web3 features, they'll be prompted to configure
      await setWeb2Mode(true)

      // Clear web3-related data from localStorage to ensure clean state
      try {
        await setItem('recentApps', JSON.stringify([])) // Clear recent web3 apps
      } catch (error) {
        console.warn('Failed to clear recent apps from localStorage:', error)
      }

      router.dismissAll()
      router.push('/')
      logWithTimestamp(F, 'Logout completed, navigating to home')
    })
  }, [deleteSnap, setItem, deleteMnemonic, setWeb2Mode])

  const resolveAppDataFromDomain = async ({ appDomains }: { appDomains: string[] }) => {
    const dataPromises = appDomains.map(async (domain, index) => {
      let appIconImageUrl
      let appName = domain
      try {
        const url = domain.startsWith('http') ? domain : `https://${domain}/favicon.ico`
        logWithTimestamp(F, `Checking image URL for ${domain}`)
        if (await isImageUrl(url)) {
          appIconImageUrl = url
        }
        // Try to parse the app manifest to find the app info
        logWithTimestamp(F, `Fetching manifest for ${domain}`)
        const manifest = await parseAppManifest({ domain })
        if (manifest && typeof manifest.name === 'string') {
          appName = manifest.name
        }
      } catch (e) {
        console.error(e)
        logWithTimestamp(F, `Error resolving app data for ${domain}`, (e as Error).message)
      }

      return { appName, appIconImageUrl, domain }
    })
    return Promise.all(dataPromises)
  }

  useEffect(() => {
    if (typeof managers?.permissionsManager === 'object') {
      logWithTimestamp(F, 'Checking permissions manager for stored apps')
      ;(async () => {
        logWithTimestamp(F, 'Fetching stored apps from AsyncStorage')
        const storedApps = await getItem('recentApps')
        console.log('Retrieved from storage', storedApps)
        logWithTimestamp(F, `Retrieved from storage: ${storedApps}`)
        if (storedApps) {
          setRecentApps(JSON.parse(storedApps))
          logWithTimestamp(F, 'Recent apps set from storage')
        }
        // Parse out the app data from the domains
        logWithTimestamp(F, 'Fetching app domains')
        const appDomains: string[] = [] //await getApps({ permissionsManager: managers.permissionsManager!, adminOriginator })
        logWithTimestamp(F, 'App domains fetched, resolving data')
        const parsedAppData = await resolveAppDataFromDomain({ appDomains })
        logWithTimestamp(F, 'App data resolved, sorting')
        parsedAppData.sort((a, b) => a.appName.localeCompare(b.appName))
        setRecentApps(parsedAppData)

        // store for next app load
        logWithTimestamp(F, 'Storing apps in AsyncStorage')
        await setItem('recentApps', JSON.stringify(parsedAppData))
        logWithTimestamp(F, 'Stored apps processing complete')
      })()
    }
    logWithTimestamp(F, 'Permissions manager check complete')
  }, [adminOriginator, managers?.permissionsManager, getItem, setItem])

  const contextValue = useMemo<WalletContextValue>(
    () => ({
      managers,
      updateManagers: setManagers,
      settings,
      updateSettings,
      logout,
      adminOriginator,
      snapshotLoaded,
      basketRequests,
      certificateRequests,
      protocolRequests,
      spendingRequests,
      advanceBasketQueue,
      advanceCertificateQueue,
      advanceProtocolQueue,
      advanceSpendingQueue,
      recentApps,
      finalizeConfig,
      setConfigStatus,
      configStatus,
      selectedWabUrl,
      selectedStorageUrl,
      selectedMethod,
      selectedNetwork,
      setWalletBuilt,
      buildWalletFromMnemonic,
      switchNetwork,
      storage,
      txStatusVersion
    }),
    [
      managers,
      settings,
      updateSettings,
      logout,
      adminOriginator,
      snapshotLoaded,
      basketRequests,
      certificateRequests,
      protocolRequests,
      spendingRequests,
      advanceBasketQueue,
      advanceCertificateQueue,
      advanceProtocolQueue,
      advanceSpendingQueue,
      recentApps,
      finalizeConfig,
      setConfigStatus,
      configStatus,
      selectedWabUrl,
      selectedStorageUrl,
      selectedMethod,
      selectedNetwork,
      setWalletBuilt,
      buildWalletFromMnemonic,
      switchNetwork,
      storage,
      txStatusVersion
    ]
  )

  return <WalletContext.Provider value={contextValue}>{children}</WalletContext.Provider>
}

export const useWallet = () => useContext(WalletContext)
