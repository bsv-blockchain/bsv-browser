import React from 'react'
import { Platform } from 'react-native'
import { act, cleanup, fireEvent, render } from '@testing-library/react-native'
import MnemonicScreen from '../app/auth/mnemonic'
import { PrivateKey } from '@bsv/sdk'
import * as Clipboard from 'expo-clipboard'
import { Directory } from 'expo-file-system'

let mockFlow: 'backup' | 'import' | undefined
let mockSecretsReady = true
let mockExistingIdentity = false
let mockWalletBuilt = false
const mockReplace = jest.fn()
const mockBack = jest.fn()
const mockHasStoredIdentity = jest.fn()
const mockCreateMnemonic = jest.fn()
const mockGetMnemonic = jest.fn()
const mockUnlock = jest.fn()
const mockGetRecoveredKey = jest.fn()
const mockSetRecoveredKey = jest.fn()
const mockBuildRecoveredKey = jest.fn()
const mockRecoverMnemonic = jest.fn()
const mockWriteFile = jest.fn()
const mockReadFile = jest.fn()
const mockCreateFile = jest.fn()
const mockPhrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
let mockIdentityKey: string
const mockStoreMnemonic = jest.fn()
const mockGenerate = jest.fn()
const mockBuild = jest.fn()
const mockRebuild = jest.fn()
const mockMarkPending = jest.fn()
const mockAttest = jest.fn()
const mockPrint = jest.fn()
const mockToast = jest.fn()

jest.mock('expo-router', () => ({
  router: { replace: (...args: unknown[]) => mockReplace(...args), back: () => mockBack(), dismissAll: jest.fn(), push: jest.fn() },
  useLocalSearchParams: () => ({ flow: mockFlow })
}))
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key })
}))
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }))
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }))
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => {}) }))
jest.mock('expo-file-system', () => ({
  Directory: { pickDirectoryAsync: jest.fn() }
}))
jest.mock('@bsv/expo-wallet-toolbox/core/theme/ThemeContext', () => ({
  useTheme: () => ({ colors: {}, isDark: false })
}))
jest.mock('@bsv/expo-wallet-toolbox/core/context/WalletContext', () => ({
  useWallet: () => ({
    buildWalletFromMnemonic: mockBuild,
    buildWalletFromRecoveredKey: mockBuildRecoveredKey,
    rebuildWallet: mockRebuild,
    backupRestore: { phase: 'idle' },
    getBackupRestore: () => ({ phase: 'idle' }),
    walletBuilt: mockWalletBuilt,
    walletBuilding: false
  })
}))
jest.mock('@bsv/expo-wallet-toolbox/core/context/LocalStorageProvider', () => ({
  useLocalStorage: () => ({
    createMnemonic: mockCreateMnemonic,
    setMnemonic: mockStoreMnemonic,
    getMnemonic: mockGetMnemonic,
    unlock: mockUnlock,
    getRecoveredKey: mockGetRecoveredKey,
    setRecoveredKey: mockSetRecoveredKey,
    hasStoredIdentity: mockHasStoredIdentity,
    secretsReady: mockSecretsReady
  })
}))
jest.mock('@bsv/expo-wallet-toolbox/core/mnemonicWallet', () => ({
  generateMnemonicWallet: () => mockGenerate(),
  recoverMnemonicWallet: (phrase: string) => mockRecoverMnemonic(phrase),
  validateMnemonic: () => true
}))
jest.mock('@bsv/expo-wallet-toolbox/core/services/vault/backupAttestation', () => ({
  backupAttestation: { markPending: (...args: unknown[]) => mockMarkPending(...args), set: (...args: unknown[]) => mockAttest(...args) }
}))
jest.mock('@bsv/expo-wallet-toolbox/ui/printRecoveryShares', () => ({ printRecoveryShares: (...args: unknown[]) => mockPrint(...args) }))
jest.mock('@bsv/expo-wallet-toolbox/ui/components/ui/AlertCard', () => ({ showAlert: jest.fn() }))
jest.mock('@bsv/expo-wallet-toolbox/ui/components/ui/Toast', () => ({ showToast: (...args: unknown[]) => mockToast(...args) }))
jest.mock('@bsv/expo-wallet-toolbox/ui/components/ui/CustomSafeArea', () => {
  return { __esModule: true, default: jest.requireActual('react-native').View }
})
jest.mock('@bsv/expo-wallet-toolbox/ui/components/ui/PressableScale', () => {
  return { __esModule: true, default: jest.requireActual('react-native').Pressable }
})
jest.mock('@bsv/expo-wallet-toolbox/ui/components/ui/Celebration', () => {
  const { Text } = jest.requireActual('react-native')
  return { __esModule: true, default: () => <Text>celebration</Text> }
})

async function renderScreen() {
  const screen = render(<MnemonicScreen />)
  await act(async () => {})
  return screen
}

async function waitForHandwrittenBackup() {
  await act(async () => jest.advanceTimersByTime(15_000))
}

