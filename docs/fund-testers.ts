import { WalletClient, Script, Hash, Utils } from '@bsv/sdk'

const secret = 'goose'
const hash = Utils.toHex(Hash.sha256(Utils.toArray(secret, 'utf8')))
export async function createToken() {

    // Connect to user's wallet
    const wallet = new WalletClient('auto', 'deggen')

    // Create a token which represents an event ticket
    const response = await wallet.createAction({
      description: 'make a funding output for something',
      outputs: [{
        satoshis: 10000,
        lockingScript: Script.fromASM('OP_SHA256 ' + hash + ' OP_EQUAL').toHex(),
        basket: 'hash tokens',
        outputDescription: 'admin secrets',
        customInstructions: secret
      }],
      options: {
        acceptDelayedBroadcast: false
      }
    })

    return console.log(response)
  
}

await createToken()