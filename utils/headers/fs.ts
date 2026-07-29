/**
 * The five filesystem operations the header store needs, behind an interface.
 *
 * expo-file-system's binary API is native-only, so the store would be
 * untestable in jest without this seam. It is deliberately tiny: no seeking, no
 * directory walking, no partial writes.
 *
 * `expo-file-system` is required lazily inside `expoHeaderFs()` rather than
 * imported at module scope: the package ships untranspiled TS as its main
 * entry and this project's jest transformIgnorePatterns does not cover it, so
 * an eager import would break any test that only needs `memoryHeaderFs`. Same
 * pattern already used for native-only imports in utils/secpNativeProof.ts and
 * utils/engineNativeProof.ts.
 */
export interface HeaderFs {
  readBytes(path: string): Promise<Uint8Array | undefined>
  appendBytes(path: string, bytes: Uint8Array): Promise<void>
  readText(path: string): Promise<string | undefined>
  writeText(path: string, text: string): Promise<void>
  /**
   * Removes a path, if it is there. An absent path is the desired end state,
   * not an error, so it resolves; anything else genuinely failing throws.
   *
   * Exists because `appendBytes` appends and nothing else can undo that. The
   * header window is discarded whenever the shipped checkpoint moves, and
   * without a delete the old anchor's bytes stay on disk in front of everything
   * the next sync writes — see `HeaderStore.reset`.
   */
  deleteFile(path: string): Promise<void>
}

const HEADERS_DIR = 'headers'

export function expoHeaderFs(): HeaderFs {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Directory, File, Paths } = require('expo-file-system') as typeof import('expo-file-system')
  const dir = new Directory(Paths.document, HEADERS_DIR)
  const ensureDir = () => {
    if (!dir.exists) dir.create({ intermediates: true })
  }
  const file = (path: string) => new File(dir, path)
  return {
    async readBytes(path) {
      const f = file(path)
      return f.exists ? await f.bytes() : undefined
    },
    async appendBytes(path, bytes) {
      ensureDir()
      const f = file(path)
      if (!f.exists) f.create()
      f.write(bytes, { append: true })
    },
    async readText(path) {
      const f = file(path)
      return f.exists ? await f.text() : undefined
    },
    async writeText(path, text) {
      ensureDir()
      const f = file(path)
      if (!f.exists) f.create()
      f.write(text)
    },
    async deleteFile(path) {
      const f = file(path)
      // `File.delete()` throws when the file is absent, which is the one outcome
      // this operation is content with.
      if (f.exists) f.delete()
    }
  }
}

/** In-memory HeaderFs for tests. */
export function memoryHeaderFs(): HeaderFs {
  const files = new Map<string, Uint8Array>()
  const text = new Map<string, string>()
  return {
    async readBytes(path) {
      return files.get(path)
    },
    async appendBytes(path, bytes) {
      const existing = files.get(path)
      if (!existing) {
        files.set(path, bytes.slice())
        return
      }
      const next = new Uint8Array(existing.length + bytes.length)
      next.set(existing, 0)
      next.set(bytes, existing.length)
      files.set(path, next)
    },
    async readText(path) {
      return text.get(path)
    },
    async writeText(path, value) {
      text.set(path, value)
    },
    async deleteFile(path) {
      // Both maps: this fake splits bytes from text, but a real filesystem has
      // one namespace and callers are entitled to that behaviour.
      files.delete(path)
      text.delete(path)
    }
  }
}
