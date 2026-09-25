import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ADMIN_ORIGINATOR } from '@/context/config'
import { ADMIN_ORIGINATOR as TOOLBOX_ADMIN_ORIGINATOR } from '@bsv/expo-wallet-toolbox'
import { resolveWalletFrameIdentity, walletFrameIdentityFromUrl } from '@/utils/webview/walletOrigin'

describe('walletFrameIdentityFromUrl', () => {
  it('uses the embedded frame hostname instead of its top-level container', () => {
    expect(walletFrameIdentityFromUrl('https://convo.babbage.systems/chat?embedded=1')).toEqual({
      originator: 'convo.babbage.systems',
      responseOrigin: 'https://convo.babbage.systems'
    })
  })

  it('keeps the response port while omitting it from the BRC-100 originator', () => {
    expect(walletFrameIdentityFromUrl('http://localhost:5173/app')).toEqual({
      originator: 'localhost',
      responseOrigin: 'http://localhost:5173'
    })
  })

  it.each(['about:blank', 'data:text/html,hello', 'not a url', '', undefined])(
    'rejects an unverifiable frame URL: %p',
    value => {
      expect(walletFrameIdentityFromUrl(value)).toBeUndefined()
    }
  )
})

describe('resolveWalletFrameIdentity', () => {
  it('prefers a verifiable embedded frame URL over the tab URL', () => {
    expect(
      resolveWalletFrameIdentity('https://convo.babbage.systems/chat?embedded=1', 'https://babbageos.com/')
    ).toEqual({
      originator: 'convo.babbage.systems',
      responseOrigin: 'https://convo.babbage.systems'
    })
  })

  it('falls back to the tab URL when the native frame URL is unverifiable', () => {
    expect(resolveWalletFrameIdentity('about:blank', 'https://peerpay.babbage.systems/app')).toEqual({
      originator: 'peerpay.babbage.systems',
      responseOrigin: 'https://peerpay.babbage.systems'
    })
    expect(resolveWalletFrameIdentity('', 'https://peerpay.babbage.systems/app')).toEqual({
      originator: 'peerpay.babbage.systems',
      responseOrigin: 'https://peerpay.babbage.systems'
    })
    expect(resolveWalletFrameIdentity(undefined, 'https://peerpay.babbage.systems/app')).toEqual({
      originator: 'peerpay.babbage.systems',
      responseOrigin: 'https://peerpay.babbage.systems'
    })
  })

  it('still fail-closes when neither the frame URL nor the tab URL is verifiable', () => {
    expect(resolveWalletFrameIdentity('about:blank', 'about:blank')).toBeUndefined()
    expect(resolveWalletFrameIdentity('', undefined)).toBeUndefined()
  })

  it('handleMessage uses the native frame URL with a tab-URL fallback', () => {
    const index = readFileSync(resolve(process.cwd(), 'app/index.tsx'), 'utf8')
    expect(index).toContain('resolveWalletFrameIdentity(eventUrl, activeTab.url)')
  })

  it('refuses frames in the reserved .invalid TLD that holds the admin originator', () => {
    expect(walletFrameIdentityFromUrl(`https://${ADMIN_ORIGINATOR}/`)).toBeUndefined()
    expect(walletFrameIdentityFromUrl('https://evil.INVALID./x')).toBeUndefined()
    expect(walletFrameIdentityFromUrl('http://invalid/')).toBeUndefined()
    expect(resolveWalletFrameIdentity('https://admin.invalid/', 'https://example.com/')).toEqual({
      originator: 'example.com',
      responseOrigin: 'https://example.com'
    })
  })

  it('uses the toolbox admin originator, not a registrable domain', () => {
    expect(ADMIN_ORIGINATOR).toBe(TOOLBOX_ADMIN_ORIGINATOR)
    expect(ADMIN_ORIGINATOR.endsWith('.invalid')).toBe(true)
  })
})
