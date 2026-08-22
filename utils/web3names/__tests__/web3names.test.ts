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
const ASK = 'alexander@ordnet.web3' // what the caller actually asked for
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
    const verdict = verifyAnswer(vector, deps, { resolverPubKey: vector.signer, nowSeconds: vector.expires + 1, expectName: ASK })
    expect(verdict).toEqual({ valid: false, reason: 'expired' })
  })
  it('rejects an unknown signer against the pinned key', () => {
    const verdict = verifyAnswer(vector, deps, { resolverPubKey: '02' + 'ab'.repeat(32), nowSeconds: 0, expectName: ASK })
    expect(verdict).toEqual({ valid: false, reason: 'unknown_signer' })
  })
})

/* ------------------------------------------------------------------ *
 * H3 — an answer must be bound to the question that was asked.
 *
 * A signature covers the answer's OWN name, so a correctly signed,
 * unexpired answer for one name verifies against a request for another
 * unless the caller states what it asked for. Every cache, proxy or relay
 * in the path is otherwise a substitution point.
 * ------------------------------------------------------------------ */
describe('verify / expiry actually expires', () => {
  // `a.expires <= now` is false for every non-numeric value, so a missing,
  // NaN or string expires meant "never expires" — with a valid signature
  // over it. The whole freshness model rests on this one field.
  const YEAR_2100 = 4102444800
  const opts = { resolverPubKey: vector.signer, nowSeconds: YEAR_2100, expectName: ASK }

  for (const [label, value] of [
    ['missing', undefined],
    ['null', null],
    ['NaN', NaN],
    ['a string', 'not-a-number'],
    ['an object', {}],
    ['Infinity', Infinity],
    ['a numeric string', '9999999999']
  ] as Array<[string, any]>) {
    it(`rejects ${label} expires as expired`, () => {
      const a: any = { ...vector }
      if (value === undefined) delete a.expires; else a.expires = value
      expect(verifyAnswer(a, deps, opts)).toEqual({ valid: false, reason: 'expired' })
    })
  }

  it('a genuine future timestamp still verifies', () => {
    const verdict = verifyAnswer(vector, deps, { ...opts, nowSeconds: vector.expires - 1 })
    expect((verdict as any).reason).not.toBe('expired')
  })
})

