/**
 * Size limits for wallet-interface arguments.
 *
 * WHY THESE NUMBERS. Peak RSS on this stack is roughly 20x the payload size and
 * up to 30x under planning assumptions — native intake, the retained JSON
 * string, the number[] in Hermes, GC slack, the Uint8Array copy for SQLite, and
 * SQLite's own copies. So a 4 MB call is ~120 MB of peak, and the 100 MB network
 * ceiling would be 2-3 GB: above the jetsam limit of every iPhone with 4 GB or
 * less. Exceeding the Hermes heap is an uncatchable `LLVM ERROR: OOM` abort, not
 * an exception, so there is no degrade-and-warn design available — a cap set too
 * high converts into a crash rather than an error, and every check here must
 * refuse BEFORE anything allocates.
 *
 * 100 MB remains the NETWORK ceiling. It is not a memory cap and must never be
 * used as one.
 *
 * The limits are deliberately far below what memory alone would allow, because
 * the largest legitimate page payload in this app today is a 65,536-byte
 * localpay AtomicBEEF and a ~25-byte P2PKH locking script. 4 MB is ~60x observed
 * traffic; sizing to the memory budget instead would leave two orders of
 * magnitude of headroom nobody uses.
 *
 * Nothing here serialises anything. Every size is summed from a length that is
 * already materialised, so a check is O(#inputs + #outputs) integer reads.
 *
 * THE VAULT IS NOT SUBJECT TO THESE. Its K1 traffic is ordinary-sized today —
 * a 25-byte P2PKH locking script and a ~107-byte unlocking script per input —
 * comfortably inside every limit below. The exemption is structural rather
 * than sized to fit current vault traffic: the vault calls the permissions
 * manager directly and never passes through the wrapper in capWalletArgs.ts,
 * so it stays insulated from any future tightening of these limits. It is
 * paired with the vault's own input cap in services/vault/transfers.ts.
 */
import type { DeviceTier } from '@/utils/deviceTier'

export interface WalletArgLimits {
  /** Total bytes across every field of one call. */
  aggregate: number
  /** One output's locking script. */
  outputScript: number
  /** All output locking scripts summed. */
  outputScriptTotal: number
  /** Entries in `outputs` or `inputs`. */
  arrayLength: number
  /** One input's declared unlockingScriptLength. */
  unlockingScriptLength: number
  /** All declared unlockingScriptLengths summed. */
  unlockingScriptLengthTotal: number
  /** One supplied unlocking script (createAction input, or a signAction spend). */
  unlockingScript: number
  /** createAction inputBEEF. */
  inputBEEF: number
  /** internalizeAction tx (AtomicBEEF). */
  internalizeTx: number
  /** One output's customInstructions string. */
  customInstructions: number
}

const MB = 1024 * 1024

const BASE: WalletArgLimits = {
  aggregate: 4 * MB,
  outputScript: 100_000,
  outputScriptTotal: 500_000,
  arrayLength: 1000,
  unlockingScriptLength: 100_000,
  unlockingScriptLengthTotal: 500_000,
  unlockingScript: 100_000,
  inputBEEF: 2 * MB,
  internalizeTx: 1 * MB,
  customInstructions: 4096
}

/**
 * Limits for a device tier.
 *
 * `low` is under 3.5 GB of RAM (see utils/deviceTier.ts), where the app has
 * already been process-terminated for memory it considered normal — so the
 * aggregate is halved. The per-field limits do not change: they are sized to
 * observed traffic, not to the memory budget.
 */
export function limitsForTier(tier: DeviceTier): WalletArgLimits {
  return tier === 'low' ? { ...BASE, aggregate: BASE.aggregate / 2 } : { ...BASE }
}

export interface ArgRefusal {
  field: string
  limit: number
  actual: number
  message: string
}

/** Calls that can carry transaction bytes. Everything else passes untouched. */
const SIZED_CALLS = new Set(['createAction', 'signAction', 'internalizeAction'])

const refuse = (field: string, actual: number, limit: number, why?: string): ArgRefusal => ({
  field,
  limit,
  actual,
  message: why ?? `The ${field} parameter must be at most ${limit} bytes (got ${actual})`
})

/** Bytes represented by a hex string, or 0 for anything that is not one. */
const hexBytes = (v: unknown): number => (typeof v === 'string' ? Math.floor(v.length / 2) : 0)

const arrayBytes = (v: unknown): number => (Array.isArray(v) ? v.length : 0)

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v != null && typeof v === 'object' ? (v as Record<string, unknown>) : null

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/**
 * A locking script beginning with 0xff is refused outright.
 *
 * OP_INVALIDOPCODE makes the output provably unspendable, so no legitimate
 * caller wants one. Cheap to refuse, and nothing is lost.
 */
