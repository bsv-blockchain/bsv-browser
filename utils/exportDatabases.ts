import { File, Directory, Paths } from 'expo-file-system'
import { shareAsync } from 'expo-sharing'
import { Platform } from 'react-native'
import type { StorageExpoSQLite } from '@/storage'

/**
 * Finds all wallet SQLite database files on the device, copies them into a
 * single temporary folder, and presents one share dialogue for that folder.
 * Returns the number of database files found.
 *
 * On Android, uses serializeAsync to avoid file-system permission issues when
 * reading from the native database directory.
 */
export async function exportAllWalletDatabases(storage: StorageExpoSQLite | null): Promise<number> {
  if (Platform.OS === 'android') {
    return exportAndroid(storage)
  }

  // iOS: find all wallet db files on disk and share the folder in one dialogue.
  let sqliteDir: Directory
  if (storage?.db?.databasePath) {
    const dbPath = storage.db.databasePath
    const dirPath = dbPath.substring(0, dbPath.lastIndexOf('/'))
    sqliteDir = new Directory(dirPath)
  } else {
    sqliteDir = new Directory(Paths.document, 'SQLite')
  }

  if (!sqliteDir.exists) return 0

  const walletDbs = sqliteDir.list()

  if (walletDbs.length === 0) return 0

  const tempDir = new Directory(Paths.cache, 'bsv-wallet-export')
  if (tempDir.exists) tempDir.delete()
  tempDir.create({ intermediates: true })

  try {
    for (const dbFile of walletDbs) {
      dbFile.copy(new File(tempDir, dbFile.name))
    }
    await shareAsync(tempDir.uri, { dialogTitle: 'bsv-wallet-export' })
  } finally {
    try { tempDir.delete() } catch {}
  }

  return walletDbs.length
}

async function exportAndroid(storage: StorageExpoSQLite | null): Promise<number> {
  if (!storage?.db) return 0

  const dbName = storage.dbName
  const tempDir = new Directory(Paths.cache, 'bsv-wallet-export')
  if (tempDir.exists) tempDir.delete()
  tempDir.create({ intermediates: true })

  try {
    // serializeAsync dumps the live database to bytes — no file-system
    // permission issues accessing the native database directory.
    const bytes = await storage.db.serializeAsync()
    const outFile = new File(tempDir, dbName)
    outFile.write(bytes)

    await shareAsync(outFile.uri, {
      mimeType: 'application/octet-stream',
      dialogTitle: dbName,
    })
  } finally {
    try { tempDir.delete() } catch {}
  }

  return 1
}
