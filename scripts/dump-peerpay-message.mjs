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
 *   CHECK_ROOTS  set to 1 to also validate merkle roots against the SDK's
 *                default chain tracker (WhatsOnChain)
 *   CHAINTRACKS_URL
 *                set to the chaintracks service the APP uses to reproduce the
 *                app's own verification — this is the half of the check that
 *                the default chain tracker does NOT exercise. Defaults per
 *                NETWORK to the same table as services/walletServiceConfig.ts
 *                (chaintracksUrlFor). Set CHECK_APP_CHAINTRACKS=1 to run it.
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
const CHECK_APP_CT = process.env.CHECK_APP_CHAINTRACKS === '1'
// Mirrors services/walletServiceConfig.ts chaintracksUrlFor().
const CHAINTRACKS_URL =
  process.env.CHAINTRACKS_URL ??
  (NETWORK === 'testnet'
    ? 'https://arcade-v2-testnet-us-1.bsvblockchain.tech/chaintracks/v1'
    : 'https://arcade-v2-us-1.bsvblockchain.tech/chaintracks/v1')
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
  const strict = beef.verifyValid(false)
  out.verifyValidStrict = strict.valid
  out.roots = strict.roots
  out.verifyValidLenient = beef.verifyValid(true).valid
  out.beef = beef

  if (CHECK_ROOTS) {
    try {
      out.verifyWithChainTracker = await beef.verify(defaultChainTracker(), false)
    } catch (e) {
      out.verifyWithChainTracker = `threw: ${e.message}`
    }
  }
  return out
}

/**
 * The app does NOT verify BEEF against WhatsOnChain. WalletContext installs
 * OfflineFirstChaintracks over a ChaintracksServiceClient (see
 * services/walletServiceConfig.ts installOfflineChainTracker), so
 * `Beef.verify` asks THAT service for the merkle root at each bump height. A
 * beef that WhatsOnChain confirms is still rejected if this service answers
 * differently, is behind, or 404s the height — and the toolbox reports that
 * as the very same 'valid AtomicBEEF' string.
 *
 * This replicates its network branch exactly: findHeaderForHeight →
 * GET /findHeaderHexForHeight?height=N, then compare `.merkleRoot`.
 */
async function appChaintracksRootFor (height) {
  const url = `${CHAINTRACKS_URL}/findHeaderHexForHeight?height=${height}`
  const res = await fetch(url)
  if (!res.ok) return { error: `HTTP ${res.status} ${res.statusText}` }
  const v = await res.json()
  if (v.status !== 'success') return { error: `status=${v.status} code=${v.code ?? ''} ${JSON.stringify(v).slice(0, 200)}` }
  const header = v.value
  if (header == null) return { error: 'service returned success with no header (height beyond its tip?)' }
  const raw = header.merkleRoot
  const root = typeof raw === 'string' ? raw : raw == null ? undefined : Utils.toHex(Array.from(raw))
  return { root, height: header.height, hash: header.hash }
}

async function checkAppChaintracks (beef) {
  const { roots } = beef.verifyValid(false)
  const heights = Object.keys(roots)
  if (heights.length === 0) {
    console.log('  (no bumps — nothing for the chain tracker to answer)')
    return
  }
  for (const h of heights) {
    const expected = roots[h]
    let got
    try {
      got = await appChaintracksRootFor(Number(h))
    } catch (e) {
      got = { error: e.message }
    }
    console.log(`  height ${h}`)
    console.log(`    bump root      : ${expected}`)
    if (got.error) {
      console.log(`    chaintracks    : LOOKUP FAILED — ${got.error}`)
      console.log('    => OfflineFirstChaintracks catches this and returns false,')
      console.log('       which Beef.verify reports as "not proven". THIS is the failure.')
    } else if (got.root === expected) {
      console.log(`    chaintracks    : ${got.root}  ✓ agrees`)
    } else {
      console.log(`    chaintracks    : ${got.root ?? '(header had no merkleRoot field)'}  ✗ DISAGREES`)
      console.log('    => Beef.verify returns false and the toolbox throws')
      console.log('       "The tx parameter must be valid AtomicBEEF".')
    }
  }
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
  console.log(`bumps        : ${d.bumps}${d.roots ? ` (heights ${Object.keys(d.roots).join(', ')})` : ''}`)
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
  if ('verifyWithChainTracker' in d) console.log(`verify(defaultChainTracker, false): ${d.verifyWithChainTracker}   <- WhatsOnChain, NOT what the app uses`)
  if (CHECK_APP_CT) {
    hr()
    console.log(`app chain tracker (${CHAINTRACKS_URL}):`)
    await checkAppChaintracks(d.beef)
  }
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
    console.log('VERDICT: this beef is structurally valid — the container is right and the')
    console.log('         ancestry is complete. The bytes in the message box are NOT the')
    console.log('         problem, so the rejection has to come from the other half of the')
    console.log('         same if(): the chain-tracker call inside Beef.verify.')
    if (!CHECK_APP_CT) {
      console.log('         Re-run with CHECK_APP_CHAINTRACKS=1 to ask the chaintracks service')
      console.log('         the app actually uses whether it agrees about these merkle roots.')
    }
  }

  const stem = join(OUT, d.atomicTxid ?? msg.messageId)
  writeFileSync(`${stem}.atomicbeef.hex`, Utils.toHex(txBytes))
  writeFileSync(`${stem}.token.json`, JSON.stringify(token, null, 2))
  writeFileSync(`${stem}.report.json`, JSON.stringify({ messageId: msg.messageId, sender: msg.sender, created_at: msg.created_at, ...d, beef: undefined }, null, 2))
  console.log(`\nwrote ${stem}.{atomicbeef.hex,token.json,report.json}`)
}

hr('═')
console.log(WANT_TXID ? `${n} message(s) matched TXID=${WANT_TXID}` : `${n} payment token(s) dumped into ${OUT}/`)
console.log('Nothing was acknowledged or internalized — the messages are still in the box.')
