const F = 'context/WalletContext'

import React, { useState, useEffect, createContext, useMemo, useCallback, useContext, useRef } from 'react'
import {
  Wallet,
  WalletPermissionsManager,
  PrivilegedKeyManager,
  WalletStorageManager,
  WalletSigner,
  PermissionRequest,
  SimpleWalletManager,
  Monitor
} from '@bsv/wallet-toolbox-mobile'
import { KeyDeriver, PrivateKey, MerklePath } from '@bsv/sdk'
import {
  DEFAULT_SETTINGS as LIB_DEFAULT_SETTINGS,
  WalletSettings,
  WalletSettingsManager
} from '@bsv/wallet-toolbox-mobile/out/src/WalletSettingsManager'

/** App-level defaults: library defaults + additional certifiers */
const DEFAULT_SETTINGS: WalletSettings = {
  ...LIB_DEFAULT_SETTINGS,
  trustSettings: {
    ...LIB_DEFAULT_SETTINGS.trustSettings,
    trustedCertifiers: [
      ...LIB_DEFAULT_SETTINGS.trustSettings.trustedCertifiers,
      {
        name: 'Who I Am',
        description: 'Certifies email, phone, and X account ownership',
        iconUrl: 'https://whoiam.bsvblockchain.tech/whoiam.png',
        identityKey: '02e7eeb3986273db6843b790a1595ed0ff1b2ae8f43ae2e7f1a0c9db4dd3fb9441',
        trust: 5
      }
    ]
  }
}
import { toast } from 'react-toastify'
import 'react-toastify/dist/ReactToastify.css'
import type { AppChain } from './config'
import { DEFAULT_STORAGE_URL, DEFAULT_CHAIN, ADMIN_ORIGINATOR } from './config'
import { UserContext } from './UserContext'
import { useLocalStorage } from '@/context/LocalStorageProvider'
import { usePermissionQueue } from '@/hooks/usePermissionQueue'
import { createServices } from '@/services/walletServiceConfig'
import { createArcadeBroadcastService } from '@/services/arcadeBroadcastProvider'
import { getExchangeRate } from '@/services/exchangeRate'
import { router } from 'expo-router'
import { logWithTimestamp } from '@/utils/logging'
import { recoverMnemonicWallet } from '@/utils/mnemonicWallet'
import { StorageProvider } from '@bsv/wallet-toolbox-mobile'
import { StorageExpoSQLite } from '@/storage'
import * as SQLite from 'expo-sqlite'
import { getRegisteredDbs, registerDb, selectLatestDb } from '@/utils/walletDbRegistry'
import { createBtmsModule } from '@bsv/btms-permission-module'
import { AppState, AppStateStatus } from 'react-native'
import RNEventSource from 'react-native-sse'
import NetInfo from '@react-native-community/netinfo'
import { processPendingPayments } from '@/utils/ble/pendingPayments'

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
  btmsRequests: BtmsRequest[]
  advanceBasketQueue: () => void
  advanceCertificateQueue: () => void
  advanceProtocolQueue: () => void
  advanceSpendingQueue: () => void
  advanceBtmsQueue: (approved: boolean) => void
  finalizeConfig: (wabConfig: WABConfig) => boolean
  setConfigStatus: (status: ConfigStatus) => void
  configStatus: ConfigStatus
  selectedStorageUrl: string
  selectedMethod: string
  selectedNetwork: AppChain
  setWalletBuilt: (current: boolean) => void
  buildWalletFromMnemonic: (mnemonic?: string) => Promise<void>
  buildWalletFromRecoveredKey: (wif: string) => Promise<void>
  switchNetwork: (network: AppChain) => Promise<void>
  /** Tear down the current wallet and re-trigger auto-build (e.g. after DB import). */
  rebuildWallet: () => Promise<void>
  storage: StorageExpoSQLite | null
  /** Fetch BUMP from WoC and store merkle proof, advancing tx status to completed */
  refreshProof: (txid: string) => Promise<void>
  /** Incremented when a transaction status changes via SSE, triggers UI refresh */
  txStatusVersion: number
  /** True while the wallet is being built (biometric auth pending, async build in progress) */
  walletBuilding: boolean
  /**
   * Notification from background BLE payment processing.
   * Set when pending payments are internalized in the background (e.g. on
   * wallet build or when connectivity is restored). Cleared by the UI after
   * display. null = no pending notification.
   */
  bleNotification: { message: string; type: 'success' | 'error' | 'info' } | null
  clearBleNotification: () => void
}