const startsWithInvalidOpcode = (script: unknown): boolean =>
  typeof script === 'string' && /^ff/i.test(script.trim())

/**
 * Check one call's arguments against the limits.
 *
 * Returns the first violation, or null when the call is acceptable. Never
 * throws: it runs on untrusted page input, and a thrown TypeError here would
 * surface as an opaque wallet error instead of a size refusal.
 */
export function checkWalletArgs(call: string, args: unknown, limits: WalletArgLimits): ArgRefusal | null {
  if (!SIZED_CALLS.has(call)) return null
  const a = asRecord(args)
  if (!a) return null

  try {
    let total = 0

    // ── internalizeAction ──
    if (call === 'internalizeAction') {
      const tx = arrayBytes(a.tx)
      if (tx > limits.internalizeTx) return refuse('tx', tx, limits.internalizeTx)
      total += tx
    }

    // ── signAction spends ──
    if (call === 'signAction') {
      const spends = asRecord(a.spends)
      if (spends) {
        for (const [index, spend] of Object.entries(spends)) {
          const s = asRecord(spend)
          const bytes = hexBytes(s?.unlockingScript)
          if (bytes > limits.unlockingScript) {
            return refuse(`spends[${index}].unlockingScript`, bytes, limits.unlockingScript)
          }
          total += bytes
        }
      }
    }

    // ── createAction ──
    if (call === 'createAction') {
      const beef = arrayBytes(a.inputBEEF)
      if (beef > limits.inputBEEF) return refuse('inputBEEF', beef, limits.inputBEEF)
      total += beef

      const outputs = asArray(a.outputs)
      if (outputs.length > limits.arrayLength) {
        return refuse('outputs.length', outputs.length, limits.arrayLength)
      }
      let scriptTotal = 0
      for (let i = 0; i < outputs.length; i++) {
        const o = asRecord(outputs[i])
        if (!o) continue
        if (startsWithInvalidOpcode(o.lockingScript)) {
          return refuse(
            `outputs[${i}].lockingScript`,
            hexBytes(o.lockingScript),
            limits.outputScript,
            `The outputs[${i}].lockingScript parameter must not begin with 0xff: OP_INVALIDOPCODE makes the ` +
              'output unspendable'
          )
        }
        const bytes = hexBytes(o.lockingScript)
        if (bytes > limits.outputScript) {
          return refuse(`outputs[${i}].lockingScript`, bytes, limits.outputScript)
        }
        const ci = typeof o.customInstructions === 'string' ? o.customInstructions.length : 0
        if (ci > limits.customInstructions) {
          return refuse(`outputs[${i}].customInstructions`, ci, limits.customInstructions)
        }
        scriptTotal += bytes
        total += bytes + ci
      }
      if (scriptTotal > limits.outputScriptTotal) {
        return refuse('outputs.lockingScript', scriptTotal, limits.outputScriptTotal)
      }

      const inputs = asArray(a.inputs)
      if (inputs.length > limits.arrayLength) {
        return refuse('inputs.length', inputs.length, limits.arrayLength)
      }
      let declaredTotal = 0
      for (let i = 0; i < inputs.length; i++) {
        const inp = asRecord(inputs[i])
        if (!inp) continue
        // The declared length needs its own cap: the SDK only cross-checks it
        // against a supplied unlockingScript and never bounds it, so a tiny
        // payload can still make the wallet fund and build a ~1 MB-per-input
        // transaction. This is the one limit a byte total cannot substitute for.
        const declared = typeof inp.unlockingScriptLength === 'number' ? inp.unlockingScriptLength : 0
        if (declared > limits.unlockingScriptLength) {
          return refuse(`inputs[${i}].unlockingScriptLength`, declared, limits.unlockingScriptLength)
        }
        declaredTotal += declared

        const supplied = hexBytes(inp.unlockingScript)
        if (supplied > limits.unlockingScript) {
          return refuse(`inputs[${i}].unlockingScript`, supplied, limits.unlockingScript)
        }
        total += supplied
      }
      if (declaredTotal > limits.unlockingScriptLengthTotal) {
        return refuse('inputs.unlockingScriptLength', declaredTotal, limits.unlockingScriptLengthTotal)
      }
    }

    if (total > limits.aggregate) return refuse('aggregate', total, limits.aggregate)
    return null
  } catch {
    // Untrusted input must never turn a size check into a crash. Failing open
    // is correct here: the per-field caps below the app layer still apply, and a
    // shape this function cannot walk is not a shape that carries megabytes.
    return null
  }
}
