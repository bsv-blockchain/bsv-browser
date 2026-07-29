import { Platform } from 'react-native'
import { selectTransport } from '@/utils/localpay/transport/select'
import { mintSession, CAP_AWDL, CAP_NEARBY, type Session } from '@/utils/localpay/session'

let mockIsSupported = true

jest.mock('react-native-localpay-transport', () => ({
  getLocalPayTransport: () => ({ isSupported: () => mockIsSupported })
}))

const base = {
  identityKey: '02'.padEnd(66, 'd'),
  amount: 1,
  derivationPrefix: 'cA',
  derivationSuffix: 'cw'
}

describe('transport selection', () => {
  afterEach(() => {
    Platform.OS = 'ios'
    mockIsSupported = true
  })

  it('uses AWDL when both sides support it', () => {
    Platform.OS = 'ios'
    expect(selectTransport(mintSession({ ...base, supportsAwdl: true }))).toBe('awdl')
  })

  it('falls back to QR when the payee cannot do AWDL', () => {
    Platform.OS = 'ios'
    expect(selectTransport(mintSession({ ...base, supportsAwdl: false }))).toBe('qr')
  })

  it('falls back to QR when the local device is Android', () => {
    Platform.OS = 'android'
    expect(selectTransport(mintSession({ ...base, supportsAwdl: true }))).toBe('qr')
  })

  it('leaves the AWDL capability bit set only when advertised', () => {
    expect(mintSession({ ...base, supportsAwdl: false }).caps & CAP_AWDL).toBe(0)
  })

  // caps × platform × native support → transport
  const CASES: [caps: number, platform: 'ios' | 'android', native: boolean, expected: string][] = [
    [CAP_AWDL, 'ios', true, 'awdl'],
    [CAP_AWDL, 'ios', false, 'qr'],
    [CAP_AWDL, 'android', true, 'qr'], // AWDL cap useless off-iOS
    [CAP_NEARBY, 'android', true, 'nearby'],
    [CAP_NEARBY, 'android', false, 'qr'],
    [CAP_NEARBY, 'ios', true, 'qr'], // Nearby cap useless on iOS
    [CAP_AWDL | CAP_NEARBY, 'ios', true, 'awdl'], // AWDL outranks Nearby
    [CAP_AWDL | CAP_NEARBY, 'android', true, 'nearby'],
    [0, 'ios', true, 'qr'],
    [0, 'android', true, 'qr']
  ]

  it.each(CASES)('caps=%p platform=%s native=%p -> %s', (caps, platform, native, expected) => {
    Platform.OS = platform
    mockIsSupported = native
    const session: Session = { ...mintSession({ ...base, supportsAwdl: false }), caps }
    expect(selectTransport(session)).toBe(expected)
  })
})
