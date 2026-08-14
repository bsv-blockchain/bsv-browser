import { walletFrameIdentityFromUrl } from '@/utils/webview/walletOrigin'

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
