import { CAP_BLE, CAP_BLE_SCAN } from '@bsv/expo-wallet-toolbox/core/localpay/session'
import { satoshisFromToken } from '@bsv/expo-wallet-toolbox/core/pay/tokenAmount'
import { toWalletChain } from '@bsv/expo-wallet-toolbox/core/config'

// Deep subpaths, not the `@bsv/expo-wallet-toolbox` barrel. The barrel re-exports
// the contexts and the storage layer, and 18 modules on that graph import
// AsyncStorage / expo-sqlite / expo-secure-store at module scope, so importing it
// under Jest throws before any test body runs. That is fine in the app, where the
// native modules exist. Import deep here.
describe('@bsv/expo-wallet-toolbox: raw TS from node_modules is transformed and executed', () => {
  it('runs a deep-imported pure module', () => {
    expect(satoshisFromToken({ transaction: [] as unknown as never })).toBeUndefined()
  })

  it('reads config helpers without dragging in native modules', () => {
    expect(toWalletChain('main')).toBe('main')
  })

  it('exposes the BLE capability bits the browser now links CoreBluetooth for', () => {
    expect(CAP_BLE).toBe(0x04)
    expect(CAP_BLE_SCAN).toBe(0x08)
  })
})