beforeEach(() => {
  jest.useFakeTimers()
  jest.clearAllMocks()
  mockFlow = undefined
  mockSecretsReady = true
  mockExistingIdentity = false
  mockWalletBuilt = false
  mockHasStoredIdentity.mockImplementation(async () => mockExistingIdentity)
  mockCreateMnemonic.mockImplementation(async () => {
    mockExistingIdentity = true
    return true
  })
  mockStoreMnemonic.mockResolvedValue(true)
  mockRecoverMnemonic.mockImplementation(jest.requireActual('@bsv/expo-wallet-toolbox/core/mnemonicWallet').recoverMnemonicWallet)
  mockIdentityKey = mockRecoverMnemonic(mockPhrase).identityKey
  mockRecoverMnemonic.mockClear()
  mockUnlock.mockResolvedValue({ status: 'unlocked' })
  mockGetMnemonic.mockResolvedValue(mockPhrase)
  mockGetRecoveredKey.mockResolvedValue(null)
  mockGenerate.mockReturnValue({ mnemonic: mockPhrase, identityKey: mockIdentityKey })
  mockBuild.mockResolvedValue(undefined)
  mockRebuild.mockResolvedValue(undefined)
  mockMarkPending.mockResolvedValue(undefined)
  mockAttest.mockResolvedValue(undefined)
  mockPrint.mockResolvedValue({ ok: true })
  mockWriteFile.mockReset()
  mockReadFile.mockImplementation(async () => mockWriteFile.mock.calls.at(-1)?.[0])
  mockCreateFile.mockReturnValue({ write: mockWriteFile, text: mockReadFile })
  jest.mocked(Directory.pickDirectoryAsync).mockResolvedValue({ createFile: mockCreateFile } as unknown as Directory)
  jest.mocked(Clipboard.setStringAsync).mockResolvedValue(true)
  jest.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  jest.useRealTimers()
  jest.restoreAllMocks()
})

it('waits for migration before reading backup material without redirecting or exposing creation', async () => {
  mockFlow = 'backup'
  mockSecretsReady = false
  const screen = await renderScreen()

  expect(screen.queryByText('create_new_wallet')).toBeNull()
  expect(screen.queryByText('import_existing_wallet')).toBeNull()
  expect(mockReplace).not.toHaveBeenCalled()
  expect(mockGetMnemonic).not.toHaveBeenCalled()
  expect(mockGetRecoveredKey).not.toHaveBeenCalled()
  expect(mockGenerate).not.toHaveBeenCalled()
  expect(mockCreateMnemonic).not.toHaveBeenCalled()
  expect(mockStoreMnemonic).not.toHaveBeenCalled()

  await act(async () => jest.advanceTimersByTime(30_000))
  mockSecretsReady = true
  await act(async () => screen.rerender(<MnemonicScreen />))
  expect(screen.queryByTestId('backup-confirmation-section')).toBeNull()
  await act(async () => jest.advanceTimersByTime(14_999))
  expect(screen.queryByTestId('backup-confirmation-section')).toBeNull()
  await act(async () => jest.advanceTimersByTime(1))
  expect(screen.getByTestId('backup-confirmation-section')).toBeTruthy()
  expect(mockAttest).not.toHaveBeenCalled()
  expect(screen.getByText(mockPhrase)).toBeTruthy()
  expect(mockGetMnemonic).toHaveBeenCalledTimes(1)
  expect(mockRecoverMnemonic).toHaveBeenCalledWith(mockPhrase)
  expect(mockGetRecoveredKey).not.toHaveBeenCalled()
})

