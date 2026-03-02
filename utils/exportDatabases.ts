import { File, Directory, Paths } from 'expo-file-system'
import { shareAsync } from 'expo-sharing'
import { Platform } from 'react-native'
import type { StorageExpoSQLite } from '@/storage'

/**
 * Finds all wallet SQLite database files on the device, copies them into a
 * single temporary folder, and presents one share dialogue for that folder.
 * Returns the number of database files found.
 */
export async function exportAllWalletDatabases(storage: StorageExpoSQLite | null): Promise<number> {
  // Resolve the SQLite database directory from the open db path, or fall back
  // to the standard expo-sqlite location (Documents/SQLite on iOS).
  let sqliteDir: Directory
  if (storage?.db?.databasePath) {
    const dbPath = storage.db.databasePath
    const dirPath = dbPath.substring(0, dbPath.lastIndexOf('/'))
    sqliteDir = new Directory(dirPath)
  } else {
    sqliteDir = new Directory(Paths.document, 'SQLite')
  }

  if (!sqliteDir.exists) return 0

  // Filter for wallet database files matching the naming convention.
  const entries = sqliteDir.list()
  const walletDbs = entries.filter(
    (e): e is File => !(e instanceof Directory) && /^wallet-.+\.db$/.test(e.name)
  )

  if (walletDbs.length === 0) return 0

  // Live SQLite files may be held open, so we always copy before sharing.
  const tempDir = new Directory(Paths.cache, 'bsv-wallet-export')
  if (tempDir.exists) tempDir.delete()
  tempDir.create({ intermediates: true })

  try {
    for (const dbFile of walletDbs) {
      dbFile.copy(new File(tempDir, dbFile.name))
    }

    if (Platform.OS === 'ios') {
      // iOS: share the folder in one dialogue
      await shareAsync(tempDir.uri, { dialogTitle: 'bsv-wallet-export' })
    } else {
      // Android: share each file individually
      for (const dbFile of walletDbs) {
        await shareAsync(new File(tempDir, dbFile.name).uri, {
          mimeType: 'application/octet-stream',
          dialogTitle: dbFile.name,
        })
      }
    }
  } finally {
    try { tempDir.delete() } catch {}
  }

  return walletDbs.length
}
