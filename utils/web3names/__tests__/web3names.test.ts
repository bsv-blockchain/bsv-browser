import { parseWeb3Name } from '../names'
import { classifyAddressInput } from '../addressBar'
import { signedPreimage, sighashOf, verifyAnswer, bytesToHex } from '../verify'
import { parseOrdEnvelope, lockingScriptOf, txidOf } from '../ordContent'
import type { CryptoDeps, ResolveAnswer } from '../types'
import { bytesToBase64, web3ErrorPage, web3TooLargePage, MAX_INLINE_BYTES } from '../render'
import { createHash } from 'node:crypto'

const deps: CryptoDeps = {
  sha256: (d) => new Uint8Array(createHash('sha256').update(d).digest()),
  ecdsaVerifyDer: () => true
}

// The frozen ODNCA-STD-001 §6 conformance vector.
const vector: ResolveAnswer = {
  ok: true,
  v: 1,
  input: 'alexander@ordnet.web3',
  name: 'ordnet.web3',
  mailbox: 'alexander',
  source: 'sns',
  fallback: true,
  holder_address: '1x',
  holder_script: '76a914e8e5f64b0c7943b93e58b24e3f82d533e70b3db188ac',
  origin: { txid: '367a0a1d553002f0f3427168a10f86835e2741c111df43262d35fb475400e3ee', vout: 0 },
  current: { txid: 'dc54c20af97682eebf99dc8392c21b904908398d543aae6fabffe09a9b7780ac', vout: 0 },
  as_of_height: 959941,
  expires: 1785312000,
  sig: '30440220' + '11'.repeat(32) + '0220' + '22'.repeat(32),
  signer: '03088f1da3bfc998c1bc7bbc1ffcb7d96c47e094624a52d78406f8c3105b0d0b46'
}

describe('names', () => {
  it('parses a bare name', () => {
    expect(parseWeb3Name('earthlog.web3')).toEqual({ address: 'earthlog.web3', name: 'earthlog.web3', mailbox: null, tld: 'web3' })
  })
  it('parses a mailbox form', () => {
    expect(parseWeb3Name('Pay@Earthlog.WEB3')).toEqual({ address: 'pay@earthlog.web3', name: 'earthlog.web3', mailbox: 'pay', tld: 'web3' })
  })
  it('strips schemes and paths', () => {
    expect(parseWeb3Name('web3://earthlog.web3/index.html')!.name).toBe('earthlog.web3')
    expect(parseWeb3Name('sns:earthlog.web3')!.name).toBe('earthlog.web3')
  })
  it('keeps non-ASCII bytes exact (no lowercasing)', () => {
    expect(parseWeb3Name('CAFÉ.web3')!.name).toBe('CAFÉ.web3')
  })
  it('parses web2-looking shapes (the TLD set is the gate, not the parser)', () => {
    expect(parseWeb3Name('example.com')!.tld).toBe('com')
  })
  it('rejects non-name shapes', () => {
    expect(parseWeb3Name('foo bar.web3')).toBeNull()
    expect(parseWeb3Name('a@b@c.web3')).toBeNull()
    expect(parseWeb3Name('a.b.c')).toBeNull()
    expect(parseWeb3Name('noDots')).toBeNull()
    expect(parseWeb3Name('.web3')).toBeNull()
  })
})

describe('addressBar', () => {
  it('classifies a known-TLD name as web3', () => {
    expect(classifyAddressInput('earthlog.web3').kind).toBe('web3')
  })
  it('passes real-world URLs through untouched', () => {
    expect(classifyAddressInput('https://example.com').kind).toBe('passthrough')
    expect(classifyAddressInput('example.com').kind).toBe('passthrough')
    expect(classifyAddressInput('what is bsv').kind).toBe('passthrough')
  })
})

describe('verify (ODNCA-STD-001 §6)', () => {
  it('reproduces the frozen conformance sighash bit-exactly', () => {
    expect(sighashOf(vector, deps)).toBe('28a4252e92fdcdb70d6fd287cdb602cda504d288963e106b47a6d8d19420ec6b')
  })
  it('changes the sighash when any signed field changes', () => {
    const tampered = { ...vector, holder_script: '76a914' + '00'.repeat(20) + '88ac' }
    expect(sighashOf(tampered, deps)).not.toBe(sighashOf(vector, deps))
  })
  it('does not sign unsigned fields (holder_address is derivable)', () => {
    const changed = { ...vector, holder_address: '1different' }
    expect(bytesToHex(signedPreimage(changed))).toBe(bytesToHex(signedPreimage(vector)))
  })
  it('rejects expired answers before touching the signature', () => {
    const verdict = verifyAnswer(vector, deps, { resolverPubKey: vector.signer, nowSeconds: vector.expires + 1 })
    expect(verdict).toEqual({ valid: false, reason: 'expired' })
  })
  it('rejects an unknown signer against the pinned key', () => {
    const verdict = verifyAnswer(vector, deps, { resolverPubKey: '02' + 'ab'.repeat(32), nowSeconds: 0 })
    expect(verdict).toEqual({ valid: false, reason: 'unknown_signer' })
  })
})

