const byteFieldNames = new Set([
  'BEEF',
  'atomicBEEF',
  'beef',
  'ciphertext',
  'competingBeef',
  'data',
  'encryptedLinkage',
  'encryptedLinkageProof',
  'hashToDirectlySign',
  'hashToDirectlyVerify',
  'hmac',
  'inputBEEF',
  'payload',
  'plaintext',
  'signature',
  'transaction',
  'tx'
])

const ambiguousContainerFieldNames = new Set(['data', 'payload'])
const hasOwn = Object.prototype.hasOwnProperty

function isByte(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 255
}

function isUint8Array(value: unknown): value is Uint8Array {
  return (
    value != null &&
    typeof value === 'object' &&
    typeof ArrayBuffer !== 'undefined' &&
    ArrayBuffer.isView(value) &&
    Object.prototype.toString.call(value) === '[object Uint8Array]'
  )
}

function isUnsupportedBinaryView(value: unknown): boolean {
  return (
    value != null &&
    typeof value === 'object' &&
    typeof ArrayBuffer !== 'undefined' &&
    (ArrayBuffer.isView(value) || Object.prototype.toString.call(value) === '[object ArrayBuffer]')
  )
}

function normalizeByteArray(value: unknown): number[] | Uint8Array | undefined {
  if (isUint8Array(value)) return value
  if (isUnsupportedBinaryView(value)) return undefined
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!hasOwn.call(value, index) || !isByte(value[index])) return undefined
    }
    return value
  }
  if (value == null || typeof value !== 'object') return undefined
  try {
    const keys = Object.keys(value)
    const bytes = new Array<number>(keys.length)
    for (let index = 0; index < keys.length; index += 1) {
      if (keys[index] !== String(index)) return undefined
      const byte = (value as Record<string, unknown>)[keys[index]]
      if (!isByte(byte)) return undefined
      bytes[index] = byte
    }
    return bytes
  } catch {
    return undefined
  }
}

function isAmbiguousEmptyContainer(key: string, value: unknown): boolean {
  return (
    ambiguousContainerFieldNames.has(key) &&
    value != null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !isUint8Array(value) &&
    Object.keys(value).length === 0
  )
}

export function normalizeWalletByteFields<T>(value: T): T {
  const seen = new WeakSet<object>()
  const visit = (candidate: unknown): void => {
    if (candidate == null || typeof candidate !== 'object' || isUint8Array(candidate)) return
    if (seen.has(candidate)) return
    seen.add(candidate)
    if (Array.isArray(candidate)) {
      candidate.forEach(visit)
      return
    }
    for (const [key, child] of Object.entries(candidate)) {
      if (byteFieldNames.has(key)) {
        const bytes = isAmbiguousEmptyContainer(key, child) ? undefined : normalizeByteArray(child)
        if (bytes != null) (candidate as Record<string, unknown>)[key] = bytes
        else visit(child)
      } else {
        visit(child)
      }
    }
  }
  visit(value)
  return value
}

export function stringifyWalletPayload(value: unknown): string {
  const serialized = JSON.stringify(value, function (key, child) {
    const original = (this as Record<string, unknown>)[key]
    if (byteFieldNames.has(key)) {
      const candidate = original ?? child
      const bytes = isAmbiguousEmptyContainer(key, candidate) ? undefined : normalizeByteArray(candidate)
      if (bytes != null) return Array.from(bytes)
    }
    return isUint8Array(original) ? Array.from(original) : isUint8Array(child) ? Array.from(child) : child
  })
  if (serialized === undefined) throw new TypeError('Wallet payload is not JSON serializable')
  return serialized
}
