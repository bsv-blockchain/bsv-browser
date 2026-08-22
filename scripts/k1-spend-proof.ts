/**
 * Standalone proof that a K1 vault output can be created AND spent.
 *
 * Successor to the deleted scripts/r1k1-spend-proof.ts (see
 * `git show 48d58d8~1:scripts/r1k1-spend-proof.ts` for the R1-K1 version this
 * replaces). Task 10 deleted the R1-K1 template and its ~960 KB compiled
 * script; the vault's only locking script now is a plain 25-byte P2PKH lock
 * (services/vault/k1.ts). There is no exotic policy edge left to probe —
 * MaxScriptSizePolicy was the entire reason the predecessor broadcast real
 * ~960 KB transactions to a live network, and a 25-byte script is nowhere
 * near any policy limit — so this script exists to catch REGRESSIONS: a
 * future change to k1.ts, to vaultDerivation.ts, or to how the two compose,
 * that produces a lock/unlock pair the network (or the local script
 * interpreter) would reject.
 *
 * Two independent modes:
 *
 *   Interpreter mode (default — no network, no funds, no env vars):
 *     npx tsx scripts/k1-spend-proof.ts
 *
 *   Broadcast mode (real TeraTestNet transactions — OFF unless asked for):
 *     VAULT_PROOF_MNEMONIC="<12-24 BIP39 words, teratest funds only>" \
 *       npx tsx scripts/k1-spend-proof.ts --broadcast
 *
 * VAULT_PROOF_MNEMONIC must come from the environment — this script never
 * generates, prints, or commits one — so no phrase, however worthless the
 * underlying test coins, ever lives in the repo. Interpreter mode needs no
 * such variable: it generates its own throwaway mnemonic fresh on every run,
 * uses it only to build a local, fabricated source transaction, and never
 * sends anything over the network.
 *
 * Interpreter mode mirrors the shape of __tests__/vault/k1.test.ts's
 * "verifies under the Spend interpreter" case, just as a runnable script
 * that prints PASS/FAIL and sets its exit code accordingly, instead of a
 * jest assertion.
 */
import { Hash, HD, Mnemonic, P2PKH, Spend, Transaction, Utils } from '@bsv/sdk'
import { toWalletChain } from '../context/config'
import { K1_LOCK_LEN, K1_UNLOCK_LEN, buildVaultLockingScript } from '../services/vault/k1'
import { deriveVaultHD, depositPrivKey } from '../services/vault/vaultDerivation'

const BROADCAST = process.argv.includes('--broadcast')

// ── interpreter mode ───────────────────────────────────────────────────────

/**
 * A fresh throwaway BIP39 mnemonic + passphrase, generated new on every run.
 * Never funded, never persisted, never printed in full, never the same twice
 * — this is what interpreter mode derives its vault HD from, so no phrase of
 * any kind needs to live in this file or in the repo.
 */
function throwawayMnemonicAndPassphrase(): { mnemonic: string; passphrase: string } {
  const mnemonic = Mnemonic.fromRandom(128).toString()
  const passphrase = Utils.toHex(Array.from(crypto.getRandomValues(new Uint8Array(16))))
  return { mnemonic, passphrase }
}

/**
 * Build a K1 vault output, spend it with a plain P2PKH unlock, and validate
 * that spend with @bsv/sdk's own Spend interpreter — entirely offline. No
 * real UTXO is needed: the "source transaction" is fabricated locally, the
 * same trick __tests__/vault/k1.test.ts uses.
 */