describe('ordContent', () => {
  const pushData = (data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(1 + data.length)
    out[0] = data.length
    out.set(data, 1)
    return out
  }
  const enc = new TextEncoder()
  const buildEnvelope = (contentType: string, body: string): Uint8Array => {
    const parts = [
      new Uint8Array([0x76, 0xa9, 0x14]), new Uint8Array(20), new Uint8Array([0x88, 0xac]), // p2pkh prefix
      new Uint8Array([0x00, 0x63]), // OP_FALSE OP_IF
      pushData(enc.encode('ord')),
      new Uint8Array([0x51]), pushData(enc.encode(contentType)), // OP_1 <ct>
      new Uint8Array([0x00]), pushData(enc.encode(body)), // OP_0 <body>
      new Uint8Array([0x68]) // OP_ENDIF
    ]
    const total = parts.reduce((n, p) => n + p.length, 0)
    const out = new Uint8Array(total)
    let o = 0
    for (const p of parts) { out.set(p, o); o += p.length }
    return out
  }
  it('parses a 1sat ord envelope from a locking script', () => {
    const parsed = parseOrdEnvelope(buildEnvelope('text/html', '<h1>hi</h1>'))
    expect(parsed).not.toBeNull()
    expect(parsed!.contentType).toBe('text/html')
    expect(new TextDecoder().decode(parsed!.body)).toBe('<h1>hi</h1>')
  })
  it('returns null for a plain p2pkh script', () => {
    const plain = new Uint8Array([0x76, 0xa9, 0x14, ...new Uint8Array(20), 0x88, 0xac])
    expect(parseOrdEnvelope(plain)).toBeNull()
  })
  it('recomputes a txid from raw bytes (content addressing)', () => {
    const raw = new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    const twice = deps.sha256(deps.sha256(raw))
    const expected = bytesToHex(twice.slice().reverse())
    expect(txidOf(raw, deps)).toBe(expected)
  })
  it('extracts the right output script from a real-shaped raw tx', () => {
    // minimal tx: version(4) | 1 input (prevout 36 + scriptlen 0 + seq 4) | 2 outputs | locktime
    const script0 = new Uint8Array([0x51])
    const script1 = buildEnvelope('text/plain', 'x')
    const parts = [
      new Uint8Array([1, 0, 0, 0]),
      new Uint8Array([1]), new Uint8Array(36), new Uint8Array([0]), new Uint8Array([0xff, 0xff, 0xff, 0xff]),
      new Uint8Array([2]),
      new Uint8Array(8), new Uint8Array([script0.length]), script0,
      new Uint8Array(8), new Uint8Array([script1.length]), script1,
      new Uint8Array(4)
    ]
    const total = parts.reduce((n, p) => n + p.length, 0)
    const raw = new Uint8Array(total)
    let o = 0
    for (const p of parts) { raw.set(p, o); o += p.length }
    const got = lockingScriptOf(raw, 1)
    expect(got).not.toBeNull()
    expect(parseOrdEnvelope(got!)!.contentType).toBe('text/plain')
  })
})


describe('openWeb3Site helpers', () => {
  it('base64-encodes bytes correctly (padded and unpadded)', () => {
    const enc = (s: string) => bytesToBase64(new TextEncoder().encode(s))
    expect(enc('hi')).toBe('aGk=')
    expect(enc('hey')).toBe('aGV5')
    expect(enc('<h1>x</h1>')).toBe(Buffer.from('<h1>x</h1>').toString('base64'))
  })
  it('renders an honest error page as a data uri', () => {
    const uri = web3ErrorPage('nope.web3', 'This name is not registered on-chain.')
    expect(uri.startsWith('data:text/html;base64,')).toBe(true)
    const html = Buffer.from(uri.split(',')[1], 'base64').toString('utf8')
    expect(html.includes('nope.web3')).toBe(true)
    expect(html.includes('not registered')).toBe(true)
  })
})


describe('tld refresh guards', () => {
  it('refuses web2 TLDs and junk shapes from a hostile /health', async () => {
    const { refreshTlds, isKnownTld } = await import('../tlds')
    const hostile = async () => ({ ok: true, json: async () => ({ tlds: ['com', 'ORG', 'x', 'evil$', 'sats'], retired_tlds: [] }) }) as any
    await refreshTlds('https://x', 0, hostile as any)
    expect(isKnownTld('com')).toBe(false)
    expect(isKnownTld('org')).toBe(false)
    expect(isKnownTld('sats')).toBe(true)
    expect(isKnownTld('web3')).toBe(true)
  })
})

describe('ord envelope body (1Sat spec: single push, not concatenated)', () => {
  it('takes only the first body push', () => {
    const enc = new TextEncoder()
    const push = (d: Uint8Array) => { const o = new Uint8Array(1 + d.length); o[0] = d.length; o.set(d, 1); return o }
    const parts = [
      new Uint8Array([0x00, 0x63]), push(enc.encode('ord')),
      new Uint8Array([0x51]), push(enc.encode('text/plain')),
      new Uint8Array([0x00]), push(enc.encode('hello')), push(enc.encode('IGNORED')),
      new Uint8Array([0x68])
    ]
    const total = parts.reduce((n, p) => n + p.length, 0)
    const script = new Uint8Array(total)
    let o = 0
    for (const p of parts) { script.set(p, o); o += p.length }
    const parsed = parseOrdEnvelope(script)
    expect(new TextDecoder().decode(parsed!.body)).toBe('hello')
  })
})

describe('size cap', () => {
  it('renders an honest too-large page above the inline ceiling', () => {
    const uri = web3TooLargePage('big.web3', MAX_INLINE_BYTES + 1024)
    const html = Buffer.from(uri.split(',')[1], 'base64').toString('utf8')
    expect(html.includes('larger than the browser will render inline')).toBe(true)
  })
})
