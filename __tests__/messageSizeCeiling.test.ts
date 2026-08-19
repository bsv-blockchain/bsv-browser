import {
  DOWNLOAD_BLOB_CHARS_MAX,
  MESSAGE_CHARS_MAX,
  messageTooLarge
} from '@/utils/webview/messageSizeCeiling'

describe('messageTooLarge', () => {
  it('allows an ordinary CWI message', () => {
    expect(messageTooLarge('{"type":"CWI","call":"getPublicKey","args":{}}')).toBe(false)
  })

  it('allows a message right at the ceiling', () => {
    expect(messageTooLarge('x'.repeat(MESSAGE_CHARS_MAX))).toBe(false)
  })

  it('refuses a huge non-download message', () => {
    expect(messageTooLarge('{"type":"CWI",' + 'x'.repeat(MESSAGE_CHARS_MAX))).toBe(true)
  })

  it('allows a large download blob up to its own, higher ceiling', () => {
    // The app posts entire files to itself through this channel, which has no
    // size limit of its own.
    const head = '{"type":"FILE_DOWNLOAD_BLOB","data":"'
    expect(messageTooLarge(head + 'A'.repeat(MESSAGE_CHARS_MAX))).toBe(false)
    expect(messageTooLarge(head + 'A'.repeat(DOWNLOAD_BLOB_CHARS_MAX))).toBe(true)
  })

  it('does not let a page borrow the download allowance for a wallet call', () => {
    // A CWI call that begins with the download prefix would not dispatch as a
    // wallet call at all, so the allowance is not reachable from a page that
    // wants wallet work done.
    const spoof = '{"type":"CWI","call":"createAction","args":{' + 'y'.repeat(MESSAGE_CHARS_MAX)
    expect(messageTooLarge(spoof)).toBe(true)
  })

  it('judges a 30 MB string without parsing it', () => {
    const t0 = Date.now()
    expect(messageTooLarge('{"type":"CWI",' + 'y'.repeat(30_000_000))).toBe(true)
    expect(Date.now() - t0).toBeLessThan(50)
  })

  it('tolerates a non-string, which the RN bridge should never send', () => {
    expect(messageTooLarge(undefined as unknown as string)).toBe(false)
  })
})
