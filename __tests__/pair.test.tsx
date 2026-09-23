/**
 * PairScreen (ui/screens/PairScreen.tsx, rendered at app/pair.tsx) — the
 * desktop/browser pairing screen — must never hand the peer an UNGUARDED
 * WalletClient.
 *
 * B1 (critical, security): unlike every sibling call site (ConnectionsScreen's
 * handleScan/handleDisconnect/handleReconnect, index.tsx's CWI bridge), this
 * screen used to construct `new WalletClient(managers.permissionsManager,
 * originator)` directly — no guardVaultAccess. Once paired, the peer
 * dispatches arbitrary BRC-100 methods by name
 * (WalletConnectionContext.tsx's `wallet[request.method](request.params)`),
 * and getPublicKey/createSignature/encrypt/decrypt/etc. all accept
 * `privileged: true`, which — since PrivilegedKeyManager now returns the
 * plain wallet root key unconditionally — would hand root-key material to
 * whoever is on the other end of the QR/deep-link pairing, silently.
 *
 * This test does NOT mock '@bsv/sdk' or 'services/vault/guard': it renders
 * the real screen, drives the real "Approve" button, and then calls real
 * WalletClient methods against the real guardVaultAccess Proxy the screen
 * is supposed to have wrapped the wallet in — so a regression that removes
 * or weakens the guard call fails this test for real, not just structurally.
 */
// Pulled in as a side effect of requireActual-ing the barrel below (for the
// real guardVaultAccess/capWalletArgs/ADMIN_ORIGINATOR): its LocalStorageProvider
// chain reaches these native modules at module top level.
jest.mock('expo-local-authentication', () => ({
  getEnrolledLevelAsync: jest.fn(async () => 0),
  hasHardwareAsync: jest.fn(async () => false),
  isEnrolledAsync: jest.fn(async () => false),
  authenticateAsync: jest.fn(async () => ({ success: false })),
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
  AuthenticationType: { FINGERPRINT: 1, FACIAL_RECOGNITION: 2, IRIS: 3 }
}))
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
  WHEN_UNLOCKED: 'wu',
  AFTER_FIRST_UNLOCK: 'afu',
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afudo',
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'wudo'
}))

import React from 'react'
import { render, fireEvent, waitFor } from '@testing-library/react-native'
import { WalletClient } from '@bsv/sdk'
import { PairScreen } from '@bsv/expo-wallet-toolbox/ui/screens/PairScreen'
import { ThemeProvider, VaultAccessDenied, type ConnectParams } from '@bsv/expo-wallet-toolbox'

// The wallet the screen is handed — a stand-in for the real
// WalletPermissionsManager. Only `getPublicKey` needs to exist: guardVaultAccess's
// Proxy only intercepts methods in its privileged-capable set, and getPublicKey
// is one of the 9 the finding calls out as reachable through IMPLEMENTED_METHODS.
const mockPermissionsManager = {
  // A real point (the generator): WalletClient validates the key it returns.
  getPublicKey: jest.fn(async () => ({
    publicKey: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
  }))
}

// Partial mock: app/pair.tsx pulls useWallet/useWalletConnection from the same
// package barrel as guardVaultAccess/capWalletArgs/ADMIN_ORIGINATOR — which
// this test deliberately leaves REAL (see the file header) — so only the two
// hooks are overridden here, via requireActual for everything else.
const mockConnect = jest.fn(async (_params: ConnectParams, _wallet: WalletClient) => {})
jest.mock('@bsv/expo-wallet-toolbox', () => ({
  ...jest.requireActual('@bsv/expo-wallet-toolbox'),
  useWallet: () => ({ managers: { permissionsManager: mockPermissionsManager } }),
  useWalletConnection: () => ({
    status: 'idle',
    sessionMeta: undefined,
    errorMsg: undefined,
    connect: mockConnect,
    disconnect: jest.fn(),
    startNavTimer: jest.fn(),
    cancelNavTimer: jest.fn()
  })
}))

const FUTURE_EXPIRY = String(Math.floor(Date.now() / 1000) + 3600)
const mockParams = {
  topic: 'topic-1',
  backendIdentityKey: '02' + '22'.repeat(32),
  protocolID: JSON.stringify([2, 'pairing']),
  origin: 'https://evil.com',
  expiry: FUTURE_EXPIRY
}
jest.mock('expo-router', () => ({
  router: { back: jest.fn() },
  useLocalSearchParams: () => mockParams
}))

const draw = () =>
  render(
    <ThemeProvider>
      <PairScreen />
    </ThemeProvider>
  )

beforeEach(() => {
  mockConnect.mockClear()
  mockPermissionsManager.getPublicKey.mockClear()
})

test('Approve constructs the WalletClient from a GUARDED wallet, not the raw permissionsManager', async () => {
  const { getByText } = draw()

  fireEvent.press(getByText('Approve'))

  await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(1))

  const [, walletArg] = mockConnect.mock.calls[0]
  expect(walletArg).toBeInstanceOf(WalletClient)

  // The peer's own origin ('evil.com', from params.origin) becomes this
  // WalletClient's originator for every delegated call — exactly what a
  // paired peer would drive via wallet[request.method](request.params). A
  // privileged call through it must be rejected by the guard before it ever
  // reaches the underlying permissions manager.
  await expect(
    (walletArg as WalletClient).getPublicKey({
      privileged: true,
      // WalletClient itself rejects a privileged call without a reason, which
      // would pass this test without the guard ever being consulted.
      privilegedReason: 'vault access',
      protocolID: [2, 'vault'],
      keyID: 'vault/0',
      counterparty: 'self'
    } as any)
  ).rejects.toBeInstanceOf(VaultAccessDenied)
  expect(mockPermissionsManager.getPublicKey).not.toHaveBeenCalled()

  // Sanity: a NON-privileged call from the same peer still passes through —
  // proving the rejection above is the guard discriminating on `privileged`,
  // not some blanket block that would just as well pass with an unguarded
  // wallet swapped back in.
  await (walletArg as WalletClient).getPublicKey({
    protocolID: [1, 'pairing test'],
    keyID: '1',
    counterparty: 'self'
  } as any)
  expect(mockPermissionsManager.getPublicKey).toHaveBeenCalledTimes(1)
})
