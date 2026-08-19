/**
 * Erasure on request — the GDPR Article 17 path for the encrypted backup log.
 *
 * Three steps, in this order, and the order is the correctness argument:
 *
 *  1. **Opt out of pushing.** Written FIRST. The monitor can run a push pass at any moment,
 *     so with the opt-out written afterwards a pass landing between the delete and the flag
 *     would append a fresh chunk — leaving wallet data on a server that has just reported a
 *     successful erasure. Doing it first closes that window entirely.
 *  2. **Delete server-side.** `DELETE /v1/account` removes every generation for this
 *     pseudonym across every device, ignoring the retention guard that `pruneGeneration`
 *     enforces. Errors propagate: a failed erasure must never be reported as done.
 *  3. **Clear local cursors.** Only on success. A cursor describing a log the server no
 *     longer holds would make a later append conflict against a head that does not exist;
 *     cleared, a re-enabled backup starts a fresh generation from a full snapshot.
 *
 * The opt-out deliberately SURVIVES a failed erasure. It was a deliberate act by someone who
 * wants their data gone, and silently resuming uploads because the delete failed is the
 * opposite of what they asked for.
 *
 * What this does not touch: the wallet itself. Coins, keys, recovery phrase and local
 * database are all untouched — this removes the server's copy only. The cost is that a new
 * device can no longer be fully restored, which is why the caller confirms first.
 */
import { BackupClient } from './client'
import { clearCursorsForPseudonym } from './cursor'
import { backupPseudonym } from './derive'
import { setBackupPushEnabled } from './preference'

export interface EraseDeps {
  /** The wallet's m/0'/0' key. Derives the pseudonym whose data is erased. */
  primaryKey: number[]
  /** Supply exactly one of these. */
  baseUrl?: string
  client?: BackupClient
}

export interface EraseResult {
  /** Blobs the server removed. Zero is a success: nothing was there. */
  deleted: number
}

export async function eraseRemoteBackup (deps: EraseDeps): Promise<EraseResult> {
  const client = resolveClient(deps)

  // Step 1 — before anything is deleted. See the module doc.
  await setBackupPushEnabled(false)

  // Step 2 — throws on any server refusal, leaving the local cursors intact.
  const { deleted } = await client.deleteAccount()

  // Step 3 — only now that the server really has nothing.
  await clearCursorsForPseudonym(backupPseudonym(deps.primaryKey))

  return { deleted }
}

function resolveClient (deps: EraseDeps): BackupClient {
  if (deps.client != null) return deps.client
  if (deps.baseUrl == null || deps.baseUrl === '') {
    throw new Error('eraseRemoteBackup requires either a client or a baseUrl')
  }
  return new BackupClient(deps.baseUrl, deps.primaryKey)
}
