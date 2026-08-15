/**
 * Standalone proof that an R1-K1 output can be created AND spent on a live
 * network. Run before enabling the vault deposit path — see §0 of
 * docs/superpowers/specs/2026-08-15-r1k1-vault-design.md.
 *
 * Deliberately depends on nothing from the app: no wallet, no toolbox, no
 * native module. A software P-256 key stands in for the YubiKey, because what
 * is under test is the SCRIPT's acceptance by the network, not the hardware.
 *
 * Usage:
 *   npx tsx scripts/r1k1-spend-proof.ts <fundingWIF> <arcUrl> [arcApiKey]
 *
 * Funds needed: roughly 300,000 satoshis at 100 sat/kb (two ~960 KB
 * transactions plus the 200,000 the output carries).
 */
import { ARC, Hash, P2PKH, PrivateKey, Transaction, Utils } from '@bsv/sdk'
import { R1K1Wallet } from '@bsv/templates'
import { p256 } from '@noble/curves/nist.js'
import { buildVaultLockingScript } from '../services/vault/r1k1'

const [, , wif, arcUrl, arcApiKey] = process.argv
if (!wif || !arcUrl) {
  console.error('usage: npx tsx scripts/r1k1-spend-proof.ts <fundingWIF> <arcUrl> [arcApiKey]')
  process.exit(1)
}

const VAULT_SATS = 200_000

async function main(): Promise<void> {
  const funding = PrivateKey.fromWif(wif)
  const fundingPkh = Hash.hash160(funding.toPublicKey().encode(true) as number[])
  const broadcaster = new ARC(arcUrl, arcApiKey ? { apiKey: arcApiKey } : {})

  const r1priv = p256.utils.randomSecretKey()
  const r1PublicKey = Utils.toHex(Array.from(p256.getPublicKey(r1priv, true)))
  const salt = Utils.toHex(Array.from(crypto.getRandomValues(new Uint8Array(32))))
  const k1 = PrivateKey.fromRandom()
  const k1PublicKeyHash = Hash.hash160(k1.toPublicKey().encode(true) as number[])

  const lockingScript = await buildVaultLockingScript({ r1PublicKey, salt, k1PublicKeyHash })
  console.log('locking script bytes:', lockingScript.toUint8Array().length)

  // ── 1. create the vault output ────────────────────────────────────────
  //
  // Supply the funding UTXO by hand: sourceTXID / sourceOutputIndex / satoshis
  // of a P2PKH output the WIF controls. Print-and-halt so the operator can
  // paste real values rather than have the script guess at UTXO discovery.
  console.log('\nFund this address, then set FUNDING_UTXO below and re-run:')
  console.log('  address:', funding.toAddress())
  const FUNDING_UTXO = process.env.FUNDING_UTXO // 'txid:vout:satoshis'
  if (!FUNDING_UTXO) {
    console.error('\nSet FUNDING_UTXO=<txid>:<vout>:<satoshis> and re-run.')
    process.exit(1)
  }
  const [fTxid, fVout, fSats] = FUNDING_UTXO.split(':')

  const deposit = new Transaction()
  deposit.addInput({
    sourceTXID: fTxid,
    sourceOutputIndex: Number(fVout),
    unlockingScriptTemplate: new P2PKH().unlock(funding, 'all', false, Number(fSats), new P2PKH().lock(fundingPkh)),
    sequence: 0xffffffff
  })
  deposit.addOutput({ satoshis: VAULT_SATS, lockingScript })
  deposit.addOutput({ lockingScript: new P2PKH().lock(fundingPkh), change: true })
  await deposit.fee()
  await deposit.sign()

  console.log('\ndeposit tx bytes:', deposit.toBinary().length, '| EF bytes:', deposit.toEF().length)
  const depositResult = await deposit.broadcast(broadcaster)
  console.log('deposit broadcast:', JSON.stringify(depositResult))
  const depositTxid = deposit.id('hex')

  // ── 2. spend it via R1 ────────────────────────────────────────────────
  const r1Spend = new Transaction()
  r1Spend.addInput({
    sourceTransaction: deposit,
    sourceOutputIndex: 0,
    unlockingScriptTemplate: new R1K1Wallet().unlockR1({
      publicKey: r1PublicKey,
      salt,
      signDigest: (digest: Uint8Array) =>
        Array.from(p256.Signature.fromBytes(p256.sign(digest, r1priv, { prehash: false })).toBytes('der'))
    }),
    sequence: 0xffffffff
  })
  r1Spend.addOutput({ lockingScript: new P2PKH().lock(fundingPkh), change: true })
  await r1Spend.fee()
  await r1Spend.sign()

  console.log('\nR1 spend tx bytes:', r1Spend.toBinary().length, '| EF bytes:', r1Spend.toEF().length)
  console.log('R1 unlocking script bytes:', r1Spend.inputs[0].unlockingScript!.toBinary().length)
  const r1Result = await r1Spend.broadcast(broadcaster)
  console.log('R1 broadcast:', JSON.stringify(r1Result))

  console.log('\n--- summary ---')
  console.log('deposit txid:', depositTxid)
  console.log('R1 spend txid:', r1Spend.id('hex'))
  console.log('\nIf the R1 spend was ACCEPTED, MaxScriptSizePolicy is raised and')
  console.log('MaxStackMemoryUsagePolicy has enough headroom. The vault is safe to enable.')
  console.log('If it was REJECTED with a "transaction size" error, that is really a')
  console.log('SCRIPT-size rejection (arcade errmap.go:60-66 matches "too big" first).')
}

main().catch(e => {
  console.error('spend proof FAILED:', e)
  process.exit(1)
})
