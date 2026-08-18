import { recoverSecretFromShares } from '@/utils/backupShares'
import { recoverMnemonicWallet } from '@/utils/mnemonicWallet'
import { Mnemonic } from '@bsv/sdk'
import { BackupClient } from '@/utils/backup/client'

const RUN = process.env.RESTORE_REPRO === '1'
;(RUN ? describe : describe.skip)('manifest probe', () => {
  jest.setTimeout(60000)
  it('lists devices', async () => {
    const shares = (process.env.RESTORE_SHARES ?? '').split(',').map(s => s.trim())
    const secret = recoverSecretFromShares(shares)
    if (secret.kind !== 'entropy') throw new Error('legacy')
    const w = recoverMnemonicWallet(Mnemonic.fromEntropy(secret.entropy).toString())
    const client = new BackupClient('https://backup.bsvblockchain.tech', w.primaryKey)
    const devices = await client.manifest()
    console.log('DEVICES:', JSON.stringify(devices))
  })
})
