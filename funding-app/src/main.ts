import { WalletClient, Script, Utils } from '@bsv/sdk'

const ADMIN_IDENTITY_KEY = '02c1934bb9bf000bc6e232502a270b7acac1a807a2d78e6325629a6c4762907e70'
const SCRIPTHASH = '0d8df58c7c2b44e0bba5e9b2ec2bb42814c545eb0511c7820b2855493e13e2e1'
const WOC_BASE = 'https://api.whatsonchain.com/v1/bsv/main'

const logEl = document.getElementById('log')!
const runBtn = document.getElementById('run') as HTMLButtonElement
const passwordInput = document.getElementById('password') as HTMLInputElement

function log(msg: string, cls: 'info' | 'error' | 'success' = 'info') {
  const span = document.createElement('span')
  span.className = cls
  span.textContent = msg + '\n'
  logEl.appendChild(span)
  logEl.scrollTop = logEl.scrollHeight
}

async function fetchUtxos(): Promise<{ tx_hash: string; tx_pos: number; value: number; height: number }[]> {
  const res = await fetch(`${WOC_BASE}/script/${SCRIPTHASH}/unspent`)
  if (!res.ok) throw new Error(`WoC unspent API error: ${res.status}`)
  return res.json()
}

async function fetchBeef(txid: string): Promise<number[]> {
  const res = await fetch(`${WOC_BASE}/tx/${txid}/beef`)
  if (!res.ok) throw new Error(`WoC BEEF API error: ${res.status}`)
  const hex = await res.text()
  return Utils.toArray(hex, 'hex')
}

async function runFunding() {
  const password = passwordInput.value.trim()
  if (!password) {
    log('Please enter the unlock password.', 'error')
    return
  }

  runBtn.disabled = true
  logEl.innerHTML = ''

  try {
    log('Connecting to wallet...')
    const wallet = new WalletClient()

    log('Checking identity key...')
    const { publicKey } = await wallet.getPublicKey({ identityKey: true })
    log(`Identity: ${publicKey}`)

    if (publicKey !== ADMIN_IDENTITY_KEY) {
      log('Not authorized — identity key does not match admin key.', 'error')
      return
    }
    log('Admin key verified.', 'success')

    log(`Fetching UTXOs for scripthash ${SCRIPTHASH.slice(0, 12)}...`)
    const utxos = await fetchUtxos()
    if (!utxos.length) {
      log('No UTXOs found for this scripthash.', 'error')
      return
    }

    // Sort by height ascending (oldest first), then by tx_pos
    utxos.sort((a, b) => (a.height || Infinity) - (b.height || Infinity) || a.tx_pos - b.tx_pos)
    const oldest = utxos[0]
    log(`Found ${utxos.length} UTXO(s). Using oldest: ${oldest.tx_hash}:${oldest.tx_pos} (${oldest.value} sats, block ${oldest.height})`)

    log('Fetching BEEF...')
    const beef = await fetchBeef(oldest.tx_hash)
    log(`BEEF fetched: ${beef.length} bytes`, 'success')

    log('Calling createAction...')
    const result = await wallet.createAction({
      description: 'Fund wallet from UTXO',
      inputs: [{
        outpoint: oldest.tx_hash + '.' + oldest.tx_pos,
        inputDescription: 'Fund wallet from secret UTXO',
        unlockingScript: Script.fromASM(Utils.toHex(Utils.toArray(password, 'utf8'))).toHex(),
      }],
      inputBEEF: beef
    })

    log(`txid: ${result.txid}`, 'success')
  } catch (err: any) {
    log(`Error: ${err.message || err}`, 'error')
  } finally {
    runBtn.disabled = false
  }
}

// Expose to global for onclick
;(window as any).runFunding = runFunding
