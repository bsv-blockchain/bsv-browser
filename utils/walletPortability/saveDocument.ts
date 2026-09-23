import { checkArchiveSize, checkCancelled, PortabilityError } from './schema'

export interface SaveFileSource {
  size: number
  open(): { readBytes(length: number): Uint8Array; close(): void }
}
export interface SaveFileDestination {
  size: number
  write(bytes: Uint8Array, options: { append: boolean }): void
  delete(): void
}

/** Copy into a newly created document-provider file without buffering an archive.
 * Some Android providers support streams but not File.copy or random access.
 * The caller owns creation; never pass an existing user file as destination. */
export async function copyToNewWalletDocument(
  source: SaveFileSource, destination: SaveFileDestination,
  report: (message: string) => void, signal?: AbortSignal
): Promise<void> {
  // A provider must create a new empty file; never delete existing data.
  if (destination.size !== 0) throw new Error('The destination is not a new empty file. Nothing was overwritten.')
  let handle: ReturnType<SaveFileSource['open']> | undefined
  try {
    checkArchiveSize(source.size)
    checkCancelled(signal)
    const size = source.size
    handle = source.open()
    let written = 0
    while (written < size) {
      checkCancelled(signal)
      const expected = Math.min(256 * 1024, size - written)
      const bytes = handle.readBytes(expected)
      if (bytes.length !== expected) throw new Error('incomplete source')
      try { destination.write(bytes, { append: written > 0 }) }
      finally { bytes.fill(0) }
      written += expected
      report(`Saving file: ${Math.floor(written / 1024 / 1024).toLocaleString()} MiB…`)
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
    checkCancelled(signal)
    if (source.size !== size || destination.size !== size) throw new Error('incomplete destination')
  } catch (error) {
    // Only the freshly created output is removed; the retained original is untouched.
    try { destination.delete() } catch {
      throw new Error('The copy did not finish. Remove the incomplete file from the chosen folder. Your original remains in this app.')
    }
    if (error instanceof PortabilityError) throw error
    throw new Error('The complete file could not be saved. Your original remains in this app.')
  } finally { handle?.close() }
}
