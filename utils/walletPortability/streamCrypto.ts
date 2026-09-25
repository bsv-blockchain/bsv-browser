import { checkArchiveSize, checkCancelled, PortabilityError } from './schema'

export const FILE_CHUNK_BYTES = 256 * 1024
export interface ArchiveReader {
  size: number
  read(offset: number, length: number): Uint8Array
}
export interface ArchiveKdf {
  password: Uint8Array; salt: Uint8Array; iterations: number; memorySize: number; parallelism: number; hashLength: number
}
export interface ArchiveCipher {
  update(bytes: Uint8Array): Uint8Array
  final(): Uint8Array
  getAuthTag(): Uint8Array
  setAuthTag(tag: Uint8Array): void
}
export interface ArchiveCrypto {
  randomBytes(length: number): Uint8Array
  deriveKey(options: ArchiveKdf): Promise<Uint8Array>
  cipher(key: Uint8Array, nonce: Uint8Array, decrypt: boolean): ArchiveCipher
}
const encoder = new TextEncoder()

function readExact(source: ArchiveReader, offset: number, length: number): Uint8Array {
  const bytes = source.read(offset, length)
  if (bytes.byteLength !== length) throw new PortabilityError('invalid', 'truncated file')
  return bytes
}

export function readArchiveHeader(source: ArchiveReader) {
  checkArchiveSize(source.size)
  if (source.size < 51) throw new PortabilityError('invalid')
  const bytes = readExact(source, 0, 33)
  if (bytes[0] !== 87 || bytes[1] !== 68 || bytes[2] !== 65 || bytes[3] !== 84) throw new PortabilityError('invalid')
  if (bytes[4] !== 1 || bytes[5] !== 1 || bytes[6] !== 38 || bytes[7] !== 1) throw new PortabilityError('unsupported')
  if (bytes[8] !== 0 || bytes.subarray(21).some(x => x !== 0) || !bytes[9] || !bytes[10] || bytes[20] !== 32) throw new PortabilityError('invalid')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const iterations = view.getUint32(11), memorySize = view.getUint32(15), parallelism = bytes[19]
  if (!iterations || !parallelism || memorySize < 8 * parallelism) throw new PortabilityError('invalid')
  if (iterations > 14 || memorySize > 262144 || parallelism > 4) throw new PortabilityError('resources')
  const offset = 33 + bytes[9] + bytes[10]
  if (offset + 16 >= source.size) throw new PortabilityError('invalid')
  return {
    iterations, memorySize, parallelism, offset,
    salt: readExact(source, 33, bytes[9]), nonce: readExact(source, 33 + bytes[9], bytes[10])
  }
}

async function derive(crypto: ArchiveCrypto, password: string, parameters: Omit<ArchiveKdf, 'password' | 'hashLength'>) {
  const bytes = encoder.encode(password.normalize('NFC'))
  try {
    const key = await crypto.deriveKey({ ...parameters, password: bytes, hashLength: 32 })
    if (key.length !== 32) throw new PortabilityError('storage', 'encryption backend')
    return key
  } finally { bytes.fill(0) }
}

/** The sink is an isolated, unpublished staging copy. Only a successful return
 * authenticates all emitted bytes; callers must not activate or merge it earlier. */
export async function decodeArchiveStream(
  source: ArchiveReader, password: string, crypto: ArchiveCrypto,
  sink: (chunk: Uint8Array) => Promise<void>, signal?: AbortSignal
): Promise<'brc38' | 'brc39'> {
  checkArchiveSize(source.size)
  checkCancelled(signal)
  const magic = readExact(source, 0, Math.min(4, source.size))
  const encrypted = magic[0] === 87 && magic[1] === 68 && magic[2] === 65 && magic[3] === 84
  let key: Uint8Array | undefined
  try {
    const header = encrypted ? readArchiveHeader(source) : undefined
    key = header ? await derive(crypto, password, header) : undefined
    checkCancelled(signal)
    const cipher = header && key ? crypto.cipher(key, header.nonce, true) : undefined
    const end = source.size - (encrypted ? 16 : 0)
    let sinkFailure: unknown
    let sinkFailed = false
    if (cipher) cipher.setAuthTag(readExact(source, end, 16))
    for (let offset = header?.offset ?? 0; offset < end; offset += FILE_CHUNK_BYTES) {
      checkCancelled(signal)
      const input = readExact(source, offset, Math.min(FILE_CHUNK_BYTES, end - offset))
      const plaintext = cipher ? cipher.update(input) : input
      try {
        if (!sinkFailed) {
          try { await sink(plaintext) }
          catch (error) {
            if (!encrypted) throw error
            // Finish authentication without emitting any more unverified data.
            // A wrong password must not be mistaken for a malformed JSON file.
            sinkFailure = error
            sinkFailed = true
          }
        }
      } finally { plaintext.fill(0) }
    }
    if (cipher) {
      let last: Uint8Array
      try { last = cipher.final() } catch { throw new PortabilityError('password') }
      try { if (last.length && !sinkFailed) await sink(last) } finally { last.fill(0) }
    }
    checkCancelled(signal)
    if (sinkFailed) throw sinkFailure
    return encrypted ? 'brc39' : 'brc38'
  } finally { key?.fill(0) }
}

/** Output is a new private temporary file; publish/rename it only after success. */
export async function encodeArchiveStream(
  plaintext: AsyncIterable<Uint8Array>, password: string, crypto: ArchiveCrypto,
  sink: (chunk: Uint8Array) => Promise<void>, signal?: AbortSignal
): Promise<number> {
  if (password.length < 12) throw new PortabilityError('password')
  checkCancelled(signal)
  const salt = crypto.randomBytes(32), nonce = crypto.randomBytes(32)
  const header = new Uint8Array(97)
  header.set([87, 68, 65, 84, 1, 1, 38, 1, 0, 32, 32])
  const view = new DataView(header.buffer)
  view.setUint32(11, 7); view.setUint32(15, 131072)
  header[19] = 1; header[20] = 32
  header.set(salt, 33); header.set(nonce, 65)
  const key = await derive(crypto, password, { salt, iterations: 7, memorySize: 131072, parallelism: 1 })
  let size = 0
  const write = async (bytes: Uint8Array) => {
    checkCancelled(signal)
    size += bytes.length; checkArchiveSize(size)
    await sink(bytes)
  }
  try {
    const cipher = crypto.cipher(key, nonce, false)
    await write(header)
    for await (const row of plaintext) {
      try {
        for (let offset = 0; offset < row.length; offset += FILE_CHUNK_BYTES) {
          await write(cipher.update(row.subarray(offset, offset + FILE_CHUNK_BYTES)))
        }
      } finally { row.fill(0) }
    }
    const final = cipher.final()
    if (final.length) await write(final)
    await write(cipher.getAuthTag())
    return size
  } finally { key.fill(0) }
}
