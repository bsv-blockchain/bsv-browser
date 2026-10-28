import { createEcpmModule, type EcpmAuthorizationRequest, type EcpmKeyDeriver } from '@bsv/ecpm-permission-module'
import type { WalletPermissionsManager } from '@bsv/wallet-toolbox-mobile'
import { KeyDeriver, WalletError, type PrivateKey } from '@bsv/sdk'

// Published module errors are plain Errors. Convert only this module's known
// public errors into the BRC-100 generic wallet error; never expose provider
// internals or stacks as an application-facing explanation.
function ecpmWalletError(error: unknown): WalletError {
  const denied = (error as { code?: unknown })?.code === 'ERR_PERMISSION_DENIED'
  const message = denied ? 'ECPM: user denied permission' : error instanceof Error && error.message.startsWith('ECPM')
    ? error.message
    : 'ECPM: wallet could not complete this request'
  return new WalletError(message, 1)
}

/** Trusted host capabilities, never passed across the BRC-100 bridge. */
export type EcpmWallet = {
  keyDeriver: EcpmKeyDeriver
  privilegedKeyManager?: unknown
}
export type EcpmPromptRequest = { request: EcpmAuthorizationRequest; durationMs: number; answer: (allow: boolean) => void }

/** One instance per open wallet host. Grants and pending prompts never cross builds. */
export class EcpmSession {
  constructor(private readonly permissions?: () => WalletPermissionsManager | null | undefined) {}

  private listeners = new Set<() => void>()
  private pending: EcpmPromptRequest[] = []
  private generation = 0
  private module?: ReturnType<typeof createEcpmModule>

  getSnapshot = (): EcpmPromptRequest | null => this.pending[0] ?? null
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) for (const item of [...this.pending]) item.answer(false)
    }
  }
  private emit() { this.listeners.forEach(listener => listener()) }

  private authorize = (request: EcpmAuthorizationRequest): Promise<boolean> => {
    if (this.listeners.size === 0 || this.pending.length >= 64) return Promise.resolve(false)
    const generation = this.generation
    const manager = this.permissions?.()
    if (manager && !request.privileged) {
      const authorization = manager.ensureProtocolPermission({
        originator: request.originator, privileged: false,
        protocolID: [request.securityLevel, `p ecpm ${request.logicalProtocolID}`],
        counterparty: request.counterparty, usageType: 'generic',
        moduleDetails: { scheme: 'ecpm', operation: request.operation, point: request.point, keyID: request.keyID },
        seekPermission: request.seekPermission,
      }).then(allowed => allowed && generation === this.generation)
      let timeout: ReturnType<typeof setTimeout>
      const abandoned = new Promise<boolean>(resolve => {
        timeout = setTimeout(() => {
          // A stale prompt cannot later grant access after this bridge call ended.
          manager.revokeSessionPermissions(request.originator)
          resolve(false)
        }, 120_000)
      })
      return Promise.race([authorization, abandoned]).finally(() => clearTimeout(timeout))
    }
    if (request.seekPermission === false) return Promise.resolve(false)
    return new Promise(resolve => {
      let settled = false
      const item: EcpmPromptRequest = {
        request,
        durationMs: this.permissions ? 0 : 300_000,
        answer: allow => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          this.pending = this.pending.filter(entry => entry !== item)
          resolve(allow === true && generation === this.generation)
          this.emit()
        }
      }
      // Abandoned requests fail closed; no unbounded modal or bridge promises.
      const timeout = setTimeout(() => item.answer(false), 120_000)
      this.pending = [...this.pending, item]
      this.emit()
    })
  }

  replace(wallet: EcpmWallet, expectedGeneration?: number) {
    if (expectedGeneration !== undefined && expectedGeneration !== this.generation) throw new Error('ECPM wallet session changed during build')
    this.dispose()
    const generation = this.generation
    const module = createEcpmModule({
      keyDeriver: wallet.keyDeriver,
      authorize: this.authorize,
      authorizationTTL: this.permissions ? 0 : undefined,
      privilegedKeyDeriver: async reason => {
        if (generation !== this.generation || !wallet.privilegedKeyManager) throw new Error('ECPM privileged wallet is unavailable')
        // Wallet Toolbox exposes this retrieval internally rather than in ProtoWallet.
        // Keep the adapter in trusted host code; reject incompatible hosts.
        const manager = wallet.privilegedKeyManager as { getPrivilegedKey?: (reason: string) => Promise<PrivateKey> }
        if (typeof manager.getPrivilegedKey !== 'function') throw new Error('ECPM privileged key retrieval is unavailable')
        const key = await manager.getPrivilegedKey(reason)
        if (generation !== this.generation) throw new Error('ECPM wallet session changed')
        // Do not cache a privileged root or extend the host's retention period.
        return new KeyDeriver(key)
      }
    })
    this.module = module
    return {
      onRequest: async (...args: Parameters<typeof module.onRequest>) => {
        try { return await module.onRequest(...args) } catch (error) { throw ecpmWalletError(error) }
      },
      onResponse: module.onResponse.bind(module),
      handleRequest: async (...args: Parameters<typeof module.handleRequest>) => {
        try {
          if (generation !== this.generation) throw new Error('ECPM wallet session changed')
          const result = await module.handleRequest(...args)
          if (generation !== this.generation) throw new Error('ECPM wallet session changed')
          return result
        } catch (error) { throw ecpmWalletError(error) }
      }
    }
  }

  dispose = () => {
    this.permissions?.()?.revokeSessionPermissions?.()
    this.generation++
    this.module?.dispose()
    this.module = undefined
    for (const item of [...this.pending]) item.answer(false)
    return this.generation
  }
}

export function ecpmConsentText(request: EcpmAuthorizationRequest): string {
  return [
    'Allow point masking for this protocol for up to five minutes in this wallet session?',
    'Approval covers applying and removing masks for all key IDs and points in this protocol scope. Your secret key stays in the wallet.',
    `Application: ${request.originator}`,
    `Protocol: ${request.logicalProtocolID}`,
    `Security level: ${request.securityLevel}`,
    `Key ID: ${request.keyID}`,
    `Counterparty scope: ${request.securityLevel === 1 ? 'All counterparties' : request.counterparty}`,
    `First counterparty: ${request.counterparty}`,
    `First operation: ${request.operation}`,
    `Point: ${request.point}`,
    `Privileged key: ${request.privileged ? 'Yes' : 'No'}`,
    ...(request.privileged ? [`Reason: ${request.privilegedReason}`] : [])
  ].join('\n\n')
}
