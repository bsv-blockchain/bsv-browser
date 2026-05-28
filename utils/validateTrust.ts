import isImageUrl from './isImageUrl'

/**
 * Validates that a trust object of a domain follows the BRC-68 protocol
 * @param {object} trust - BRC-68 trust object
 * @param {object} obj
 * @param {boolean} [obj.skipNote = false]
 * @returns
 */
interface TrustObject {
  name: string
  note?: string
  icon: string
  publicKey: string
}

const validateTrust = async (trust: TrustObject, { skipNote = false } = {}) => {
  if (trust.name.length < 5 || trust.name.length > 30) {
    const e = new Error('Trust validation failed, name must be 5-30 characters')
    ;(e as any).field = 'name'
    throw e
  }
  if (!skipNote) {
    if (!trust.note || trust.note.length < 5 || trust.note.length > 50) {
      const e = new Error('Trust validation failed, note must be 5-50 characters')
      ;(e as any).field = 'note'
      throw e
    }
  }
  const iconValid = await isImageUrl(trust.icon)
  if (!iconValid) {
    const e = new Error('Trust validation failed, icon image URL is invalid')
    ;(e as any).field = 'icon'
    throw e
  }
  if (/^(02|03)[a-f0-9]{64}$/.test(trust.publicKey) !== true) {
    const e = new Error('Trust validation failed, public key is invalid')
    ;(e as any).field = 'publicKey'
    throw e
  }
  return true
}

export default validateTrust
