#!/usr/bin/env node
/**
 * Pull a PeerPay payment token straight out of a MessageBox and dissect the
 * AtomicBEEF inside it.
 *
 * Why this exists: the toolbox throws `WERR_INVALID_PARAMETER('tx', 'valid
 * AtomicBEEF')` for TWO unrelated reasons — a wrong container, or a BEEF whose
 * ancestry cannot be proven. It is the same string either way, so the error
 * alone cannot tell you which. This script runs the exact check the toolbox
 * runs -- Beef.verify(chainTracker, allowTxidOnly=false) -- see
 * @bsv/wallet-toolbox-mobile/out/src/signer/methods/internalizeAction.js:92)
 * and prints which half failed, and for the ancestry case, which txids.
 *
 * READ-ONLY. It never acknowledges a message and never internalizes anything:
 * listMessages is called with `acceptPayments: false`, which is what stops the
 * client from auto-internalizing (and therefore from reproducing the failure
 * and consuming the message before you have looked at it).
 *
 * Usage, from the repo root (deps resolve out of the repo's node_modules):
 *
 *   MNEMONIC="word word word ... word" node scripts/dump-peerpay-message.mjs
 *
 * Env:
 *   MNEMONIC     required, the 12 words
 *   PASSPHRASE   optional BIP39 passphrase (default '')
 *   MB_HOST      message box host (default https://gmb.bsvblockchain.tech)
 *   BOX          message box name (default payment_inbox)
 *   TXID         optional, only dump the message whose subject txid matches
 *   NETWORK      mainnet | testnet (default mainnet)
 *   CHECK_ROOTS  set to 1 to also validate merkle roots against a chain
 *                tracker (needs network access to WhatsOnChain)
 *   OUT          output directory (default ./peerpay-dump)
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Beef, HD, Mnemonic, ProtoWallet, Utils, defaultChainTracker } from '@bsv/sdk'
import { MessageBoxClient } from '@bsv/message-box-client'

const MNEMONIC = process.env.MNEMONIC
const PASSPHRASE = process.env.PASSPHRASE ?? ''
const MB_HOST = process.env.MB_HOST ?? 'https://gmb.bsvblockchain.tech'
const BOX = process.env.BOX ?? 'payment_inbox'
const WANT_TXID = process.env.TXID?.toLowerCase()
const NETWORK = process.env.NETWORK === 'testnet' ? 'testnet' : 'mainnet'
const CHECK_ROOTS = process.env.CHECK_ROOTS === '1'
const OUT = process.env.OUT ?? 'peerpay-dump'

if (!MNEMONIC) {
  console.error('MNEMONIC is required, e.g.\n  MNEMONIC="abandon ... about" node scripts/dump-peerpay-message.mjs')
  process.exit(1)
}

const hr = (c = '─') => console.log(c.repeat(78))

// Same derivation the app uses — utils/mnemonicWallet.ts: BIP39 seed, then the
// hardened path m/0'/0'. That key IS the wallet's identity key, so the message
// box authenticates us as the same party the app is.
const seed = Mnemonic.fromString(MNEMONIC.trim().replace(/\s+/g, ' ')).toSeed(PASSPHRASE)
const privKey = HD.fromSeed(seed).derive("m/0'/0'").privKey
const identityKey = privKey.toPublicKey().toString()

console.log(`identity key : ${identityKey}`)
console.log(`host         : ${MB_HOST}`)
console.log(`message box  : ${BOX}  (network ${NETWORK})`)

const client = new MessageBoxClient({
  host: MB_HOST,
  walletClient: new ProtoWallet(privKey),
  networkPreset: NETWORK,
  enableLogging: process.env.DEBUG === '1'
})

// acceptPayments:false is load-bearing — the default (true) makes the client
// internalize every payment it sees, which is the call that is failing.
const messages = await client.listMessages({ messageBox: BOX, host: MB_HOST, acceptPayments: false })
console.log(`messages     : ${messages.length}`)

mkdirSync(OUT, { recursive: true })

/** The toolbox's own two-part check, reported as two separate answers. */
async function dissect(txBytes) {
  const out = { }
  const head = txBytes.slice(0, 4)
  out.prefix = head.map(b => b.toString(16).padStart(2, '0')).join('')
  out.container =
    out.prefix === '01010101' ? 'AtomicBEEF (BRC-95)'
    : out.prefix === '0100beef' ? 'BEEF V1  — NOT atomic'
    : out.prefix === '0200beef' ? 'BEEF V2  — NOT atomic'
    : 'unrecognised'

  let beef
  try {
    beef = Beef.fromBinary(txBytes)
  } catch (e) {
    out.parseError = e.message
    return out
  }

  out.atomicTxid = beef.atomicTxid ?? null
  out.bumps = beef.bumps.length
  out.txs = beef.txs.map(t => ({
    txid: t.txid,
    txidOnly: t.isTxidOnly,
    hasProof: t.hasProof,
    rawBytes: t.rawTx?.length ?? 0,
    inputs: t.inputTxids
  }))

  const sorted = beef.sortTxs()
  out.sort = {
    valid: sorted.valid.length,
    txidOnly: sorted.txidOnly,
    missingInputs: sorted.missingInputs,
    withMissingInputs: sorted.withMissingInputs,
    notValid: sorted.notValid
  }

  // allowTxidOnly false is exactly what internalizeAction passes.
  out.verifyValidStrict = beef.verifyValid(false).valid
  out.verifyValidLenient = beef.verifyValid(true).valid

  if (CHECK_ROOTS) {
    try {
      out.verifyWithChainTracker = await beef.verify(defaultChainTracker(), false)
    } catch (e) {
      out.verifyWithChainTracker = `threw: ${e.message}`
    }
  }
  return out
}