it('displays the saved phrase only after its read completes and confirms a handwritten backup directly', async () => {
  mockFlow = 'backup'
  let finishRead!: (phrase: string) => void
  mockGetMnemonic.mockReturnValue(new Promise<string>(resolve => { finishRead = resolve }))
  const screen = await renderScreen()
  expect(screen.queryByText(mockPhrase)).toBeNull()
  expect(screen.queryByText('create_new_wallet')).toBeNull()
  expect(screen.queryByPlaceholderText('enter_recovery_words')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull()
  expect(mockAttest).not.toHaveBeenCalled()

  await act(async () => jest.advanceTimersByTime(30_000))
  await act(async () => finishRead(mockPhrase))
  expect(screen.getByText(mockPhrase)).toBeTruthy()
  expect(screen.queryByTestId('backup-confirmation-section')).toBeNull()
  await act(async () => jest.advanceTimersByTime(14_999))
  expect(screen.queryByTestId('backup-confirmation-section')).toBeNull()
  expect(screen.queryByText('Confirm that you have saved your recovery keys somewhere safe.')).toBeNull()
  expect(mockAttest).not.toHaveBeenCalled()
  await act(async () => jest.advanceTimersByTime(1))
  expect(screen.getByTestId('backup-confirmation-section')).toBeTruthy()
  expect(mockAttest).not.toHaveBeenCalled()
  expect(screen.getByText('Confirm that you have saved your recovery keys somewhere safe.')).toBeTruthy()
  expect(screen.queryByText('go_back')).toBeNull()
  expect(screen.queryByText('continue')).toBeNull()
  expect(screen.queryByText('acknowledgment_text')).toBeNull()
  await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Confirm' })))

  expect(mockAttest).toHaveBeenCalledWith(mockIdentityKey, 'phrase')
  expect(mockBack).toHaveBeenCalledTimes(1)
  expect(mockToast).toHaveBeenCalledWith('Backup confirmed', { type: 'success' })
  expect(mockPrint).not.toHaveBeenCalled()
  expect(Clipboard.setStringAsync).not.toHaveBeenCalled()
  expect(Directory.pickDirectoryAsync).not.toHaveBeenCalled()
  expect(mockReplace).not.toHaveBeenCalled()
  expect(screen.queryByText('celebration')).toBeNull()
  expect(mockGenerate).not.toHaveBeenCalled()
  expect(mockCreateMnemonic).not.toHaveBeenCalled()
  expect(mockStoreMnemonic).not.toHaveBeenCalled()
  expect(mockSetRecoveredKey).not.toHaveBeenCalled()
  expect(mockBuild).not.toHaveBeenCalled()
  expect(mockBuildRecoveredKey).not.toHaveBeenCalled()
  expect(mockMarkPending).not.toHaveBeenCalled()
})

/**
 * Shape, not content: this screen's whole job is to put key material on
 * screen, so its layout is asserted here rather than by looking at a running
 * app. Pins the parity redesign — one warning treatment (the bordered phrase
 * block), no banner, no inline biometric note, and the print button introduced
 * as its own distinct medium.
 */
it('renders the backup screen as one warning treatment with a distinct print section', async () => {
  mockFlow = 'backup'
  const screen = await renderScreen()

  expect(screen.getByText('Save these words')).toBeTruthy()
  expect(screen.getByText('Distribute shares')).toBeTruthy()
  expect(screen.getByText('Any 2 of the 3 pages can be used to recover your wallet.')).toBeTruthy()
  expect(screen.getByText('print_recovery_shares')).toBeTruthy()
  expect(screen.getByText('save')).toBeTruthy()
  expect(screen.getByText('copy')).toBeTruthy()

  // Removed upstream: the red banner duplicated the warning the phrase block
  // now carries, and the biometric note has no counterpart on this screen.
  expect(screen.queryByText(/only way/)).toBeNull()
  expect(screen.queryByText(/Write down these/)).toBeNull()
  expect(screen.queryByText(/keep them somewhere safe/)).toBeNull()
  expect(screen.queryByText(/encrypted with a key that Face ID/)).toBeNull()
})

it.each(['cancelled', 'failed', 'missing'])('keeps a %s backup read in a retry-only state', async outcome => {
  mockFlow = 'backup'
  if (outcome === 'failed') mockGetMnemonic.mockRejectedValueOnce(new Error('read failed'))
  else mockGetMnemonic.mockResolvedValueOnce(null)
  const screen = await renderScreen()

  expect(screen.getByText('Unable to access wallet keys. Unlock your wallet and try again.')).toBeTruthy()
  expect(screen.queryByText('create_new_wallet')).toBeNull()
  expect(screen.queryByPlaceholderText('enter_recovery_words')).toBeNull()
  expect(mockReplace).not.toHaveBeenCalled()
  expect(mockCreateMnemonic).not.toHaveBeenCalled()
  expect(mockAttest).not.toHaveBeenCalled()
  await act(async () => fireEvent.press(screen.getByRole('button', { name: 'go_back' })))
  expect(mockBack).toHaveBeenCalledTimes(1)
  expect(mockAttest).not.toHaveBeenCalled()

  await act(async () => fireEvent.press(screen.getByText('retry')))
  expect(mockUnlock).toHaveBeenCalledTimes(1)
  expect(screen.getByText(mockPhrase)).toBeTruthy()
  expect(mockGetMnemonic).toHaveBeenCalledTimes(2)
  expect(mockBack).toHaveBeenCalledTimes(1)
  expect(mockBuild).not.toHaveBeenCalled()
})

it('ignores a pending secret read after leaving the screen', async () => {
  mockFlow = 'backup'
  let finishRead!: (phrase: string | null) => void
  mockGetMnemonic.mockReturnValue(new Promise<string | null>(resolve => { finishRead = resolve }))
  const screen = await renderScreen()
  screen.unmount()
  await act(async () => finishRead(null))

  expect(mockGetRecoveredKey).not.toHaveBeenCalled()
  expect(mockRecoverMnemonic).not.toHaveBeenCalled()
  expect(mockAttest).not.toHaveBeenCalled()
  expect(mockGenerate).not.toHaveBeenCalled()
})

it('keeps unlock failures on the backup retry screen', async () => {
  mockFlow = 'backup'
  mockGetMnemonic.mockResolvedValueOnce(null)
  mockUnlock.mockRejectedValueOnce(new Error('unlock failed'))
  const screen = await renderScreen()
  await act(async () => fireEvent.press(screen.getByText('retry')))

  expect(screen.getByText('Unable to access wallet keys. Unlock your wallet and try again.')).toBeTruthy()
  expect(mockGetMnemonic).toHaveBeenCalledTimes(1)
  expect(screen.queryByText('create_new_wallet')).toBeNull()
  expect(mockCreateMnemonic).not.toHaveBeenCalled()
  expect(mockReplace).not.toHaveBeenCalled()

  await act(async () => fireEvent.press(screen.getByText('retry')))
  expect(screen.getByText(mockPhrase)).toBeTruthy()
})

it('does not leave backup when saving its acknowledgment fails', async () => {
  mockFlow = 'backup'
  mockAttest.mockRejectedValueOnce(new Error('attestation write failed'))
  const screen = await renderScreen()
  await waitForHandwrittenBackup()
  await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Confirm' })))

  expect(mockToast).toHaveBeenCalledWith('Unable to save backup confirmation. Please try again.', { type: 'error' })
  expect(mockBack).not.toHaveBeenCalled()
  expect(screen.getByText(mockPhrase)).toBeTruthy()
  expect(screen.queryByText('celebration')).toBeNull()
  expect(mockBuild).not.toHaveBeenCalled()

  await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Confirm' })))
  expect(mockBack).toHaveBeenCalledTimes(1)
  expect(mockAttest).toHaveBeenCalledTimes(2)
})

it('persists one confirmation before returning even when tapped twice in the same render', async () => {
  mockFlow = 'backup'
  let finishConfirmation!: () => void
  mockAttest.mockReturnValueOnce(new Promise<void>(resolve => { finishConfirmation = resolve }))
  const screen = await renderScreen()
  await waitForHandwrittenBackup()
  const confirm = screen.getByRole('button', { name: 'Confirm' })

  await act(async () => {
    fireEvent.press(confirm)
    fireEvent.press(confirm)
  })

  expect(mockAttest).toHaveBeenCalledTimes(1)
  expect(mockBack).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled()
  expect(mockToast).not.toHaveBeenCalledWith('Backup confirmed', { type: 'success' })

  await act(async () => finishConfirmation())
  expect(mockBack).toHaveBeenCalledTimes(1)
  await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Confirm' })))
  expect(mockAttest).toHaveBeenCalledTimes(1)
  expect(mockBack).toHaveBeenCalledTimes(1)
})

it('does not record a backup merely by opening and leaving the recovery page', async () => {
  mockFlow = 'backup'
  const screen = await renderScreen()
  expect(screen.getByText(mockPhrase)).toBeTruthy()
  await act(async () => fireEvent.press(screen.getByRole('button', { name: 'go_back' })))
  expect(mockBack).toHaveBeenCalledTimes(1)
  screen.unmount()

  expect(mockAttest).not.toHaveBeenCalled()
  expect(mockMarkPending).not.toHaveBeenCalled()
})

it.each(['save', 'copy', 'print_recovery_shares'])('attests immediately after successful %s and waits for Confirm to leave', async action => {
  mockFlow = 'backup'
  const screen = await renderScreen()
  expect(screen.queryByTestId('backup-confirmation-section')).toBeNull()
  await act(async () => fireEvent.press(screen.getByText(action)))
  expect(screen.getByTestId('backup-confirmation-section')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Confirm' })).toBeEnabled()
  expect(mockAttest).toHaveBeenCalledWith(mockIdentityKey, action === 'print_recovery_shares' ? 'shares' : 'phrase')
  expect(mockBack).not.toHaveBeenCalled()

  await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Confirm' })))
  expect(mockAttest).toHaveBeenCalledTimes(1)
  expect(mockBack).toHaveBeenCalledTimes(1)
})

it.each(['save', 'copy', 'print_recovery_shares'])('waits for %s to finish before allowing confirmation', async action => {
  mockFlow = 'backup'
  let finishExport!: () => void
  if (action === 'save') {
    jest.mocked(Directory.pickDirectoryAsync).mockReturnValueOnce(new Promise<Directory>(resolve => {
      finishExport = () => resolve({ createFile: mockCreateFile } as unknown as Directory)
    }))
  } else if (action === 'copy') {
    jest.mocked(Clipboard.setStringAsync).mockReturnValueOnce(new Promise<boolean>(resolve => { finishExport = () => resolve(true) }))
  } else {
    mockPrint.mockReturnValueOnce(new Promise<{ ok: true }>(resolve => { finishExport = () => resolve({ ok: true }) }))
  }
  const screen = await renderScreen()
  await act(async () => { fireEvent.press(screen.getByText(action)) })
  expect(screen.queryByTestId('backup-confirmation-section')).toBeNull()
  await waitForHandwrittenBackup()
  const confirm = screen.getByRole('button', { name: 'Confirm' })
  await act(async () => fireEvent.press(confirm))
  expect(confirm).toBeDisabled()
  expect(mockAttest).not.toHaveBeenCalled()
  await act(async () => finishExport())
  expect(screen.getByRole('button', { name: 'Confirm' })).toBeEnabled()
  expect(mockAttest).toHaveBeenCalledWith(mockIdentityKey, action === 'print_recovery_shares' ? 'shares' : 'phrase')
  expect(mockBack).not.toHaveBeenCalled()

  await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Confirm' })))
  expect(mockAttest).toHaveBeenCalledTimes(1)
  expect(mockBack).toHaveBeenCalledTimes(1)
})

it.each(['copy rejection', 'copy false', 'save cancelled', 'save create failed', 'save write failed', 'save verification failed', 'print cancelled', 'print failed'])('does not attest or reveal confirmation early on %s', async outcome => {
  mockFlow = 'backup'
  let action = 'print_recovery_shares'
  if (outcome === 'copy rejection') jest.mocked(Clipboard.setStringAsync).mockRejectedValueOnce(new Error('clipboard failed'))
  if (outcome === 'copy false') jest.mocked(Clipboard.setStringAsync).mockResolvedValueOnce(false)
  if (outcome.startsWith('copy')) action = 'copy'
  if (outcome === 'save cancelled') jest.mocked(Directory.pickDirectoryAsync).mockRejectedValueOnce(new Error('cancelled'))
  if (outcome === 'save create failed') mockCreateFile.mockImplementationOnce(() => { throw new Error('create failed') })
  if (outcome === 'save write failed') mockWriteFile.mockImplementationOnce(() => { throw new Error('write failed') })
  if (outcome === 'save verification failed') mockReadFile.mockResolvedValueOnce('')
  if (outcome.startsWith('save')) action = 'save'
  if (outcome === 'print cancelled') mockPrint.mockResolvedValueOnce({ ok: false, reason: 'unavailable' })
  if (outcome === 'print failed') mockPrint.mockRejectedValueOnce(new Error('print failed'))
  const screen = await renderScreen()
  await act(async () => fireEvent.press(screen.getByText(action)))
  expect(screen.queryByTestId('backup-confirmation-section')).toBeNull()
  expect(mockAttest).not.toHaveBeenCalled()
  expect(mockBack).not.toHaveBeenCalled()
  if (outcome.startsWith('save') && outcome !== 'save cancelled') {
    expect(mockToast).toHaveBeenCalledWith('Unable to save recovery keys. Please try again.', { type: 'error' })
  } else {
    expect(mockToast).not.toHaveBeenCalledWith('Unable to save recovery keys. Please try again.', { type: 'error' })
  }
  await waitForHandwrittenBackup()
  expect(screen.getByTestId('backup-confirmation-section')).toBeTruthy()
  expect(mockAttest).not.toHaveBeenCalled()
})

it.each(['save', 'copy', 'print_recovery_shares'])('allows retrying a failed %s attestation with Confirm', async action => {
  mockFlow = 'backup'
  mockAttest.mockRejectedValueOnce(new Error('attestation failed'))
  const screen = await renderScreen()
  await act(async () => fireEvent.press(screen.getByText(action)))
  expect(screen.getByRole('button', { name: 'Confirm' })).toBeEnabled()
  expect(mockToast).toHaveBeenCalledWith('Unable to save backup confirmation. Please try again.', { type: 'error' })
  expect(mockBack).not.toHaveBeenCalled()
  await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Confirm' })))
  expect(mockAttest).toHaveBeenNthCalledWith(2, mockIdentityKey, action === 'print_recovery_shares' ? 'shares' : 'phrase')
  expect(mockBack).toHaveBeenCalledTimes(1)
})

it('waits until the generated wallet finishes building before allowing confirmation', async () => {
  let finishBuild!: () => void
  mockBuild.mockReturnValueOnce(new Promise<void>(resolve => { finishBuild = resolve }))
  const screen = await renderScreen()
  await act(async () => { fireEvent.press(screen.getByText('create_new_wallet')) })
  expect(screen.getByText(mockPhrase)).toBeTruthy()
  expect(screen.queryByTestId('backup-confirmation-section')).toBeNull()
  await waitForHandwrittenBackup()
  expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled()
  await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Confirm' })))
  expect(mockAttest).not.toHaveBeenCalled()

  await act(async () => finishBuild())
  expect(screen.getByRole('button', { name: 'Confirm' })).toBeEnabled()
  await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Confirm' })))
  expect(mockAttest).toHaveBeenCalledWith(mockIdentityKey, 'phrase')
  expect(screen.getByText('celebration')).toBeTruthy()
})

it('switches a reused import screen into existing-key backup and ignores stale import handlers', async () => {
  mockFlow = 'import'
  const screen = await renderScreen()
  fireEvent.changeText(screen.getByPlaceholderText('enter_recovery_words'), 'imported test mnemonic')
  let importButton = screen.getAllByText('import_wallet')[1].parent!
  while (!importButton.props.onPress) importButton = importButton.parent!
  const staleImport = importButton.props.onPress

  mockFlow = 'backup'
  await act(async () => screen.rerender(<MnemonicScreen />))
  await act(async () => staleImport())
  expect(screen.getByText(mockPhrase)).toBeTruthy()
  expect(screen.queryByPlaceholderText('enter_recovery_words')).toBeNull()
  expect(mockStoreMnemonic).not.toHaveBeenCalled()
  expect(mockBuild).not.toHaveBeenCalled()
})

it('blocks a stale create handler when a reused screen changes to backup', async () => {
  const screen = await renderScreen()
  let createButton = screen.getByText('create_new_wallet').parent!
  while (!createButton.props.onPress) createButton = createButton.parent!
  const staleCreate = createButton.props.onPress

  mockFlow = 'backup'
  await act(async () => screen.rerender(<MnemonicScreen />))
  await act(async () => staleCreate())
  expect(screen.getByText(mockPhrase)).toBeTruthy()
  expect(mockGenerate).not.toHaveBeenCalled()
  expect(mockCreateMnemonic).not.toHaveBeenCalled()
})

it('blocks an in-flight create identity check when the screen changes to backup', async () => {
  const screen = await renderScreen()
  let finishIdentityCheck!: (existing: boolean) => void
  mockHasStoredIdentity.mockReturnValueOnce(new Promise<boolean>(resolve => { finishIdentityCheck = resolve }))
  await act(async () => { fireEvent.press(screen.getByText('create_new_wallet')) })

  mockFlow = 'backup'
  await act(async () => screen.rerender(<MnemonicScreen />))
  await act(async () => finishIdentityCheck(false))
  expect(screen.getByText(mockPhrase)).toBeTruthy()
  expect(mockGenerate).not.toHaveBeenCalled()
  expect(mockCreateMnemonic).not.toHaveBeenCalled()
})

it('backs up a recovered private key with accurate labels, export material, and attestation identity', async () => {
  mockFlow = 'backup'
  const key = PrivateKey.fromHex('01'.padStart(64, '0'))
  mockGetMnemonic.mockResolvedValue(null)
  mockGetRecoveredKey.mockResolvedValue(key.toWif())
  const screen = await renderScreen()

  expect(screen.getByText('save_recovery_phrase_heading')).toBeTruthy()
  expect(screen.getByText(key.toHex())).toBeTruthy()
  expect(screen.queryByText('Save these words')).toBeNull()
  expect(mockRecoverMnemonic).not.toHaveBeenCalled()
  await act(async () => fireEvent.press(screen.getByText('save')))
  expect(mockWriteFile).toHaveBeenCalledWith(key.toHex())
  expect(mockCreateFile).toHaveBeenCalledWith(expect.stringMatching(/^wallet-recovery-key-.*\.txt$/), 'text/plain')
  expect(mockAttest).toHaveBeenCalledWith(key.toPublicKey().toString(), 'phrase')

  await act(async () => fireEvent.press(screen.getByText('copy')))
  expect(Clipboard.setStringAsync).toHaveBeenCalledWith(key.toHex())
  await act(async () => fireEvent.press(screen.getByText('print_recovery_shares')))
  expect(mockPrint).toHaveBeenCalledWith({ mnemonic: null, recoveredKeyWif: key.toWif(), appName: 'BSV Browser' })
  expect(mockAttest).toHaveBeenCalledTimes(3)
  await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Confirm' })))
  expect(mockAttest).toHaveBeenCalledWith(key.toPublicKey().toString(), 'shares')
  expect(mockBack).toHaveBeenCalledTimes(1)
  expect(mockGenerate).not.toHaveBeenCalled()
  expect(mockCreateMnemonic).not.toHaveBeenCalled()
  expect(mockSetRecoveredKey).not.toHaveBeenCalled()
  expect(mockBuildRecoveredKey).not.toHaveBeenCalled()
  expect(screen.queryByText('celebration')).toBeNull()
})

it('keeps existing locked identities away from the creation screen before the wallet builds', async () => {
  mockExistingIdentity = true
  const screen = await renderScreen()

  expect(screen.queryByText('create_new_wallet')).toBeNull()
  expect(mockReplace).toHaveBeenCalledWith({ pathname: '/auth/mnemonic', params: { flow: 'backup' } })
  expect(mockCreateMnemonic).not.toHaveBeenCalled()
})

it('waits for secret migration and the storage identity check before rendering creation', async () => {
  mockSecretsReady = false
  const screen = await renderScreen()
  expect(screen.queryByText('create_new_wallet')).toBeNull()
  expect(mockHasStoredIdentity).not.toHaveBeenCalled()

  let resolveIdentity!: (exists: boolean) => void
  mockHasStoredIdentity.mockReturnValue(new Promise<boolean>(resolve => { resolveIdentity = resolve }))
  mockSecretsReady = true
  await act(async () => screen.rerender(<MnemonicScreen />))
  expect(screen.queryByText('create_new_wallet')).toBeNull()

  await act(async () => resolveIdentity(true))
  expect(screen.queryByText('create_new_wallet')).toBeNull()
  expect(mockReplace).toHaveBeenCalledWith({ pathname: '/auth/mnemonic', params: { flow: 'backup' } })
})

it('checks for an identity again when the user presses create', async () => {
  const screen = await renderScreen()
  mockExistingIdentity = true
  await act(async () => fireEvent.press(screen.getByText('create_new_wallet')))

  expect(mockReplace).toHaveBeenCalledWith({ pathname: '/auth/mnemonic', params: { flow: 'backup' } })
  expect(mockGenerate).not.toHaveBeenCalled()
  expect(mockCreateMnemonic).not.toHaveBeenCalled()
})

it('creates one fresh identity and only displays and builds the phrase after it is saved', async () => {
  let finishWrite!: (saved: boolean) => void
  mockCreateMnemonic.mockReturnValue(new Promise<boolean>(resolve => { finishWrite = resolve }))
  const screen = await renderScreen()
  const createButton = screen.getByText('create_new_wallet')

  await act(async () => {
    fireEvent.press(createButton)
    fireEvent.press(createButton)
  })
  expect(mockGenerate).toHaveBeenCalledTimes(1)
  expect(mockCreateMnemonic).toHaveBeenCalledTimes(1)
  expect(mockCreateMnemonic).toHaveBeenCalledWith(mockPhrase)
  expect(mockStoreMnemonic).not.toHaveBeenCalled()
  expect(screen.queryByText(mockPhrase)).toBeNull()
  expect(mockBuild).not.toHaveBeenCalled()
  expect(mockMarkPending).not.toHaveBeenCalled()

  await act(async () => jest.advanceTimersByTime(30_000))
  await act(async () => finishWrite(true))
  expect(screen.getByText(mockPhrase)).toBeTruthy()
  expect(screen.queryByTestId('backup-confirmation-section')).toBeNull()
  await act(async () => jest.advanceTimersByTime(14_999))
  expect(screen.queryByTestId('backup-confirmation-section')).toBeNull()
  expect(mockMarkPending).toHaveBeenCalledWith(mockIdentityKey)
  expect(mockBuild).toHaveBeenCalledWith(mockPhrase)
  expect(mockAttest).not.toHaveBeenCalled()

  screen.unmount()
  expect(mockAttest).not.toHaveBeenCalled()
  expect(mockGenerate).toHaveBeenCalledTimes(1)
})

it('never displays or builds an unsaved phrase when the storage guard refuses creation', async () => {
  mockCreateMnemonic.mockResolvedValue(false)
  const screen = await renderScreen()
  await act(async () => fireEvent.press(screen.getByText('create_new_wallet')))

  expect(screen.queryByText(mockPhrase)).toBeNull()
  expect(mockBuild).not.toHaveBeenCalled()
  expect(mockMarkPending).not.toHaveBeenCalled()
  expect(mockStoreMnemonic).not.toHaveBeenCalled()
})

it('builds the saved wallet when pending-backup metadata cannot be written', async () => {
  mockMarkPending.mockRejectedValueOnce(new Error('AsyncStorage unavailable'))
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const screen = await renderScreen()
    const create = screen.getByText('create_new_wallet')
    await act(async () => {
      fireEvent.press(create)
      fireEvent.press(create)
    })

    expect(screen.getByText(mockPhrase)).toBeTruthy()
    expect(mockCreateMnemonic).toHaveBeenCalledTimes(1)
    expect(mockBuild).toHaveBeenCalledWith(mockPhrase)
    expect(mockGenerate).toHaveBeenCalledTimes(1)
    expect(mockStoreMnemonic).not.toHaveBeenCalled()
  } finally {
    warn.mockRestore()
  }
})

it('records a phrase backup when a generated wallet is confirmed without an export', async () => {
  const screen = await renderScreen()
  await act(async () => fireEvent.press(screen.getByText('create_new_wallet')))
  expect(mockAttest).not.toHaveBeenCalled()
  await waitForHandwrittenBackup()
  await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Confirm' })))

  expect(mockAttest).toHaveBeenCalledWith(mockIdentityKey, 'phrase')
  expect(screen.getByText('celebration')).toBeTruthy()
  expect(mockBack).not.toHaveBeenCalled()
  expect(mockPrint).not.toHaveBeenCalled()
  expect(Directory.pickDirectoryAsync).not.toHaveBeenCalled()
})

it('records the shares medium when a generated wallet prints recovery shares', async () => {
  const screen = await renderScreen()
  await act(async () => fireEvent.press(screen.getByText('create_new_wallet')))
  await act(async () => fireEvent.press(screen.getByText('print_recovery_shares')))
  // The printed sheet is a permanent offline artefact and names the app that
  // can read it back, so the app name is part of the print contract.
  expect(mockPrint).toHaveBeenCalledWith({ mnemonic: mockPhrase, recoveredKeyWif: null, appName: 'BSV Browser' })
  expect(mockAttest).toHaveBeenCalledWith(mockIdentityKey, 'shares')
  await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Confirm' })))

  expect(mockAttest).toHaveBeenCalledWith(mockIdentityKey, 'shares')
})

it('keeps explicit import available without passing through fresh creation', async () => {
  mockFlow = 'import'
  mockExistingIdentity = true
  const screen = await renderScreen()
  expect(screen.queryByText('create_new_wallet')).toBeNull()
  expect(mockReplace).not.toHaveBeenCalled()

  fireEvent.changeText(screen.getByPlaceholderText('enter_recovery_words'), mockPhrase)
  await act(async () => fireEvent.press(screen.getAllByText('import_wallet')[1]))

  expect(mockStoreMnemonic).toHaveBeenCalledWith(mockPhrase)
  expect(mockBuild).toHaveBeenCalledWith(mockPhrase, { restoreFromBackup: true })
  expect(mockCreateMnemonic).not.toHaveBeenCalled()
  // Importing IS the proof of a backup, so the reminder must never nag for it.
  expect(mockAttest).toHaveBeenCalledWith(mockIdentityKey, 'phrase')
})

it.each([
  ['phrase', () => mockPhrase, () => mockIdentityKey],
  [
    'hex key',
    () => PrivateKey.fromHex('01'.padStart(64, '0')).toHex(),
    () => PrivateKey.fromHex('01'.padStart(64, '0')).toPublicKey().toString()
  ]
])('rebuilds rather than no-ops when an imported %s replaces an auto-created wallet', async (_kind, value, identity) => {
  mockFlow = 'import'
  mockExistingIdentity = true
  mockWalletBuilt = true
  mockSetRecoveredKey.mockResolvedValue(true)
  const screen = await renderScreen()

  fireEvent.changeText(screen.getByPlaceholderText('enter_recovery_words'), value())
  await act(async () => fireEvent.press(screen.getAllByText('import_wallet')[1]))

  // buildWalletFrom* no-op once a wallet is already built, so the imported
  // secret would never take effect without the teardown-and-rebuild path.
  expect(mockRebuild).toHaveBeenCalledWith({ restoreFromBackup: true })
  expect(mockBuild).not.toHaveBeenCalled()
  expect(mockBuildRecoveredKey).not.toHaveBeenCalled()
  expect(mockAttest).toHaveBeenCalledWith(identity(), 'phrase')
})


it('resets the handwritten delay when the screen is reopened and cleans up the old timer', async () => {
  mockFlow = 'backup'
  const setTimer = jest.spyOn(global, 'setTimeout')
  const clearTimer = jest.spyOn(global, 'clearTimeout')
  const first = await renderScreen()
  const timerIndex = setTimer.mock.calls.findIndex(call => call[1] === 15_000)
  const timer = setTimer.mock.results[timerIndex].value
  await act(async () => jest.advanceTimersByTime(10_000))
  first.unmount()
  expect(clearTimer).toHaveBeenCalledWith(timer)
  const reopened = await renderScreen()
  await act(async () => jest.advanceTimersByTime(14_999))
  expect(reopened.queryByTestId('backup-confirmation-section')).toBeNull()
  await act(async () => jest.advanceTimersByTime(1))
  expect(reopened.getByTestId('backup-confirmation-section')).toBeTruthy()
  expect(mockAttest).not.toHaveBeenCalled()
})

it('resets confirmation on changed recovery material and rejects its previous Confirm handler', async () => {
  mockFlow = 'backup'
  const screen = await renderScreen()
  await waitForHandwrittenBackup()
  let previousButton = screen.getByRole('button', { name: 'Confirm' })
  while (!previousButton.props.onPress) previousButton = previousButton.parent!
  const previousConfirm = previousButton.props.onPress
  const key = PrivateKey.fromHex('02'.padStart(64, '0'))
  mockGetMnemonic.mockResolvedValue(null)
  mockGetRecoveredKey.mockResolvedValue(key.toWif())
  mockSecretsReady = false
  await act(async () => screen.rerender(<MnemonicScreen />))
  mockSecretsReady = true
  await act(async () => screen.rerender(<MnemonicScreen />))
  expect(screen.getByText(key.toHex())).toBeTruthy()
  expect(screen.queryByTestId('backup-confirmation-section')).toBeNull()
  await act(async () => previousConfirm())
  expect(mockAttest).not.toHaveBeenCalled()
  await act(async () => jest.advanceTimersByTime(14_999))
  expect(screen.queryByTestId('backup-confirmation-section')).toBeNull()
  await act(async () => jest.advanceTimersByTime(1))
  await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Confirm' })))
  expect(mockAttest).toHaveBeenCalledWith(key.toPublicKey().toString(), 'phrase')
})

it('resets confirmation when a reused screen leaves and returns to backup', async () => {
  mockFlow = 'backup'
  const screen = await renderScreen()
  await waitForHandwrittenBackup()
  let previousButton = screen.getByRole('button', { name: 'Confirm' })
  while (!previousButton.props.onPress) previousButton = previousButton.parent!
  const previousConfirm = previousButton.props.onPress
  mockFlow = 'import'
  await act(async () => screen.rerender(<MnemonicScreen />))
  mockFlow = 'backup'
  await act(async () => screen.rerender(<MnemonicScreen />))
  expect(screen.queryByTestId('backup-confirmation-section')).toBeNull()
  await act(async () => previousConfirm())
  expect(mockAttest).not.toHaveBeenCalled()
  expect(mockBack).not.toHaveBeenCalled()
  await waitForHandwrittenBackup()
  expect(screen.getByTestId('backup-confirmation-section')).toBeTruthy()
  expect(mockAttest).not.toHaveBeenCalled()
})

it.each(['save', 'copy', 'print_recovery_shares'])('ignores a pending %s completion after the backup session changes', async action => {
  mockFlow = 'backup'
  let finishExport!: () => void
  if (action === 'save') {
    jest.mocked(Directory.pickDirectoryAsync).mockReturnValueOnce(new Promise<Directory>(resolve => {
      finishExport = () => resolve({ createFile: mockCreateFile } as unknown as Directory)
    }))
  } else if (action === 'copy') {
    jest.mocked(Clipboard.setStringAsync).mockReturnValueOnce(new Promise<boolean>(resolve => { finishExport = () => resolve(true) }))
  } else {
    mockPrint.mockReturnValueOnce(new Promise<{ ok: true }>(resolve => { finishExport = () => resolve({ ok: true }) }))
  }
  const screen = await renderScreen()
  await act(async () => { fireEvent.press(screen.getByText(action)) })
  mockFlow = 'import'
  await act(async () => screen.rerender(<MnemonicScreen />))
  mockFlow = 'backup'
  await act(async () => screen.rerender(<MnemonicScreen />))
  await act(async () => finishExport())
  expect(mockAttest).not.toHaveBeenCalled()
  expect(mockWriteFile).not.toHaveBeenCalled()
  expect(screen.queryByTestId('backup-confirmation-section')).toBeNull()
  expect(mockBack).not.toHaveBeenCalled()
})

it.each(['save', 'copy', 'print_recovery_shares'])('ignores a pending %s completion after unmount', async action => {
  mockFlow = 'backup'
  let finishExport!: () => void
  if (action === 'save') {
    jest.mocked(Directory.pickDirectoryAsync).mockReturnValueOnce(new Promise<Directory>(resolve => {
      finishExport = () => resolve({ createFile: mockCreateFile } as unknown as Directory)
    }))
  } else if (action === 'copy') {
    jest.mocked(Clipboard.setStringAsync).mockReturnValueOnce(new Promise<boolean>(resolve => { finishExport = () => resolve(true) }))
  } else {
    mockPrint.mockReturnValueOnce(new Promise<{ ok: true }>(resolve => { finishExport = () => resolve({ ok: true }) }))
  }
  const screen = await renderScreen()
  await act(async () => { fireEvent.press(screen.getByText(action)) })
  screen.unmount()
  await act(async () => finishExport())
  expect(mockAttest).not.toHaveBeenCalled()
  expect(mockWriteFile).not.toHaveBeenCalled()
  expect(mockBack).not.toHaveBeenCalled()
})


it('keeps the confirmation timer active when React replays effects in StrictMode', async () => {
  mockFlow = 'backup'
  const screen = render(<React.StrictMode><MnemonicScreen /></React.StrictMode>)
  await act(async () => {})
  expect(screen.getByText(mockPhrase)).toBeTruthy()
  expect(screen.queryByTestId('backup-confirmation-section')).toBeNull()
  await waitForHandwrittenBackup()
  expect(screen.getByRole('button', { name: 'Confirm' })).toBeEnabled()
  expect(mockAttest).not.toHaveBeenCalled()
  await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Confirm' })))
  expect(mockAttest).toHaveBeenCalledWith(mockIdentityKey, 'phrase')
})


it('requires Confirm to attest shares after Android opens its print dialog', async () => {
  jest.replaceProperty(Platform, 'OS', 'android')
  mockFlow = 'backup'
  const screen = await renderScreen()
  expect(screen.queryByTestId('backup-confirmation-section')).toBeNull()
  await act(async () => fireEvent.press(screen.getByText('print_recovery_shares')))
  expect(screen.getByTestId('backup-confirmation-section')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Confirm' })).toBeEnabled()
  expect(mockAttest).not.toHaveBeenCalled()
  expect(mockBack).not.toHaveBeenCalled()
  await waitForHandwrittenBackup()
  expect(mockAttest).not.toHaveBeenCalled()
  await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Confirm' })))
  expect(mockAttest).toHaveBeenCalledTimes(1)
  expect(mockAttest).toHaveBeenCalledWith(mockIdentityKey, 'shares')
  expect(mockBack).toHaveBeenCalledTimes(1)
})

it('does not attest when the user leaves after opening Android print', async () => {
  jest.replaceProperty(Platform, 'OS', 'android')
  mockFlow = 'backup'
  const screen = await renderScreen()
  await act(async () => fireEvent.press(screen.getByText('print_recovery_shares')))
  screen.unmount()
  expect(mockAttest).not.toHaveBeenCalled()
  expect(mockBack).not.toHaveBeenCalled()
})
