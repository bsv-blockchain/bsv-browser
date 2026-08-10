/**
 * React-Native glue: turn a classified web3 address into a tab URL.
 * Pure helpers live in render.ts; this file binds them to the app's
 * crypto (@bsv/sdk adapter) and chain-data source.
 */

import { DEFAULT_CONFIG } from './types'
import { resolveName } from './resolve'
import { verifyAnswer } from './verify'
import { fetchVerifiedContent } from './ordContent'
import { bsvSdkCryptoDeps } from './adapters'
import { bytesToBase64, htmlToDataUri, web3ErrorPage, web3TooLargePage, esc, MAX_INLINE_BYTES } from './render'
import { wocSpentSource } from './liveness'

/** Default tx source over WhatsOnChain — the chain-data provider this app already uses. */
export const wocTxSource = async (txid: string): Promise<string> => {
  const res = await fetch(`https://api.whatsonchain.com/v1/bsv/main/tx/${txid}/hex`)
  if (!res.ok) throw new Error(`tx source http ${res.status}`)
  return (await res.text()).trim()
}

/**
 * Resolve + verify + fetch a name's on-chain site, returning the tab URL.
 * Always returns a renderable url; errors become honest inline pages.
 */
export async function buildWeb3TabUrl (address: string, name: string): Promise<string> {
  try {
    const deps = bsvSdkCryptoDeps()
    const answer = await resolveName(DEFAULT_CONFIG.resolverUrl, address)
    if (!answer.ok) {
      const reason =
        answer.error === 'not_registered'
          ? 'This name is not registered on-chain.'
          : `The resolver answered: ${answer.error}.`
      return web3ErrorPage(name, reason)
    }
    const verdict = verifyAnswer(answer, deps, { resolverPubKey: DEFAULT_CONFIG.resolverPubKey })
    if (!verdict.valid) {
      return web3ErrorPage(name, `Answer failed local verification (${verdict.reason}) — refusing to render.`)
    }
    // Liveness (STD-001 level 3): the holder outpoint must still be unspent.
    // 'unknown' (spent-source unreachable) proceeds on the signed, short-lived
    // answer rather than blocking the user on a third-party outage.
    const liveness = await wocSpentSource(answer.current)
    if (liveness === 'spent') {
      return web3ErrorPage(name, 'The holder outpoint was just spent — ownership is changing hands. Try again in a moment.')
    }
    const content = await fetchVerifiedContent(answer.current, wocTxSource, deps)
    if (!content) {
      return web3ErrorPage(name, 'The name is registered and verified, but carries no on-chain site yet.')
    }
    if (content.body.length > MAX_INLINE_BYTES) {
      return web3TooLargePage(name, content.body.length)
    }
    const ct = content.contentType.split(';')[0].trim().toLowerCase()
    if (ct === 'text/html') return `data:text/html;base64,${bytesToBase64(content.body)}`
    if (ct.startsWith('image/')) {
      return htmlToDataUri(
        `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">` +
          `<body style="margin:0;background:#111;display:flex;min-height:100vh;align-items:center;justify-content:center">` +
          `<img style="max-width:100%;max-height:100vh" src="data:${esc(ct)};base64,${bytesToBase64(content.body)}">`
      )
    }
    const text = new TextDecoder().decode(content.body)
    return htmlToDataUri(
      `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<body style="font-family:ui-monospace,monospace;background:#fafaf7;color:#16181a;padding:20px">` +
        `<pre style="white-space:pre-wrap;word-break:break-word">${esc(text)}</pre>`
    )
  } catch (e) {
    return web3ErrorPage(name, `Could not load the on-chain site: ${e instanceof Error ? e.message : 'unknown error'}.`)
  }
}