describe('verify / answer binding', () => {
  const fresh = { resolverPubKey: vector.signer, nowSeconds: 0 }

  it('rejects a signed answer for a DIFFERENT name', () => {
    expect(verifyAnswer(vector, deps, { ...fresh, expectName: 'victim.web3' }))
      .toEqual({ valid: false, reason: 'name_mismatch' })
  })
  it('catches the substitution before the signature is even consulted', () => {
    const verdict = verifyAnswer(vector, deps, { ...fresh, expectName: 'victim.web3' })
    expect(verdict.valid).toBe(false)
    expect((verdict as any).reason).not.toBe('bad_signature')
  })
  it('fails closed when no question is stated', () => {
    expect(verifyAnswer(vector, deps, { ...fresh, expectName: '' }))
      .toEqual({ valid: false, reason: 'no_expected_name' })
  })
  it('fails closed on an unparseable question', () => {
    expect(verifyAnswer(vector, deps, { ...fresh, expectName: 'not-an-address' }))
      .toEqual({ valid: false, reason: 'no_expected_name' })
  })
  it('normalizes the question before comparing (STD-001 §2)', () => {
    const verdict = verifyAnswer(vector, deps, { ...fresh, expectName: 'sns:Alexander@ORDNET.web3' })
    expect((verdict as any).reason).not.toBe('name_mismatch')
  })
  it('refuses an ok:false body before reading anything else', () => {
    expect(verifyAnswer({ ...vector, ok: false } as any, deps, { ...fresh, expectName: ASK }))
      .toEqual({ valid: false, reason: 'not_ok' })
  })
  it('refuses a body with no ok field at all', () => {
    expect(verifyAnswer({ ...vector, ok: undefined } as any, deps, { ...fresh, expectName: ASK }))
      .toEqual({ valid: false, reason: 'not_ok' })
  })
  it('refuses null without throwing', () => {
    expect(verifyAnswer(null as any, deps, { ...fresh, expectName: ASK }))
      .toEqual({ valid: false, reason: 'malformed' })
  })
  it('allows a domain-holder answer to a mailbox question when fallback is declared', () => {
    const verdict = verifyAnswer(vector, deps, { ...fresh, expectName: ASK })
    expect((verdict as any).reason).not.toBe('mailbox_mismatch')
  })
  it('rejects a different mailbox when fallback is NOT declared', () => {
    expect(verifyAnswer({ ...vector, mailbox: 'someone-else', fallback: false }, deps, { ...fresh, expectName: ASK }))
      .toEqual({ valid: false, reason: 'mailbox_mismatch' })
  })
  it('rejects a mailbox answer to a bare-domain question', () => {
    expect(verifyAnswer(vector, deps, { ...fresh, expectName: 'ordnet.web3' }))
      .toEqual({ valid: false, reason: 'mailbox_mismatch' })
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
  // The gate is an ALLOWLIST. It was a denylist of 32 entries, which is no
  // defence at all against ~1500 delegated gTLDs: a hostile /health could add
  // `bank`, `shop`, `online`, `email` or `be` and the address bar would
  // intercept real web2 domains — permanently, since the pollution survived a
  // refresh. A resolver can now only CONFIRM what this build already ships.

  it('refuses web2 TLDs and junk shapes from a hostile /health', async () => {
    const { refreshTlds, isKnownTld } = await import('../tlds')
    const hostile = async () => ({ ok: true, json: async () => ({ tlds: ['com', 'ORG', 'x', 'evil$'], retired_tlds: [] }) }) as any
    await refreshTlds('https://x', 0, hostile as any)
    expect(isKnownTld('com')).toBe(false)
    expect(isKnownTld('org')).toBe(false)
    expect(isKnownTld('web3')).toBe(true)
  })

  it('refuses the regulated and popular gTLDs a denylist of 32 would have missed', async () => {
    const { refreshTlds, isKnownTld } = await import('../tlds')
    // Every one of these was accepted before, and .bank is a strictly
    // regulated gTLD — intercepting it is the exact harm this file exists
    // to prevent.
    const targets = ['bank', 'shop', 'online', 'email', 'be', 'insurance', 'pharmacy', 'law', 'health', 'finance']
    const hostile = async () => ({ ok: true, json: async () => ({ tlds: targets, retired_tlds: [] }) }) as any
    await refreshTlds('https://x', 0, hostile as any)
    for (const t of targets) expect(isKnownTld(t)).toBe(false)
  })

  it('a resolver cannot invent a new web3 TLD either', async () => {
    const { refreshTlds, isKnownTld } = await import('../tlds')
    // Shape-valid and not a web2 name, so the old filter let it through.
    // Adding a genuine TLD now requires a release of this module.
    const hostile = async () => ({ ok: true, json: async () => ({ tlds: ['sats', 'metanet'], retired_tlds: [] }) }) as any
    await refreshTlds('https://x', 0, hostile as any)
    expect(isKnownTld('sats')).toBe(false)
    expect(isKnownTld('metanet')).toBe(false)
  })

  it('a refresh can never remove a shipped TLD', async () => {
    const { refreshTlds, isKnownTld, SNAPSHOT_TLDS } = await import('../tlds')
    const empty = async () => ({ ok: true, json: async () => ({ tlds: [], retired_tlds: [] }) }) as any
    await refreshTlds('https://x', 0, empty as any)
    for (const t of SNAPSHOT_TLDS) expect(isKnownTld(t)).toBe(true)
  })

  it('confirms shipped TLDs that the resolver does report', async () => {
    const { refreshTlds, isKnownTld } = await import('../tlds')
    const good = async () => ({ ok: true, json: async () => ({ tlds: ['web3', 'ordnet'], retired_tlds: ['bsv'] }) }) as any
    await refreshTlds('https://x', 0, good as any)
    expect(isKnownTld('web3')).toBe(true)
    expect(isKnownTld('bsv')).toBe(true)
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
