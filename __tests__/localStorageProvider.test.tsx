/**
 * Contract tests for the secure-storage accessors in LocalStorageProvider.
 *
 * These assert the JS-visible contract only: which options are passed to
 * expo-secure-store, that there is NO in-JS auth latch (the OS enforces auth
 * per read), and how invalidated (null) vs cancelled (reject) reads are
 * surfaced. Actual native biometric enforcement is covered by on-device
 * verification, not Jest.
 */
import React from 'react'
import { renderHook, act } from '@testing-library/react-native'

// --- mocks -----------------------------------------------------------------

jest.mock('expo-secure-store', () => ({
  __esModule: true,
  setItemAsync: jest.fn(),
  getItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY'
}))
import * as SecureStore from 'expo-secure-store'
const mockSecureStore = SecureStore as unknown as {
  setItemAsync: jest.Mock
  getItemAsync: jest.Mock
  deleteItemAsync: jest.Mock
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: string
}

// If the implementation still imports expo-local-authentication we want the
// test to prove it is never invoked (OS handles auth now).
const mockAuthenticate = jest.fn(async () => ({ success: true }))
jest.mock('expo-local-authentication', () => ({
  authenticateAsync: mockAuthenticate
}))

// In-memory AsyncStorage.
const memStore: Record<string, string> = {}
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (k: string) => (k in memStore ? memStore[k] : null)),
    setItem: jest.fn(async (k: string, v: string) => {
      memStore[k] = v
    }),
    removeItem: jest.fn(async (k: string) => {
      delete memStore[k]
    })
  }
}))

jest.mock('@/context/i18n/translations', () => ({
  __esModule: true,
  default: { t: (key: string) => key }
}))

import LocalStorageProvider, { useLocalStorage } from '@/context/LocalStorageProvider'

const SECURE_KEYCHAIN_SERVICE = 'bsv-wallet-secure'
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <LocalStorageProvider>{children}</LocalStorageProvider>
)

beforeEach(() => {
  jest.clearAllMocks()
  for (const k of Object.keys(memStore)) delete memStore[k]
  mockSecureStore.getItemAsync.mockResolvedValue(null)
})

describe('LocalStorageProvider secure accessors', () => {
  it('stores the mnemonic OS-auth-bound to a dedicated keychain service', async () => {
    const { result } = renderHook(() => useLocalStorage(), { wrapper })

    let ok = false
    await act(async () => {
      ok = await result.current.setMnemonic('correct horse battery staple')
    })

    expect(ok).toBe(true)
    expect(mockSecureStore.setItemAsync).toHaveBeenCalledWith(
      'mnemonic',
      'correct horse battery staple',
      expect.objectContaining({
        requireAuthentication: true,
        keychainService: SECURE_KEYCHAIN_SERVICE,
        keychainAccessible: mockSecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY
      })
    )
    expect(memStore['hasWalletKeys']).toBe('true')
  })

  it('reads the mnemonic with requireAuthentication + a custom prompt', async () => {
    memStore['hasWalletKeys'] = 'true'
    mockSecureStore.getItemAsync.mockResolvedValue('my phrase')
    const { result } = renderHook(() => useLocalStorage(), { wrapper })

    let value: string | null = null
    await act(async () => {
      value = await result.current.getMnemonic()
    })

    expect(value).toBe('my phrase')
    expect(mockSecureStore.getItemAsync).toHaveBeenCalledWith(
      'mnemonic',
      expect.objectContaining({
        requireAuthentication: true,
        keychainService: SECURE_KEYCHAIN_SERVICE,
        authenticationPrompt: expect.any(String)
      })
    )
  })

  it('does NOT use an in-JS auth latch — never calls LocalAuthentication and hits the keychain every read', async () => {
    memStore['hasWalletKeys'] = 'true'
    mockSecureStore.getItemAsync.mockResolvedValue('phrase')
    const { result } = renderHook(() => useLocalStorage(), { wrapper })

    await act(async () => {
      await result.current.getMnemonic()
      await result.current.getMnemonic()
    })

    expect(mockAuthenticate).not.toHaveBeenCalled()
    expect(mockSecureStore.getItemAsync).toHaveBeenCalledTimes(2)
  })

  it('returns null (does not throw) when the item was invalidated but the flag is still set', async () => {
    memStore['hasWalletKeys'] = 'true'
    mockSecureStore.getItemAsync.mockResolvedValue(null) // invalidated → SDK returns null
    const { result } = renderHook(() => useLocalStorage(), { wrapper })

    let value: string | null = 'sentinel'
    await act(async () => {
      value = await result.current.getMnemonic()
    })

    expect(value).toBeNull()
  })

  it('rethrows when the user cancels the biometric prompt (getItemAsync rejects)', async () => {
    memStore['hasWalletKeys'] = 'true'
    mockSecureStore.getItemAsync.mockRejectedValue(new Error('User canceled the authentication'))
    const { result } = renderHook(() => useLocalStorage(), { wrapper })

    await expect(
      act(async () => {
        await result.current.getMnemonic()
      })
    ).rejects.toThrow(/cancel/i)
  })

  it('short-circuits to null without touching the keychain when no wallet exists', async () => {
    const { result } = renderHook(() => useLocalStorage(), { wrapper })

    let value: string | null = 'sentinel'
    await act(async () => {
      value = await result.current.getMnemonic()
    })

    expect(value).toBeNull()
    expect(mockSecureStore.getItemAsync).not.toHaveBeenCalled()
  })

  it('no longer exposes the dead WAB password accessors', () => {
    const { result } = renderHook(() => useLocalStorage(), { wrapper })
    expect((result.current as unknown as Record<string, unknown>).getPassword).toBeUndefined()
    expect((result.current as unknown as Record<string, unknown>).setPassword).toBeUndefined()
    expect((result.current as unknown as Record<string, unknown>).deletePassword).toBeUndefined()
  })

  it('no longer exposes the dead plaintext snapshot accessors', () => {
    const { result } = renderHook(() => useLocalStorage(), { wrapper })
    expect((result.current as unknown as Record<string, unknown>).setSnap).toBeUndefined()
    expect((result.current as unknown as Record<string, unknown>).getSnap).toBeUndefined()
  })
})
