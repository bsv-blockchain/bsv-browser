/**
 * The user's opt-out for pushing to the backup server.
 *
 * ON by default, and every ambiguous case resolves to ON: a missing key, an unreadable
 * store, an unrecognised value. Opting out is the only thing that turns pushing off, and it
 * writes 'false' explicitly — absence can never mean "off", because a wallet that quietly
 * stopped backing up (and only found out when it needed a restore) is exactly the outcome
 * the backup log exists to prevent.
 *
 * The opt-out stops pushing only. Restoring on a new device still works: a log already on
 * the server stays readable, and `restoreOnImport` never consults this.
 *
 * Not stored in wallet settings: those live in the wallet database, which is itself what
 * gets backed up, and the flag has to be readable by a push pass that runs before/without
 * the settings manager.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'

export const BACKUP_PUSH_ENABLED_KEY = 'backupPushEnabled'

/** True unless the user has explicitly opted out. Never throws. */
export async function isBackupPushEnabled (): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(BACKUP_PUSH_ENABLED_KEY)) !== 'false'
  } catch {
    // Fail towards backing up. The alternative silently abandons the user's history.
    return true
  }
}

export async function setBackupPushEnabled (enabled: boolean): Promise<void> {
  await AsyncStorage.setItem(BACKUP_PUSH_ENABLED_KEY, enabled ? 'true' : 'false')
}