export const WalletContext = createContext<WalletContextValue>({
  managers: {},
  settings: DEFAULT_SETTINGS,
  updateSettings: async () => {},
  logout: () => {},
  adminOriginator: ADMIN_ORIGINATOR,
  snapshotLoaded: false,
  basketRequests: [],
  certificateRequests: [],
  protocolRequests: [],
  spendingRequests: [],
  btmsRequests: [],
  advanceBasketQueue: () => {},
  advanceCertificateQueue: () => {},
  advanceProtocolQueue: () => {},
  advanceSpendingQueue: () => {},
  advanceBtmsQueue: () => {},
  finalizeConfig: () => false,
  setConfigStatus: () => {},
  configStatus: 'initial',
  selectedStorageUrl: '',
  selectedMethod: '',
  selectedNetwork: 'main',
  setWalletBuilt: (current: boolean) => {},
  buildWalletFromMnemonic: async () => {},
  buildWalletFromRecoveredKey: async () => {},
  switchNetwork: async () => {},
  rebuildWallet: async () => {},
  storage: null,
  refreshProof: async () => {},
  txStatusVersion: 0,
  walletBuilding: false,
  bleNotification: null,
  clearBleNotification: () => {}
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

type BtmsRequest = {
  /** The originator (dApp domain) requesting BTMS token access */
  originator: string
  /** The raw message from BasicTokenModule (JSON-encoded promptData) */
  message: string
  /** Resolve the pending Promise from BasicTokenModule — true = approved */
  resolve: (approved: boolean) => void
}

export interface WABConfig {
  wabUrl: string
  wabInfo?: any // Optional for noWAB (self-custodial) mode
  method: string
  network: AppChain
  storageUrl: string
}

/**
 * Open a legacy (no-timestamp) wallet DB and check whether it already contains
 * a settings row.  If so, it's a real database from a previous version.  If
 * not, the file was freshly created by `openDatabaseAsync` and we clean it up.
 */
async function probeForLegacyDb(legacyName: string): Promise<boolean> {
  let db: SQLite.SQLiteDatabase | undefined
  try {
    db = await SQLite.openDatabaseAsync(legacyName)
    const row = await db.getFirstAsync('SELECT * FROM settings LIMIT 1')
    if (row) {
      // Real legacy database — close and report success
      await db.closeAsync()
      return true
    }
    // Empty / newly-created database — clean up
    await db.closeAsync()
    db = undefined
    await SQLite.deleteDatabaseAsync(legacyName)
    return false
  } catch {
    // Table doesn't exist → file was just created or is invalid
    try {
      await db?.closeAsync()
    } catch {}
    try {
      await SQLite.deleteDatabaseAsync(legacyName)
    } catch {}
    return false
  }
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
  const monitorRef = useRef<Monitor | null>(null)
  const adminOriginator = ADMIN_ORIGINATOR
  const [walletBuilt, setWalletBuilt] = useState<boolean>(false)
  const walletBuildingRef = useRef<boolean>(false)
  const [walletBuilding, setWalletBuilding] = useState<boolean>(false)
  const [bleNotification, setBleNotification] = useState<{
    message: string
    type: 'success' | 'error' | 'info'
  } | null>(null)
  const clearBleNotification = useCallback(() => setBleNotification(null), [])

  const {
    getSnap,
    deleteSnap,
    getItem,
    setItem,
    setMnemonic,
    getMnemonic,
    deleteMnemonic,
    setRecoveredKey,
    getRecoveredKey,
    deleteRecoveredKey
  } = useLocalStorage()

  const {
    isFocused,
    onFocusRequested,
    onFocusRelinquished,
    setBasketAccessModalOpen,
    setCertificateAccessModalOpen,
    setProtocolAccessModalOpen,
    setSpendingAuthorizationModalOpen
  } = useContext(UserContext)

  const focusOpts = { isFocused, onFocusRequested, onFocusRelinquished }

  const basketQueue = usePermissionQueue<BasketAccessRequest>({
    ...focusOpts,
    openModal: setBasketAccessModalOpen
  })
  const certificateQueue = usePermissionQueue<CertificateAccessRequest>({
    ...focusOpts,
    openModal: setCertificateAccessModalOpen
  })
  const protocolQueue = usePermissionQueue<ProtocolAccessRequest>({
    ...focusOpts,
    openModal: setProtocolAccessModalOpen
  })
  const spendingQueue = usePermissionQueue<SpendingRequest>({
    ...focusOpts,
    openModal: setSpendingAuthorizationModalOpen
  })
  const btmsQueue = usePermissionQueue<BtmsRequest>(focusOpts)

  const advanceBtmsQueue = useCallback(
    (approved: boolean) => {
      btmsQueue.advance(head => head.resolve(approved))
    },
    [btmsQueue.advance]
  )

  const btmsPromptHandler = useCallback(
    (originator: string, message: string): Promise<boolean> => {
      return new Promise<boolean>(resolve => {
        btmsQueue.enqueue({ originator, message, resolve })
      })
    },
    [btmsQueue.enqueue]
  )

  const updateSettings = useCallback(
    async (newSettings: WalletSettings) => {
      if (!managers.settingsManager) {
        throw new Error('The user must be logged in to update settings!')
      }
      await managers.settingsManager.set(newSettings)
      setSettings(newSettings)
    },
    [managers.settingsManager]
  )

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
      if (incomingRequest?.requestID) {
        basketQueue.enqueue({
          requestID: incomingRequest.requestID,
          basket: incomingRequest.basket,
          originator: incomingRequest.originator,
          reason: incomingRequest.reason,
          renewal: incomingRequest.renewal
        })
      }
    },
    [basketQueue.enqueue]
  )

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
      if (incomingRequest?.requestID) {
        const certificate = incomingRequest.certificate as any
        certificateQueue.enqueue({
          requestID: incomingRequest.requestID,
          originator: incomingRequest.originator,
          verifierPublicKey: certificate?.verifier || '',
          certificateType: certificate?.certType || '',
          fieldsArray: certificate?.fields || [],
          description: incomingRequest.reason,
          renewal: incomingRequest.renewal
        } as any)
      }
    },
    [certificateQueue.enqueue]
  )

  const protocolPermissionCallback = useCallback(
    (args: PermissionRequest & { requestID: string }): Promise<void> => {
      const { requestID, counterparty, originator, reason, renewal, protocolID } = args
      if (!requestID || !protocolID) return Promise.resolve()

      const [protocolSecurityLevel, protocolNameString] = protocolID

      let permissionType: PermissionType = 'protocol'
      if (protocolNameString === 'identity resolution') permissionType = 'identity'
      else if (renewal) permissionType = 'renewal'
      else if (protocolNameString.includes('basket')) permissionType = 'basket'

      protocolQueue.enqueue({
        requestID,
        protocolSecurityLevel,
        protocolID: protocolNameString,
        counterparty,
        originator,
        description: reason,
        renewal,
        type: permissionType
      })
      return Promise.resolve()
    },
    [protocolQueue.enqueue]
  )

  const spendingAuthorizationCallback = useCallback(
    async (args: PermissionRequest & { requestID: string }): Promise<void> => {
      const { requestID, originator, reason, renewal, spending } = args
      if (!requestID || !spending) return

      spendingQueue.enqueue({
        requestID,
        originator,
        description: reason,
        transactionAmount: 0,
        totalPastSpending: 0,
        amountPreviouslyAuthorized: 0,
        authorizationAmount: spending.satoshis,
        renewal,
        lineItems: spending.lineItems || []
      })
    },
    [spendingQueue.enqueue]
  )

  // ---- WAB + network + storage configuration ----
  const [selectedMethod, setSelectedMethod] = useState<string>('')
  const [selectedNetwork, setSelectedNetwork] = useState<AppChain>(DEFAULT_CHAIN)
  const [selectedStorageUrl, setSelectedStorageUrl] = useState<string>(DEFAULT_STORAGE_URL)

  // Flag that indicates configuration is complete. For returning users,
  // if a snapshot exists we auto-mark configComplete.
  const [configStatus, setConfigStatus] = useState<ConfigStatus>('initial')
  // Used to trigger a re-render after snapshot load completes.
  const [snapshotLoaded, setSnapshotLoaded] = useState<boolean>(false)

  const finalizeConfig = useCallback((wabConfig: WABConfig): boolean => {
    const { method, network, storageUrl } = wabConfig
    if (!network) {
      console.error('Network selection is required')
      return false
    }
    setSelectedMethod(method || 'mnemonic')
    setSelectedNetwork(network)
    setSelectedStorageUrl(storageUrl || 'local')
    setConfigStatus('configured')
    return true
  }, [])

  // Auto-configure on first launch: if no stored config, set defaults
  useEffect(() => {
    ;(async () => {
      if (configStatus !== 'initial') return
      const storedConfig = await getItem('finalConfig')
      if (storedConfig) {
        try {
          const config = JSON.parse(storedConfig)
          finalizeConfig(config)
        } catch {
          finalizeConfig({ wabUrl: 'noWAB', method: 'mnemonic', network: DEFAULT_CHAIN, storageUrl: 'local' })
          await setItem(
            'finalConfig',
            JSON.stringify({ wabUrl: 'noWAB', method: 'mnemonic', network: DEFAULT_CHAIN, storageUrl: 'local' })
          )
        }
      } else {
        // First launch: auto-configure with defaults
        finalizeConfig({ wabUrl: 'noWAB', method: 'mnemonic', network: DEFAULT_CHAIN, storageUrl: 'local' })
        await setItem(
          'finalConfig',
          JSON.stringify({ wabUrl: 'noWAB', method: 'mnemonic', network: DEFAULT_CHAIN, storageUrl: 'local' })
        )
      }
    })()
  }, [configStatus]) // Re-run whenever configStatus resets to 'initial' (e.g. after logout)

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
        const callbackToken = keyDeriver.identityKey.substring(0, 32)

        const { services, serviceOptions } = createServices(selectedNetwork, callbackToken, bsvExchangeRate)

        // Replace default broadcast providers with Arcade
        services.postBeefServices.remove('GorillaPoolArcBeef')
        services.postBeefServices.remove('TaalArcBeef')
        services.postBeefServices.add(createArcadeBroadcastService(serviceOptions.arcUrl!, callbackToken))

        const wallet = new Wallet(signer, services, undefined, privilegedKeyManager)
        // Set default settings including "Who I Am" certifier before first get().
        // config is private in the type declarations but settable at runtime.
        ;(wallet.settingsManager as any).config = { defaultSettings: DEFAULT_SETTINGS }
        newManagers.settingsManager = wallet.settingsManager

        // Use user-selected storage provider
        // Check if user selected local storage
        let phoneStorage: StorageExpoSQLite | undefined
        if (selectedStorageUrl === 'local') {
          console.log('[WalletContext] Using local SQLite storage')

          const identityKey = keyDeriver.identityKey
          const keySuffix = identityKey.slice(-8)
          const chainStr = chain === 'main' ? 'main' : chain === 'test' ? 'test' : 'teratest'

          // ── Select the best database file from the registry ──
          let knownDbs = await getRegisteredDbs(keySuffix, chainStr)

          if (knownDbs.length === 0) {
            // First launch after update or fresh user.
            // Probe for a legacy (no-timestamp) database file.
            const legacyName = `wallet-${keySuffix}-${chainStr}net.db`
            const hasLegacy = await probeForLegacyDb(legacyName)
            if (hasLegacy) {
              await registerDb(keySuffix, chainStr, legacyName)
              knownDbs = [legacyName]
              console.log(`[WalletContext] Registered legacy DB: ${legacyName}`)
            } else {
              // Fresh user — create a timestamped database
              const ts = Math.floor(Date.now() / 1000)
              const newName = `wallet-${keySuffix}-${chainStr}net-${ts}.db`
              await registerDb(keySuffix, chainStr, newName)
              knownDbs = [newName]
              console.log(`[WalletContext] Created new timestamped DB: ${newName}`)
            }
          }

          const selectedDb = selectLatestDb(knownDbs)
          console.log(`[WalletContext] Selected DB: ${selectedDb} (from ${knownDbs.length} registered)`)

          phoneStorage = new StorageExpoSQLite({
            ...StorageProvider.createStorageBaseOptions(chain),
            feeModel: { model: 'sat/kb', value: 100 },
            identityKey,
            databaseName: selectedDb
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

        // Create BTMS permission module, wiring in the prompt handler so that
        // "p btms" operations surface a UI modal rather than silently denying.
        const btmsModule = createBtmsModule({ wallet, promptHandler: btmsPromptHandler })

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
          monitorRef.current = monitor
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
      certificateAccessCallback,
      btmsPromptHandler
    ]
  )

  // Watch for wallet authentication state
  useEffect(() => {
    ;(async () => {
      const snap = await getSnap()
      if (managers?.walletManager?.authenticated && snap) {
        setSnapshotLoaded(true)
      } else if (!snap && snapshotLoaded) {
        setSnapshotLoaded(false)
      }
    })()
  }, [managers?.walletManager?.authenticated, snapshotLoaded, getSnap])

  // TODO: Re-add WAB (WalletAuthenticationManager) support in future version

  const buildWalletFromMnemonic = useCallback(
    async (providedMnemonic?: string) => {
      // Skip if wallet already built or a build is already in progress
      if (walletBuilt || walletBuildingRef.current) {
        return
      }

      // Only build if wallet is properly configured
      if (configStatus !== 'configured') {
        return
      }

      walletBuildingRef.current = true
      setWalletBuilding(true)

      try {
        // Use provided mnemonic directly (e.g. from mnemonic screen) or read from secure storage
        const mnemonic = providedMnemonic || (await getMnemonic())
        if (!mnemonic) {
          walletBuildingRef.current = false
          setWalletBuilding(false)
          return
        }

        const { rootKey, primaryKey } = recoverMnemonicWallet(mnemonic)

        // For noWAB, we don't need a PrivilegedKeyManager from WAB
        // We can create a simple one that always returns the primary key
        const privilegedKeyManager = new PrivilegedKeyManager(async () => rootKey)

        // Create SimpleWalletManager and provide keys for authentication
        const snap = await getSnap()

        const swm = new SimpleWalletManager(ADMIN_ORIGINATOR, buildWallet, snap || undefined)

        // Provide the primary key and privileged key manager to authenticate the wallet
        await swm.providePrimaryKey(primaryKey)

        await swm.providePrivilegedKeyManager(privilegedKeyManager)

        setManagers(m => ({
          ...m,
          walletManager: swm
        }))
        setWalletBuilt(true)
        walletBuildingRef.current = false
        setWalletBuilding(false)

        await setMnemonic(mnemonic)
        logWithTimestamp(F, 'Mnemonic wallet build completed')
      } catch (error: any) {
        walletBuildingRef.current = false
        setWalletBuilding(false)
        console.error('[WalletContext] Error building mnemonic wallet:', error)
      }
    },
    [walletBuilt, configStatus, getMnemonic, getSnap, setMnemonic, buildWallet]
  )

  // Build wallet from a recovered PrivateKey (WIF) obtained via backup share scanning
  const buildWalletFromRecoveredKey = useCallback(
    async (wif: string) => {
      if (walletBuilt || walletBuildingRef.current) return
      if (configStatus !== 'configured') return

      walletBuildingRef.current = true
      setWalletBuilding(true)
      logWithTimestamp(F, 'Building wallet from recovered key')

      try {
        const recoveredKey = PrivateKey.fromWif(wif)
        const primaryKey = recoveredKey.toArray()

        // Use the recovered primary key as both the signing key and the privileged key
        const privilegedKeyManager = new PrivilegedKeyManager(async () => recoveredKey)

        const snap = await getSnap()
        const swm = new SimpleWalletManager(ADMIN_ORIGINATOR, buildWallet, snap || undefined)

        await swm.providePrimaryKey(primaryKey)

        await swm.providePrivilegedKeyManager(privilegedKeyManager)

        setManagers(m => ({
          ...m,
          walletManager: swm
        }))
        setWalletBuilt(true)
        walletBuildingRef.current = false
        setWalletBuilding(false)

        await setRecoveredKey(wif)
        logWithTimestamp(F, 'Recovered key wallet build completed')
      } catch (error: any) {
        walletBuildingRef.current = false
        setWalletBuilding(false)
        console.error('[WalletContext] Error building wallet from recovered key:', error)
      }
    },
    [walletBuilt, configStatus, getSnap, setRecoveredKey, buildWallet]
  )

  // Tear down the current wallet and re-trigger auto-build.
  // Used after DB import and internally by switchNetwork.
  const rebuildWallet = useCallback(async () => {
    logWithTimestamp(F, 'Rebuilding wallet')

    // Stop any running monitor
    try {
      const monitor = monitorRef.current
      if (monitor) {
        await monitor.stopTasks()
        monitorRef.current = null
      }
    } catch (e) {
      console.warn('[WalletContext] Failed to stop monitor during rebuild:', e)
    }

    // Close the current storage connection so the new build can open
    // whichever DB file the registry selects.
    if (storage?.db) {
      try {
        await storage.destroy()
      } catch {}
    }

    // Tear down current wallet state (but keep mnemonic / config)
    setManagers({})
    setWalletBuilt(false)
    walletBuildingRef.current = false
    setWalletBuilding(false)
    setSnapshotLoaded(false)

    // Re-finalize with current config — triggers auto-build effect
    const config = { wabUrl: 'noWAB', method: 'mnemonic', network: selectedNetwork, storageUrl: 'local' }
    finalizeConfig(config)
    logWithTimestamp(F, 'Wallet rebuild triggered')
  }, [selectedNetwork, storage, finalizeConfig])

  // Switch network: tear down wallet, update config, and rebuild on new chain
  const switchNetwork = useCallback(
    async (network: AppChain) => {
      if (network === selectedNetwork) return
      logWithTimestamp(F, `Switching network from ${selectedNetwork} to ${network}`)

      // Stop any running monitor
      try {
        const monitor = monitorRef.current
        if (monitor) {
          await monitor.stopTasks()
          monitorRef.current = null
        }
      } catch (e) {
        console.warn('[WalletContext] Failed to stop monitor during network switch:', e)
      }

      // Close the current storage connection
      if (storage?.db) {
        try {
          await storage.destroy()
        } catch {}
      }

      // Tear down current wallet state (but keep mnemonic)
      setManagers({})
      setWalletBuilt(false)
      walletBuildingRef.current = false
      setWalletBuilding(false)
      setSnapshotLoaded(false)

      // Persist new config
      const newConfig = { wabUrl: 'noWAB', method: 'mnemonic', network, storageUrl: 'local' }
      await setItem('finalConfig', JSON.stringify(newConfig))

      // Re-finalize with new network — this triggers the auto-build effect
      finalizeConfig(newConfig)
      logWithTimestamp(F, `Network switched to ${network}`)
    },
    [selectedNetwork, setItem, storage, finalizeConfig]
  )

  // Auto-build wallet for returning users (mnemonic first, then recovered key).
  // Sets walletBuilding=true eagerly so other parts of the app (BrowserModeContext,
  // index.tsx navigation) know not to react as if no wallet exists.
  useEffect(() => {
    if (configStatus !== 'configured' || walletBuilt) return
    // Signal that a build attempt is starting. buildWalletFromMnemonic /
    // buildWalletFromRecoveredKey will clear this flag on completion or error.
    setWalletBuilding(true)
    ;(async () => {
      // Try mnemonic-based build first (calls getMnemonic internally)
      await buildWalletFromMnemonic()
      // If still not built (no mnemonic), try recovered key
      // We check walletBuilt via a ref-like approach: buildWalletFromMnemonic
      // sets walletBuilt=true synchronously in its body, but the state update
      // won't be visible in this closure. Instead, we read from SecureStore.
      if (!walletBuildingRef.current) {
        // buildWalletFromMnemonic finished without building (no mnemonic found).
        // Try recovered key as a fallback.
        const recoveredWif = await getRecoveredKey()
        if (recoveredWif) {
          await buildWalletFromRecoveredKey(recoveredWif)
        } else {
          // No mnemonic and no recovered key — genuinely no wallet to build
          setWalletBuilding(false)
        }
      }
    })()
  }, [configStatus, walletBuilt, buildWalletFromMnemonic, buildWalletFromRecoveredKey, getRecoveredKey])

  // When Settings manager becomes available, populate the user's settings
  useEffect(() => {
    const loadSettings = async () => {
      if (managers.settingsManager) {
        try {
          const userSettings = await managers.settingsManager.get()
          setSettings(userSettings)
        } catch {
          // Unable to load settings, defaults are already loaded.
        }
      }
    }

    loadSettings()
  }, [managers.settingsManager])

  // ── Background BLE pending payment processing ──
  // After wallet build completes, attempt to internalize any BLE payments that
  // were received while offline. A NetInfo listener then re-triggers whenever
  // the device comes back online so the queue drains automatically.
  useEffect(() => {
    if (!walletBuilt || !managers.permissionsManager || !storage) return

    const tryProcess = async () => {
      try {
        const netState = await NetInfo.fetch()
        if (!netState.isConnected || netState.isInternetReachable === false) return
        const results = await processPendingPayments(managers.permissionsManager as any, storage, adminOriginator)
        const successes = results.filter(r => r.success)
        if (successes.length > 0) {
          const msg =
            successes.length === 1
              ? 'A local payment was added to your wallet'
              : `${successes.length} local payments were added to your wallet`
          setBleNotification({ message: msg, type: 'success' })
        }
      } catch {
        // Best-effort — failures are recorded per-entry in the queue
      }
    }

    // Run immediately after wallet build
    tryProcess()

    // Also run when connectivity is restored
    const unsubscribe = NetInfo.addEventListener(state => {
      if (state.isConnected && state.isInternetReachable !== false) {
        tryProcess()
      }
    })

    return () => unsubscribe()
  }, [walletBuilt, managers.permissionsManager, storage, adminOriginator])

  // Fetch Arcade status events when app returns to foreground
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState: AppStateStatus) => {
      const wasBackground = appStateRef.current.match(/inactive|background/)
      const isNowForeground = nextAppState === 'active'

      if (wasBackground && isNowForeground) {
        const monitor = monitorRef.current
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

  // Cleanup monitor on unmount
  useEffect(() => {
    return () => {
      try { monitorRef.current?.stopTasks() } catch {}
      monitorRef.current = null
    }
  }, [])

  const logout = useCallback(() => {
    logWithTimestamp(F, 'Logout')
    deleteSnap().then(async () => {
      setManagers({})
      setConfigStatus('initial')
      setSnapshotLoaded(false)
      setWalletBuilt(false)
      walletBuildingRef.current = false
      setWalletBuilding(false)
      deleteMnemonic()
      deleteRecoveredKey()

      router.dismissAll()
      router.push('/')
    })
  }, [deleteSnap, deleteMnemonic, deleteRecoveredKey])

  const refreshProof = useCallback(async (txid: string): Promise<void> => {
    if (!storage) throw new Error('Storage not available')

    const wocBase = selectedNetwork === 'teratest'
      ? 'https://woc-ttn.bsvb.tech'
      : 'https://api.whatsonchain.com'
    const chain = selectedNetwork === 'main' ? 'main' : 'test'

    const res = await fetch(`${wocBase}/v1/bsv/${chain}/tx/${txid}/proof/bump`)
    if (!res.ok) throw new Error(`BUMP not available (HTTP ${res.status}) — transaction may not be mined yet`)

    const bumpHex = (await res.text()).trim()
    const merklePath = MerklePath.fromHex(bumpHex)
    const merkleRoot = merklePath.computeRoot(txid)
    const leaf = merklePath.path[0].find(l => l.txid === true && l.hash === txid)
    if (!leaf) throw new Error('txid not found in BUMP path')

    const reqs = await storage.findProvenTxReqs({ partial: { txid } })
    if (!reqs.length) throw new Error('No pending record found for this transaction')

    const req = reqs[0]
    await storage.updateProvenTxReqWithNewProvenTx({
      provenTxReqId: req.provenTxReqId,
      status: req.status,
      txid,
      attempts: req.attempts,
      history: req.history,
      index: leaf.offset,
      height: merklePath.blockHeight,
      blockHash: '',
      merklePath: merklePath.toBinary(),
      merkleRoot,
    })

    setTxStatusVersion(v => v + 1)
  }, [storage, selectedNetwork])

  const contextValue = useMemo<WalletContextValue>(
    () => ({
      managers,
      settings,
      updateSettings,
      logout,
      adminOriginator,
      snapshotLoaded,
      basketRequests: basketQueue.requests,
      certificateRequests: certificateQueue.requests,
      protocolRequests: protocolQueue.requests,
      spendingRequests: spendingQueue.requests,
      btmsRequests: btmsQueue.requests,
      advanceBasketQueue: basketQueue.advance,
      advanceCertificateQueue: certificateQueue.advance,
      advanceProtocolQueue: protocolQueue.advance,
      advanceSpendingQueue: spendingQueue.advance,
      advanceBtmsQueue,
      finalizeConfig,
      setConfigStatus,
      configStatus,
      selectedStorageUrl,
      selectedMethod,
      selectedNetwork,
      setWalletBuilt,
      buildWalletFromMnemonic,
      buildWalletFromRecoveredKey,
      switchNetwork,
      rebuildWallet,
      storage,
      refreshProof,
      txStatusVersion,
      walletBuilding,
      bleNotification,
      clearBleNotification
    }),
    [
      managers,
      settings,
      updateSettings,
      logout,
      adminOriginator,
      snapshotLoaded,
      basketQueue.requests,
      certificateQueue.requests,
      protocolQueue.requests,
      spendingQueue.requests,
      btmsQueue.requests,
      basketQueue.advance,
      certificateQueue.advance,
      protocolQueue.advance,
      spendingQueue.advance,
      advanceBtmsQueue,
      finalizeConfig,
      setConfigStatus,
      configStatus,
      selectedStorageUrl,
      selectedMethod,
      selectedNetwork,
      setWalletBuilt,
      buildWalletFromMnemonic,
      buildWalletFromRecoveredKey,
      switchNetwork,
      rebuildWallet,
      storage,
      refreshProof,
      txStatusVersion,
      walletBuilding,
      bleNotification,
      clearBleNotification
    ]
  )

  return <WalletContext.Provider value={contextValue}>{children}</WalletContext.Provider>
}

export const useWallet = () => useContext(WalletContext)
