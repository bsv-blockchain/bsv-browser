/**
 * wallet-toolbox-mobile 2.14.7+ posts an unproven incoming payment inside
 * internalizeAction and throws WERR_REVIEW_ACTIONS when the post fails. The
 * expo-wallet-toolbox 0.19.0 patch teaches the credit classifier to read its
 * results; these tests fail if that patch stops applying.
 */
import { sdk } from '@bsv/wallet-toolbox-mobile'
import { classifyCreditError, failedPostReason } from '@bsv/expo-wallet-toolbox/core/pay/creditErrors'
import { isRetriableInternalizeFailure } from '@bsv/expo-wallet-toolbox/core/mandala/drain'

const failedPost = (...statuses: Array<'serviceError' | 'doubleSpend' | 'invalidTx'>) =>
  new sdk.WERR_REVIEW_ACTIONS(
    statuses.map(status => ({ txid: '00'.repeat(32), status })),
    [{ txid: '00'.repeat(32), status: 'failed' }],
    '00'.repeat(32)
  )

describe('a payment internalizeAction could not post', () => {
  it('is environmental when no broadcaster could be reached, so it is kept and retried', () => {
    expect(classifyCreditError(failedPost('serviceError'))).toBe('environmental')
    expect(isRetriableInternalizeFailure(failedPostReason(failedPost('serviceError')))).toBe(true)
  })

  it('is double_spend when the network reports a double spend', () => {
    expect(classifyCreditError(failedPost('serviceError', 'doubleSpend'))).toBe('double_spend')
  })

  it('is structural when the network rejects the transaction', () => {
    expect(classifyCreditError(failedPost('invalidTx'))).toBe('structural')
    expect(isRetriableInternalizeFailure(failedPostReason(failedPost('invalidTx')))).toBe(false)
  })
})
