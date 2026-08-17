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
 * Funds needed: roughly 392,000 satoshis — 200,000 for the vault output,
 * plus fees for two ~960 KB transactions at 100 sat/kb: 2 × 960,000 bytes ×
 * (100 sat / 1000 bytes) ≈ 192,000. 200,000 + 192,000 ≈ 392,000.
 */
import { ARC, Hash, P2PKH, PrivateKey, Transaction, Utils } from '@bsv/sdk'
import { R1K1Wallet } from '@bsv/templates'
import { p256 } from '@noble/curves/nist.js'
import { R1K1_LOCK_LEN, R1K1_R1_UNLOCK_LEN, buildVaultLockingScript } from '../services/vault/r1k1'

const [, , wif, arcUrl, arcApiKey] = process.argv
if (!wif || !arcUrl) {
  console.error('usage: npx tsx scripts/r1k1-spend-proof.ts <fundingWIF> <arcUrl> [arcApiKey]')
  process.exit(1)
}

const VAULT_SATS = 200_000

/** Domain-separation string for the deterministic K1 recovery key — see
 * `deriveK1FromFunding` below. Never change this without also updating any
 * output this script has already created; doing so silently orphans the K1
 * recovery path for it. */
const K1_DERIVATION_DOMAIN = 'bsv-vault/r1k1-spend-proof/k1-recovery/v1'

/**
 * Derive the K1 recovery key deterministically from the funding key, instead
 * of generating and discarding a random one. `unlockR1` is the only branch
 * this proof exercises, but the output it creates is real and, should the R1
 * branch fail for a reason OTHER than the expected unraised-policy one (which
 * busts the locking script itself and would fail K1 too), K1 is the
 * documented fallback for recovering those funds. A random, unprinted key
 * would foreclose that fallback. Recipe: sha256(domain ‖ fundingPrivateKeyBytes).
 * Recoverable by re-running this function with the same funding WIF — never
 * written to disk, never logged.
 */
function deriveK1FromFunding(funding: PrivateKey): PrivateKey {
  const material = Hash.sha256([...Utils.toArray(K1_DERIVATION_DOMAIN, 'utf8'), ...funding.toArray('be', 32)])
  return new PrivateKey(material)
}

async function main(): Promise<void> {
  const funding = PrivateKey.fromWif(wif)
  const fundingPkh = Hash.hash160(funding.toPublicKey().encode(true) as number[])
  const fundingLockingScript = new P2PKH().lock(fundingPkh)
  const broadcaster = new ARC(arcUrl, arcApiKey ? { apiKey: arcApiKey } : {})

  const r1priv = p256.utils.randomSecretKey()
  const r1PublicKey = Utils.toHex(Array.from(p256.getPublicKey(r1priv, true)))
  const salt = Utils.toHex(Array.from(crypto.getRandomValues(new Uint8Array(32))))
  const k1 = deriveK1FromFunding(funding)
  const k1PublicKeyHash = Hash.hash160(k1.toPublicKey().encode(true) as number[])
  console.log('K1 recovery key: deterministic, sha256("' + K1_DERIVATION_DOMAIN + '" || fundingPrivateKeyBytes).')
  console.log('  Not printed. Recoverable by re-running this tool with the same funding WIF.')

  const lockingScript = await buildVaultLockingScript({ r1PublicKey, salt, k1PublicKeyHash })
  const lockLen = lockingScript.toUint8Array().length
  console.log('locking script bytes:', lockLen, lockLen === R1K1_LOCK_LEN ? '(matches R1K1_LOCK_LEN)' : '(MISMATCH)')
  if (lockLen !== R1K1_LOCK_LEN) {
    throw new Error(
      `locking script is ${lockLen} bytes, expected R1K1_LOCK_LEN=${R1K1_LOCK_LEN} — template drift; aborting before any funds move`
    )
  }

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

  // `.fee()` requires every input to carry a `sourceTransaction` object — it
  // reads `input.sourceTransaction.outputs[input.sourceOutputIndex].satoshis`
  // directly in `calculateChange`, independent of the `sourceSatoshis` passed
  // to `.unlock()` below (that only feeds `.sign()`'s own resolution). Build a
  // stand-in transaction holding just the one output being spent — the same
  // shape `Transaction.fromEF` constructs for a source supplied out of band.
  // `sourceTXID` is set explicitly to the real chain txid below and takes
  // priority over this stand-in's own (unrelated) id, so the real prevout
  // reference is what actually gets serialized and signed.
  const fundingSourceTx = new Transaction()
  for (let i = 0; i < Number(fVout); i++) {
    fundingSourceTx.addOutput({ satoshis: 0, lockingScript: fundingLockingScript })
  }
  fundingSourceTx.addOutput({ satoshis: Number(fSats), lockingScript: fundingLockingScript })

  const deposit = new Transaction()
  deposit.addInput({
    sourceTXID: fTxid,
    sourceTransaction: fundingSourceTx,
    sourceOutputIndex: Number(fVout),
    unlockingScriptTemplate: new P2PKH().unlock(funding, 'all', false, Number(fSats), fundingLockingScript),
    sequence: 0xffffffff
  })
  deposit.addOutput({ satoshis: VAULT_SATS, lockingScript })
  deposit.addOutput({ lockingScript: fundingLockingScript, change: true })
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
  r1Spend.addOutput({ lockingScript: fundingLockingScript, change: true })
  await r1Spend.fee()
  await r1Spend.sign()

  console.log('\nR1 spend tx bytes:', r1Spend.toBinary().length, '| EF bytes:', r1Spend.toEF().length)
  const r1UnlockLen = r1Spend.inputs[0].unlockingScript!.toBinary().length
  console.log(
    'R1 unlocking script bytes:',
    r1UnlockLen,
    r1UnlockLen === R1K1_R1_UNLOCK_LEN ? '(matches R1K1_R1_UNLOCK_LEN)' : '(MISMATCH)'
  )
  if (r1UnlockLen !== R1K1_R1_UNLOCK_LEN) {
    throw new Error(
      `R1 unlocking script is ${r1UnlockLen} bytes, expected R1K1_R1_UNLOCK_LEN=${R1K1_R1_UNLOCK_LEN} — template drift`
    )
  }
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
