import type { SecpBackend } from './types'
import { createNobleSecpBackend } from './nobleSecpBackend'
import { tryCreateNativeSecpBackend } from './nativeSecpBackend'

export type { SecpBackend, SecpBackendName } from './types'

const GLOBAL_KEY = '__BSV_SECP_BACKEND__'

type SecpGlobal = typeof globalThis & {
  [GLOBAL_KEY]?: SecpBackend
}

function readInstalled(): SecpBackend | undefined {
  return (globalThis as SecpGlobal)[GLOBAL_KEY]
}

function writeInstalled(backend: SecpBackend): void {
  ;(globalThis as SecpGlobal)[GLOBAL_KEY] = backend
}

/**
 * Whether a fast ECDSA backend has been installed on globalThis.
 */
export function isFastEcdsaInstalled(): boolean {
  return readInstalled() != null
}

/**
 * Return the active secp backend. Throws if installFastEcdsa() was not called.
 */
export function getSecpBackend(): SecpBackend {
  const backend = readInstalled()
  if (!backend) {
    throw new Error('Fast ECDSA is not installed; call installFastEcdsa() first')
  }
  return backend
}

/**
 * Prefer sync native ufsecp when available; otherwise audited @noble/secp256k1.
 * Idempotent: a second call returns the already-selected backend without re-init.
 *
 * Hot path is ECDSA sign/verify (Metro-aliased into `@bsv/sdk` via `fastECDSA.ts`).
 * We do not monkey-patch `PrivateKey` / `PublicKey` class methods — stock SDK methods
 * already call the ECDSA module, so the alias covers them. Public-key-only helpers are
 * not Metro-aliased; backends still expose `pubkeyCreate` for internal use.
 */
export function installFastEcdsa(): { backend: SecpBackend['name'] } {
  const existing = readInstalled()
  if (existing) {
    return { backend: existing.name }
  }

  const backend = tryCreateNativeSecpBackend() ?? createNobleSecpBackend()
  writeInstalled(backend)
  return { backend: backend.name }
}