async function runInterpreterMode(): Promise<boolean> {
  const { mnemonic, passphrase } = throwawayMnemonicAndPassphrase()
  const vaultHD = deriveVaultHD(mnemonic, passphrase)
  const priv = depositPrivKey(vaultHD, 0)
  const pkh = Hash.hash160(priv.toPublicKey().encode(true) as number[])

  const lock = buildVaultLockingScript({ k1PublicKeyHash: pkh })
  const lockLen = lock.toBinary().length
  console.log('locking script bytes:', lockLen, lockLen === K1_LOCK_LEN ? '(matches K1_LOCK_LEN)' : '(MISMATCH)')

  const sourceTx = new Transaction(1, [], [{ lockingScript: lock, satoshis: 1000 }], 0)
  const tx = new Transaction(
    1,
    [
      {
        sourceTransaction: sourceTx,
        sourceOutputIndex: 0,
        sequence: 0xffffffff,
        unlockingScriptTemplate: new P2PKH().unlock(priv, 'all', false, 1000, lock)
      }
    ],
    [{ lockingScript: lock, satoshis: 900 }],
    0
  )
  await tx.sign()
  const unlock = tx.inputs[0].unlockingScript!
  const unlockLen = unlock.toBinary().length
  console.log(
    'unlocking script bytes:',
    unlockLen,
    unlockLen <= K1_UNLOCK_LEN ? `(within K1_UNLOCK_LEN=${K1_UNLOCK_LEN})` : `(EXCEEDS K1_UNLOCK_LEN=${K1_UNLOCK_LEN})`
  )

  const spend = new Spend({
    sourceTXID: sourceTx.id('hex'),
    sourceOutputIndex: 0,
    sourceSatoshis: 1000,
    lockingScript: lock,
    transactionVersion: 1,
    otherInputs: [],
    inputIndex: 0,
    unlockingScript: unlock,
    outputs: tx.outputs,
    inputSequence: 0xffffffff,
    lockTime: 0
  })
  const validated = spend.validate()
  console.log('Spend interpreter validate():', validated)

  return validated && lockLen === K1_LOCK_LEN && unlockLen <= K1_UNLOCK_LEN
}

// ── broadcast mode (teratestnet, opt-in) ───────────────────────────────────

/** TeraTestNet WhatsOnChain base — see project memory on the 'teratest' ->
 * 'ttn' mapping (context/config.tsx's toWalletChain) and
 * utils/pay/rails/address.ts's wocConfigFor, which this mirrors for a
 * chain this script always targets, so there is no chain parameter to plumb. */
const WOC_TERATEST_BASE = 'https://api.woc-ttn.bsvblockchain.tech/v1/bsv/test'

interface WocUnspent {
  tx_hash: string
  tx_pos: number
  value: number
}

async function wocFetchUnspent(address: string): Promise<WocUnspent[]> {
  const res = await fetch(`${WOC_TERATEST_BASE}/address/${address}/unspent`)
  if (!res.ok) throw new Error(`WoC unspent lookup failed: ${res.status} ${await res.text()}`)
  return res.json()
}

/** POST raw tx hex to WoC and return the broadcast txid. Same endpoint and
 * body shape as services/arcadeBroadcastProvider.ts's createWocBroadcastService. */
