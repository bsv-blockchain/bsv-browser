import { recoverSecretFromShares } from '@bsv/expo-wallet-toolbox/ui/backupShares'
import { recoverMnemonicWallet } from '@bsv/expo-wallet-toolbox/core/mnemonicWallet'
import { Mnemonic } from '@bsv/sdk'
import { BackupClient } from '@bsv/expo-wallet-toolbox/core/backup/client'

const RUN = process.env.RESTORE_REPRO === '1'
;(RUN ? describe : describe.skip)('manifest probe', () => {
  jest.setTimeout(60000)
  it('lists devices', async () => {
    const shares = (process.env.RESTORE_SHARES ?? '').split(',').map(s => s.trim())
    const secret = recoverSecretFromShares(shares)
    if (secret.kind !== 'entropy') throw new Error('legacy')
    const w = recoverMnemonicWallet(Mnemonic.fromEntropy(secret.entropy).toString())
    const client = new BackupClient('https://backup.bsvblockchain.tech', w.primaryKey, 'main')
    const devices = await client.manifest()
    console.log('DEVICES:', JSON.stringify(devices))
  })
})
