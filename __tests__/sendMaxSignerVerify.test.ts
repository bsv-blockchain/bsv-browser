/**
 * Send-max at the signer layer.
 *
 * A send-max output is requested with satoshis = maxPossibleSatoshis
 * (2099999999999999); storage's generateChange rewrites that output to
 * whatever the inputs can fund. The GHSA-36f9-7rg5-cpf8 hardening in
 * buildSignableTransaction compares storage's outputs against the request,
 * and must exempt the amount (never the script) of a send-max output —
 * otherwise every send-max createAction throws after storage has already
 * persisted the unsigned transaction, stranding it.
 *
 * The permissions-layer twin of this check (WalletPermissionsManager.
 * verifyRequestedOutputsPresent) already carries the exemption via the
 * package patch; this pins the signer layer to the same contract.
 */
import { verifyRequestedOutputsUnchanged } from '@bsv/wallet-toolbox-mobile/out/src/signer/methods/buildSignableTransaction'

const SEND_MAX = 2099999999999999
const SCRIPT = '76a914000000000000000000000000000000000000000088ac'
const OTHER_SCRIPT = '76a914111111111111111111111111111111111111111188ac'

const storageOutput = (over: Record<string, unknown> = {}) => ({
  purpose: undefined,
  providedBy: 'you',
  lockingScript: SCRIPT,
  satoshis: 1000,
  ...over
})

const argsWith = (outputs: { lockingScript: string; satoshis: number }[]) => ({ outputs }) as any

describe('verifyRequestedOutputsUnchanged and send-max', () => {
  it('accepts a send-max output whose amount storage rewrote to the funded figure', () => {
    const requested = argsWith([{ lockingScript: SCRIPT, satoshis: SEND_MAX }])
    const provided = [storageOutput({ satoshis: 123456 })]
    expect(() => verifyRequestedOutputsUnchanged(provided as any, requested)).not.toThrow()
  })

  it('still rejects a substituted script on a send-max output', () => {
    const requested = argsWith([{ lockingScript: SCRIPT, satoshis: SEND_MAX }])
    const provided = [storageOutput({ lockingScript: OTHER_SCRIPT, satoshis: 123456 })]
    expect(() => verifyRequestedOutputsUnchanged(provided as any, requested)).toThrow(/locking script/i)
  })

  it('still rejects an amount change on an ordinary output', () => {
    const requested = argsWith([{ lockingScript: SCRIPT, satoshis: 5000 }])
    const provided = [storageOutput({ satoshis: 4999 })]
    expect(() => verifyRequestedOutputsUnchanged(provided as any, requested)).toThrow(/satoshis/i)
  })

  it('still rejects storage reclassifying a send-max output as change', () => {
    const requested = argsWith([{ lockingScript: SCRIPT, satoshis: SEND_MAX }])
    const provided = [storageOutput({ satoshis: 123456, purpose: 'change', providedBy: 'storage' })]
    expect(() => verifyRequestedOutputsUnchanged(provided as any, requested)).toThrow(/providedBy/i)
  })
})
