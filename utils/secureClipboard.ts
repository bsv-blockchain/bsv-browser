import * as Clipboard from 'expo-clipboard'

export const DEFAULT_CLIPBOARD_CLEAR_MS = 60_000

export interface CopySecretOptions {
  /** How long the secret is allowed to sit on the clipboard before it is wiped. */
  clearAfterMs?: number
}

/**
 * Copy a secret (recovery phrase / private key) to the clipboard and schedule an
 * automatic clear so it does not linger indefinitely. The clear only fires if
 * the clipboard STILL holds our secret — if the user copied something else in
 * the meantime we leave their clipboard alone.
 */
export async function copySecretToClipboard(
  secret: string,
  options: CopySecretOptions = {}
): Promise<void> {
  const { clearAfterMs = DEFAULT_CLIPBOARD_CLEAR_MS } = options
  await Clipboard.setStringAsync(secret)

  setTimeout(async () => {
    try {
      const current = await Clipboard.getStringAsync()
      if (current === secret) {
        await Clipboard.setStringAsync('')
      }
    } catch {
      // Best-effort hygiene; a failed read/clear must not crash anything.
    }
  }, clearAfterMs)
}
