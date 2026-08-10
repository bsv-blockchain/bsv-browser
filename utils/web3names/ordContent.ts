/**
 * On-chain website content — the "web3sites" half.
 *
 * A name's content lives in the 1Sat ordinal inscription on its current
 * outpoint. The raw transaction can come from ANY source the app already
 * uses (WhatsOnChain is wired into this repo's env) because integrity is
 * content-addressed: double-SHA256 of the raw bytes must equal the txid
 * from the SIGNED resolver answer. A lying source cannot produce matching
 * bytes.
 */

import type { CryptoDeps, Outpoint, TxSource } from './types'
import { bytesToHex } from './verify'

export interface InscriptionContent {
  contentType: string
  body: Uint8Array
}

const hexToBytes = (hex: string): Uint8Array => {
  const clean = String(hex || '').toLowerCase()
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** txid = reversed double-SHA256 of the raw transaction bytes. */
export function txidOf (rawTx: Uint8Array, deps: CryptoDeps): string {
  return bytesToHex(deps.sha256(deps.sha256(rawTx)).slice().reverse())
}

interface Reader {
  buf: Uint8Array
  pos: number
}

const readVarint = (r: Reader): number => {
  const first = r.buf[r.pos++]
  if (first < 0xfd) return first
  if (first === 0xfd) {
    const v = r.buf[r.pos] | (r.buf[r.pos + 1] << 8)
    r.pos += 2
    return v
  }
  if (first === 0xfe) {
    const v = r.buf[r.pos] | (r.buf[r.pos + 1] << 8) | (r.buf[r.pos + 2] << 16) | (r.buf[r.pos + 3] * 0x1000000)
    r.pos += 4
    return v
  }
  let v = 0
  for (let i = 0; i < 8; i++) v += r.buf[r.pos + i] * 2 ** (8 * i)
  r.pos += 8
  return v
}

/** Extract the locking script of one output from a raw transaction. */
export function lockingScriptOf (rawTx: Uint8Array, vout: number): Uint8Array | null {
  const r: Reader = { buf: rawTx, pos: 4 }
  const nIn = readVarint(r)
  for (let i = 0; i < nIn; i++) {
    r.pos += 36
    const scriptLen = readVarint(r)
    r.pos += scriptLen + 4
  }
  const nOut = readVarint(r)
  if (vout >= nOut) return null
  for (let o = 0; o < nOut; o++) {
    r.pos += 8
    const len = readVarint(r)
    if (o === vout) return rawTx.slice(r.pos, r.pos + len)
    r.pos += len
  }
  return null
}

/**
 * Parse the first 1Sat ord envelope from a locking script:
 * OP_FALSE OP_IF "ord" OP_1 <content-type> OP_0 <body> OP_ENDIF
 */
export function parseOrdEnvelope (script: Uint8Array): InscriptionContent | null {
  const tokens: Array<{ op: number, data: Uint8Array | null }> = []
  let i = 0
  while (i < script.length) {
    const op = script[i++]
    if (op > 0 && op <= 75) {
      tokens.push({ op, data: script.slice(i, i + op) })
      i += op
    } else if (op === 76) {
      const len = script[i]
      tokens.push({ op, data: script.slice(i + 1, i + 1 + len) })
      i += 1 + len
    } else if (op === 77) {
      const len = script[i] | (script[i + 1] << 8)
      tokens.push({ op, data: script.slice(i + 2, i + 2 + len) })
      i += 2 + len
    } else if (op === 78) {
      const len = script[i] | (script[i + 1] << 8) | (script[i + 2] << 16) | (script[i + 3] * 0x1000000)
      tokens.push({ op, data: script.slice(i + 4, i + 4 + len) })
      i += 4 + len
    } else {
      tokens.push({ op, data: null })
    }
  }
  const dec = new TextDecoder()
  for (let t = 0; t + 1 < tokens.length; t++) {
    const isEnvelopeStart = tokens[t].op === 0 && tokens[t + 1].op === 99 // OP_FALSE OP_IF
    if (!isEnvelopeStart) continue
    const marker = tokens[t + 2]
    if (!marker || !marker.data || dec.decode(marker.data) !== 'ord') continue
    let contentType = ''
    let body: Uint8Array | null = null
    let k = t + 3
    while (k < tokens.length && tokens[k].op !== 104) { // OP_ENDIF
      if (tokens[k].op === 81 && tokens[k + 1] && tokens[k + 1].data) { // OP_1 <content-type>
        contentType = dec.decode(tokens[k + 1].data as Uint8Array)
        k += 2
        continue
      }
      if (tokens[k].op === 0 && tokens[k + 1] && tokens[k + 1].data) { // OP_0 <body pushes>
        // The body may span multiple consecutive data pushes — concatenate
        // every push until the next non-data token (typically OP_ENDIF).
        const parts: Uint8Array[] = []
        let j = k + 1
        while (j < tokens.length && tokens[j].data) {
          parts.push(tokens[j].data as Uint8Array)
          j++
        }
        const total = parts.reduce((n, p) => n + p.length, 0)
        const merged = new Uint8Array(total)
        let off = 0
        for (const p of parts) {
          merged.set(p, off)
          off += p.length
        }
        body = merged
        k = j
        continue
      }
      k++
    }
    if (body) return { contentType, body }
  }
  return null
}

/**
 * Fetch and verify the content behind an outpoint: raw tx from any source,
 * txid recomputed and matched, envelope parsed. Throws on integrity failure.
 */
export async function fetchVerifiedContent (outpoint: Outpoint, txSource: TxSource, deps: CryptoDeps): Promise<InscriptionContent | null> {
  const rawHex = await txSource(outpoint.txid)
  const raw = hexToBytes(rawHex)
  const computed = txidOf(raw, deps)
  if (computed !== outpoint.txid.toLowerCase()) {
    throw new Error(`tx integrity failure: source returned ${computed} for requested ${outpoint.txid}`)
  }
  const script = lockingScriptOf(raw, outpoint.vout)
  if (!script) return null
  return parseOrdEnvelope(script)
}
