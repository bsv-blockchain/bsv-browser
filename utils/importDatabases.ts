import { File, Paths } from 'expo-file-system'
import { Platform, Alert } from 'react-native'
import * as DocumentPicker from 'expo-document-picker'
import * as SQLite from 'expo-sqlite'
import type { StorageExpoSQLite } from '@/storage'
import {
  parseDbFilename,
  getRegisteredDbs,
  registerDb,
  selectLatestDb,
  parseTimestampFromFilename
} from './walletDbRegistry'
import i18n from '@/context/i18n/translations'

export interface ImportResult {
  imported: boolean
  filename?: string
  keySuffix?: string
  chain?: string
}

/**
 * Let the user pick a wallet `.db` backup file and import it alongside any
 * existing databases.  The wallet context will use whichever database has the
 * highest timestamp in its filename.
 *
 * Platform handling:
 *   - Cross-platform: reads the picked file as bytes, deserializes into an
 *     in-memory SQLite DB, opens a new file-backed DB with the target name,
 *     then uses backupDatabaseAsync to copy the data across.  This avoids
 *     filesystem permission issues on Android.
 */
export async function importWalletDatabase(storage: StorageExpoSQLite | null): Promise<ImportResult> {
  // ── 1. Pick file ──────────────────────────────────────────────────────────
  const result = await DocumentPicker.getDocumentAsync({
    type: '*/*',
    copyToCacheDirectory: true
  })

  if (result.canceled || !result.assets?.length) {
    return { imported: false }
  }

  const asset = result.assets[0]
  const pickedName = asset.name

  // ── 2. Validate filename ──────────────────────────────────────────────────
  const parsed = parseDbFilename(pickedName)
  if (!parsed) {
    return new Promise(resolve => {
      Alert.alert(i18n.t('import_invalid_file'), i18n.t('import_invalid_file_detail'), [
        { text: i18n.t('done'), onPress: () => resolve({ imported: false }) }
      ])
    })
  }

  const { keySuffix, chain } = parsed

  // If the imported file has no timestamp (legacy format), assign the current
  // time so it gets a unique filename and participates in timestamp selection.
  let targetFilename: string
  if (parsed.timestamp === 0) {
    const ts = Math.floor(Date.now() / 1000)
    targetFilename = `wallet-${keySuffix}-${chain}net-${ts}.db`
  } else {
    targetFilename = pickedName
  }

  // ── 3. Check for conflicts ────────────────────────────────────────────────
  const existingDbs = await getRegisteredDbs(keySuffix, chain)
  const importTs = parseTimestampFromFilename(targetFilename)

  if (existingDbs.length > 0) {
    const currentBest = selectLatestDb(existingDbs)
    const currentBestTs = parseTimestampFromFilename(currentBest)

    if (currentBestTs >= importTs) {
      // Existing DB has a higher or equal timestamp — imported file will NOT
      // become the active database.
      const proceed = await new Promise<boolean>(resolve => {
        Alert.alert(i18n.t('import_conflict_title'), i18n.t('import_conflict_message'), [
          { text: i18n.t('cancel'), style: 'cancel', onPress: () => resolve(false) },
          { text: i18n.t('import_anyway'), onPress: () => resolve(true) }
        ])
      })
      if (!proceed) return { imported: false }
    } else {
      // Imported file will become the active database.
      const proceed = await new Promise<boolean>(resolve => {
        Alert.alert(i18n.t('import_confirm_title'), i18n.t('import_confirm_message'), [
          { text: i18n.t('cancel'), style: 'cancel', onPress: () => resolve(false) },
          { text: i18n.t('import_wallet_data'), onPress: () => resolve(true) }
        ])
      })
      if (!proceed) return { imported: false }
    }
  }

  // ── 4. Read bytes from picked file ────────────────────────────────────────
  const pickedFile = new File(asset.uri)
  let bytes: Uint8Array
  try {
    bytes = await pickedFile.bytes()
  } catch (e: any) {
    console.error('[importDatabases] Failed to read picked file:', e.message)
    Alert.alert(i18n.t('import_invalid_file'), e.message)
    return { imported: false }
  }

  // ── 5. Place the database via deserialize → backup ────────────────────────
  let sourceDb: SQLite.SQLiteDatabase | undefined
  let destDb: SQLite.SQLiteDatabase | undefined
  try {
    // Deserialize the imported bytes into an in-memory database
    sourceDb = await SQLite.deserializeDatabaseAsync(bytes)

    // Open (or create) a file-backed database with the target filename.
    // This places the file in the default expo-sqlite database directory.
    destDb = await SQLite.openDatabaseAsync(targetFilename)

    // Copy all data from the in-memory source into the file-backed dest
    await SQLite.backupDatabaseAsync({
      sourceDatabase: sourceDb,
      destDatabase: destDb
    })
  } catch (e: any) {
    console.error('[importDatabases] Failed to place database:', e.message)
    Alert.alert(i18n.t('import_invalid_file'), e.message)
    return { imported: false }
  } finally {
    try {
      await sourceDb?.closeAsync()
    } catch {}
    try {
      await destDb?.closeAsync()
    } catch {}
  }

  // ── 6. Register in the wallet DB registry ─────────────────────────────────
  await registerDb(keySuffix, chain, targetFilename)

  return { imported: true, filename: targetFilename, keySuffix, chain }
}