async function wocBroadcast(rawHex: string): Promise<string> {
  const res = await fetch(`${WOC_TERATEST_BASE}/tx/raw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txhex: rawHex })
  })
  const body = await res.text()
  if (!res.ok) throw new Error(`WoC broadcast failed: ${res.status} ${body}`)
  return body.replace(/^"|"$/g, '')
}

/**
 * Create a real K1 vault output on TeraTestNet, then spend it straight back
 * — deposit and withdrawal, each broadcast through WoC. Requires
 * VAULT_PROOF_MNEMONIC in the environment; refuses to run otherwise.
 */
async function runBroadcastMode(): Promise<boolean> {
  const mnemonic = process.env.VAULT_PROOF_MNEMONIC
  if (!mnemonic) {
    console.error(
      'VAULT_PROOF_MNEMONIC is required for --broadcast. Refusing to run without it, so no test phrase\n' +
        'ever needs to live in the repo. Set it to a throwaway BIP39 phrase funded with TeraTestNet coins\n' +
        '(worthless, faucet-obtainable) and re-run:\n\n' +
        '  VAULT_PROOF_MNEMONIC="..." npx tsx scripts/k1-spend-proof.ts --broadcast'
    )
    process.exit(1)
  }
  const passphrase = process.env.VAULT_PROOF_PASSPHRASE ?? 'k1-spend-proof-test-passphrase-not-secret'

  // Chain mapping this script always resolves to 'ttn' — spelled out via the
  // real helper (rather than hardcoded) so this stays correct if the mapping
  // ever changes.
  const walletChain = toWalletChain('teratest')
  console.log('broadcast mode targeting chain:', walletChain)

  const phrase = mnemonic.trim().replace(/\s+/g, ' ')

  // Funding key: the "main wallet" side of the same mnemonic (no passphrase)
  // — mirrors vaultDerivation.ts's own doc of `HD.fromSeed(seed(''))` as the
  // main wallet's node. Root key, no child derivation: simplest thing that
  // gives an address an operator can fund directly.
  const fundingHD = HD.fromSeed(Mnemonic.fromString(phrase).toSeed(''))
  const funding = fundingHD.privKey
  const fundingPkh = Hash.hash160(funding.toPublicKey().encode(true) as number[])
  const fundingLockingScript = new P2PKH().lock(fundingPkh)

  // Vault key: the real derivation path, same as production — deriveVaultHD
  // requires a non-empty passphrase, which is what keeps this node distinct
  // from the funding node above even though both come from the same phrase.
  const vaultHD = deriveVaultHD(phrase, passphrase)
  const vaultPriv = depositPrivKey(vaultHD, 0)
  const vaultPkh = Hash.hash160(vaultPriv.toPublicKey().encode(true) as number[])
  const lock = buildVaultLockingScript({ k1PublicKeyHash: vaultPkh })
  const lockLen = lock.toBinary().length
  console.log('locking script bytes:', lockLen, lockLen === K1_LOCK_LEN ? '(matches K1_LOCK_LEN)' : '(MISMATCH)')

  const fundingAddress = funding.toAddress()
  console.log('\nFunding address (needs a small amount of TeraTestNet BSV):', fundingAddress)
  const unspent = await wocFetchUnspent(fundingAddress)
  if (unspent.length === 0) {
    console.error(`No funding UTXO found for ${fundingAddress}. Fund it from a TeraTestNet faucet and re-run.`)
    process.exit(1)
  }
  const utxo = unspent[0]
  console.log('funding UTXO:', `${utxo.tx_hash}:${utxo.tx_pos}`, utxo.value, 'satoshis')

  // .fee()/.sign() read sourceTransaction.outputs[sourceOutputIndex] directly
  // — build a stand-in holding just the one real output, same trick the R1-K1
  // predecessor used, since WoC's unspent listing doesn't hand back a full tx.
  const fundingSourceTx = new Transaction()
  for (let i = 0; i < utxo.tx_pos; i++) {
    fundingSourceTx.addOutput({ satoshis: 0, lockingScript: fundingLockingScript })
  }
  fundingSourceTx.addOutput({ satoshis: utxo.value, lockingScript: fundingLockingScript })

  const VAULT_SATS = 1000
  const deposit = new Transaction()
  deposit.addInput({
    sourceTXID: utxo.tx_hash,
    sourceTransaction: fundingSourceTx,
    sourceOutputIndex: utxo.tx_pos,
    unlockingScriptTemplate: new P2PKH().unlock(funding, 'all', false, utxo.value, fundingLockingScript),
    sequence: 0xffffffff
  })
  deposit.addOutput({ satoshis: VAULT_SATS, lockingScript: lock })
  deposit.addOutput({ lockingScript: fundingLockingScript, change: true })
  await deposit.fee()
  await deposit.sign()

  console.log('\ndeposit tx bytes:', deposit.toBinary().length)
  const depositTxid = await wocBroadcast(Utils.toHex(deposit.toBinary()))
  console.log('deposit broadcast txid:', depositTxid)

  const withdrawal = new Transaction()
  withdrawal.addInput({
    sourceTransaction: deposit,
    sourceOutputIndex: 0,
    unlockingScriptTemplate: new P2PKH().unlock(vaultPriv, 'all', false, VAULT_SATS, lock),
    sequence: 0xffffffff
  })
  withdrawal.addOutput({ lockingScript: fundingLockingScript, change: true })
  await withdrawal.fee()
  await withdrawal.sign()
  const unlock = withdrawal.inputs[0].unlockingScript!
  const unlockLen = unlock.toBinary().length
  console.log(
    'withdrawal unlocking script bytes:',
    unlockLen,
    unlockLen <= K1_UNLOCK_LEN ? `(within K1_UNLOCK_LEN=${K1_UNLOCK_LEN})` : `(EXCEEDS K1_UNLOCK_LEN=${K1_UNLOCK_LEN})`
  )

  console.log('\nwithdrawal tx bytes:', withdrawal.toBinary().length)
  const withdrawalTxid = await wocBroadcast(Utils.toHex(withdrawal.toBinary()))
  console.log('withdrawal broadcast txid:', withdrawalTxid)

  console.log('\n--- summary ---')
  console.log('deposit txid:', depositTxid)
  console.log('withdrawal txid:', withdrawalTxid)
  console.log('Both broadcasts accepted means the K1 lock/unlock pair is accepted by a live network node.')

  return lockLen === K1_LOCK_LEN && unlockLen <= K1_UNLOCK_LEN
}

// ── entry point ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(BROADCAST ? 'mode: broadcast (TeraTestNet)' : 'mode: interpreter (offline)')
  const ok = BROADCAST ? await runBroadcastMode() : await runInterpreterMode()
  console.log(ok ? '\nPASS' : '\nFAIL')
  process.exit(ok ? 0 : 1)
}

main().catch(e => {
  console.error('spend proof FAILED:', e)
  process.exit(1)
})
