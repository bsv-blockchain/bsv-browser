import { satoshisFromToken } from '@bsv/expo-wallet-toolbox/core/pay/tokenAmount'
import { CAP_BLE, CAP_BLE_SCAN } from '@bsv/expo-wallet-toolbox/core/localpay/session'

describe('@bsv/expo-wallet-toolbox: raw TS from node_modules is transformed and executed', () => {
  it('runs a deep-imported pure module', () => {
    expect(satoshisFromToken({ transaction: [] as unknown as never })).toBeUndefined()
  })

  it('exposes the BLE capability bits the browser now links CoreBluetooth for', () => {
    expect(CAP_BLE).toBe(0x04)
    expect(CAP_BLE_SCAN).toBe(0x08)
  })
})
