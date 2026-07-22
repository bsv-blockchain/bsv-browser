/**
 * Tests for the auto-clearing secret clipboard helper. The raw recovery phrase
 * must not linger on the clipboard, but we must never clobber something the
 * user copied afterwards.
 */
jest.mock('expo-clipboard', () => ({
  __esModule: true,
  setStringAsync: jest.fn(),
  getStringAsync: jest.fn()
}))

import * as Clipboard from 'expo-clipboard'
import { copySecretToClipboard } from '@/utils/secureClipboard'

const mockClipboard = Clipboard as unknown as {
  setStringAsync: jest.Mock
  getStringAsync: jest.Mock
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.useFakeTimers()
  mockClipboard.setStringAsync.mockResolvedValue(true)
})

afterEach(() => {
  jest.useRealTimers()
})

describe('copySecretToClipboard', () => {
  it('writes the secret to the clipboard immediately', async () => {
    await copySecretToClipboard('seed words', { clearAfterMs: 60_000 })
    expect(mockClipboard.setStringAsync).toHaveBeenCalledWith('seed words')
  })

  it('clears the clipboard after the delay when it still holds the secret', async () => {
    mockClipboard.getStringAsync.mockResolvedValue('seed words')
    await copySecretToClipboard('seed words', { clearAfterMs: 60_000 })

    mockClipboard.setStringAsync.mockClear()
    await jest.advanceTimersByTimeAsync(60_000)

    expect(mockClipboard.getStringAsync).toHaveBeenCalled()
    expect(mockClipboard.setStringAsync).toHaveBeenCalledWith('')
  })

  it('does NOT clear when the user has since copied something else', async () => {
    mockClipboard.getStringAsync.mockResolvedValue('a different thing the user copied')
    await copySecretToClipboard('seed words', { clearAfterMs: 60_000 })

    mockClipboard.setStringAsync.mockClear()
    await jest.advanceTimersByTimeAsync(60_000)

    expect(mockClipboard.setStringAsync).not.toHaveBeenCalledWith('')
  })

  it('does not clear before the delay elapses', async () => {
    mockClipboard.getStringAsync.mockResolvedValue('seed words')
    await copySecretToClipboard('seed words', { clearAfterMs: 60_000 })

    mockClipboard.setStringAsync.mockClear()
    await jest.advanceTimersByTimeAsync(59_000)

    expect(mockClipboard.setStringAsync).not.toHaveBeenCalledWith('')
  })
})
