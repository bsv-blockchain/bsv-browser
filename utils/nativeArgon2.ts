import { registerArgon2idBackend, type Argon2idOptions, type AsyncArgon2idBackend } from '@bsv/wallet-toolbox-mobile'
import { argon2 } from 'react-native-quick-crypto'

const PROBE_OPTIONS: Argon2idOptions = {
  password: new Uint8Array(32).fill(1),
  salt: new Uint8Array(16).fill(2),
  iterations: 3,
  memorySize: 32,
  parallelism: 4,
  hashLength: 32
}
const PROBE_RESULT = '03aab965c12001c9d7d0d2de33192c0494b684bb148196d73c1df1acaf6d0c2e'

export type NativeArgon2idDiagnostics = {
  available: boolean
  ready: boolean
  registered: boolean
  provider: 'react-native-quick-crypto'
  error?: string
  lastDerivationMs?: number
  lastMemoryKiB?: number
  lastIterations?: number
}

declare global {
  // Runtime-only QA seam. It contains status and timings, never password or key material.
  var __bsvNativeArgon2idDiagnostics: NativeArgon2idDiagnostics | undefined
}

let installedBackend: NativeArgon2idBackend | undefined

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

function deriveNativeArgon2id(options: Readonly<Argon2idOptions>): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    argon2(
      'argon2id',
      {
        message: options.password,
        nonce: options.salt,
        passes: options.iterations,
        memory: options.memorySize,
        parallelism: options.parallelism,
        tagLength: options.hashLength,
        version: 0x13
      },
      (error, result) => {
        if (error) {
          reject(error)
          return
        }
        try {
          resolve(Uint8Array.from(result))
        } catch (conversionError) {
          reject(conversionError)
        }
      }
    )
  })
}

class NativeArgon2idBackend implements AsyncArgon2idBackend {
  private preloadPromise?: Promise<void>
  private ready = false

  preload(): Promise<void> {
    this.preloadPromise ??= (async () => {
      const probe = await deriveNativeArgon2id(PROBE_OPTIONS)
      if (toHex(probe) !== PROBE_RESULT) {
        throw new Error('Native Argon2id interoperability proof failed')
      }
      this.ready = true
      globalThis.__bsvNativeArgon2idDiagnostics = {
        available: true,
        ready: true,
        registered: true,
        provider: 'react-native-quick-crypto'
      }
    })().catch(error => {
      this.ready = false
      globalThis.__bsvNativeArgon2idDiagnostics = {
        available: false,
        ready: false,
        registered: true,
        provider: 'react-native-quick-crypto',
        error: error instanceof Error ? error.message : String(error)
      }
      throw error
    })
    return this.preloadPromise
  }

  isReady(): boolean {
    return this.ready
  }

  async deriveKey(options: Readonly<Argon2idOptions>): Promise<Uint8Array> {
    if (!this.ready) throw new Error('Native Argon2id backend is not ready')
    const start = performance.now()
    const result = await deriveNativeArgon2id(options)
    globalThis.__bsvNativeArgon2idDiagnostics = {
      available: true,
      ready: true,
      registered: true,
      provider: 'react-native-quick-crypto',
      lastDerivationMs: performance.now() - start,
      lastMemoryKiB: options.memorySize,
      lastIterations: options.iterations
    }
    return result
  }
}

export function installNativeArgon2idBackend(): AsyncArgon2idBackend | undefined {
  if (installedBackend) return installedBackend
  const backend = new NativeArgon2idBackend()
  try {
    registerArgon2idBackend(backend)
    installedBackend = backend
    globalThis.__bsvNativeArgon2idDiagnostics = {
      available: true,
      ready: false,
      registered: true,
      provider: 'react-native-quick-crypto'
    }
    void backend
      .preload()
      .then(() => console.info('[NativeArgon2id] Ready'))
      .catch(error => console.warn('[NativeArgon2id] Native backend unavailable; using portable fallback', error))
    return backend
  } catch (error) {
    globalThis.__bsvNativeArgon2idDiagnostics = {
      available: false,
      ready: false,
      registered: false,
      provider: 'react-native-quick-crypto',
      error: error instanceof Error ? error.message : String(error)
    }
    console.warn('[NativeArgon2id] Could not register native backend; using portable fallback', error)
    return undefined
  }
}

export function getNativeArgon2idDiagnostics(): NativeArgon2idDiagnostics {
  return (
    globalThis.__bsvNativeArgon2idDiagnostics ?? {
      available: false,
      ready: false,
      registered: false,
      provider: 'react-native-quick-crypto'
    }
  )
}