let n = 0
for (const msg of messages) {
  const body = typeof msg.body === 'string' ? msg.body : JSON.stringify(msg.body)
  let token
  try {
    token = JSON.parse(body)
  } catch {
    console.log(`\n[${msg.messageId}] body is not JSON, skipping (${body.slice(0, 80)})`)
    continue
  }

  const txBytes = Array.isArray(token.transaction) ? token.transaction : null
  if (!txBytes) {
    console.log(`\n[${msg.messageId}] token has no numeric transaction array, skipping`)
    continue
  }

  const d = await dissect(txBytes)
  if (WANT_TXID && d.atomicTxid?.toLowerCase() !== WANT_TXID) continue
  n++

  hr('═')
  console.log(`messageId    : ${msg.messageId}`)
  console.log(`sender       : ${msg.sender}`)
  console.log(`created_at   : ${msg.created_at}`)
  console.log(`amount       : ${token.amount}`)
  console.log(`outputIndex  : ${token.outputIndex ?? 0}`)
  console.log(`derivation   : prefix=${token.customInstructions?.derivationPrefix} suffix=${token.customInstructions?.derivationSuffix}`)
  if (token.note) console.log(`note         : ${JSON.stringify(token.note)}`)
  hr()
  console.log(`container    : ${d.container}  (prefix 0x${d.prefix}, ${txBytes.length} bytes)`)
  if (d.parseError) {
    console.log(`PARSE FAILED : ${d.parseError}`)
    continue
  }
  console.log(`atomicTxid   : ${d.atomicTxid ?? '(none — this is why it is rejected)'}`)
  console.log(`bumps        : ${d.bumps}`)
  console.log(`transactions : ${d.txs.length}`)
  for (const t of d.txs) {
    const flags = [t.hasProof ? 'PROOF' : null, t.txidOnly ? 'TXID-ONLY' : null].filter(Boolean).join(' ') || 'raw'
    console.log(`  ${t.txid}  ${flags.padEnd(10)} ${String(t.rawBytes).padStart(7)}B  inputs:${t.inputs.length}`)
  }
  hr()
  console.log(`sortTxs      : valid=${d.sort.valid} txidOnly=${d.sort.txidOnly.length} missingInputs=${d.sort.missingInputs.length} withMissingInputs=${d.sort.withMissingInputs.length} notValid=${d.sort.notValid.length}`)
  for (const [label, list] of Object.entries(d.sort)) {
    if (Array.isArray(list) && list.length) console.log(`  ${label}: ${list.join('\n' + ' '.repeat(label.length + 4))}`)
  }
  console.log(`verifyValid(allowTxidOnly=false) : ${d.verifyValidStrict}   <- the check internalizeAction runs`)
  console.log(`verifyValid(allowTxidOnly=true)  : ${d.verifyValidLenient}`)
  if ('verifyWithChainTracker' in d) console.log(`verify(chainTracker, false)      : ${d.verifyWithChainTracker}`)
  hr()

  // The verdict, spelled out.
  if (!d.atomicTxid) {
    console.log('VERDICT: wrong container. The sender put plain BEEF where AtomicBEEF')
    console.log('         belongs, so `ab.atomicTxid` is undefined and the toolbox throws.')
  } else if (!d.verifyValidStrict && d.verifyValidLenient) {
    console.log('VERDICT: the container is a correct AtomicBEEF. It is rejected because the')
    console.log('         BEEF carries txid-only ancestors — internalizeAction passes')
    console.log('         allowTxidOnly=false, so those count as unproven. The txids listed')
    console.log('         under txidOnly above are the ones the sender did not ship in full.')
  } else if (!d.verifyValidStrict) {
    console.log('VERDICT: the container is a correct AtomicBEEF, but the ancestry is')
    console.log('         incomplete — see missingInputs / withMissingInputs / notValid above.')
    console.log('         Those transactions have neither a merkle proof nor a parent in the beef.')
  } else {
    console.log('VERDICT: this beef is structurally valid. If internalizeAction still rejects')
    console.log('         it, the failure is at the chain-tracker step — re-run with')
    console.log('         CHECK_ROOTS=1 to validate the merkle roots against WhatsOnChain.')
  }

  const stem = join(OUT, d.atomicTxid ?? msg.messageId)
  writeFileSync(`${stem}.atomicbeef.hex`, Utils.toHex(txBytes))
  writeFileSync(`${stem}.token.json`, JSON.stringify(token, null, 2))
  writeFileSync(`${stem}.report.json`, JSON.stringify({ messageId: msg.messageId, sender: msg.sender, created_at: msg.created_at, ...d }, null, 2))
  console.log(`\nwrote ${stem}.{atomicbeef.hex,token.json,report.json}`)
}

hr('═')
console.log(WANT_TXID ? `${n} message(s) matched TXID=${WANT_TXID}` : `${n} payment token(s) dumped into ${OUT}/`)
console.log('Nothing was acknowledged or internalized — the messages are still in the box.')
