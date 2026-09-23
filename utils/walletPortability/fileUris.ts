import { PortabilityError } from './schema'

/** Expo SQLite returns an absolute filesystem path on Android and a file URI
 * on iOS. Expo FileSystem requires a URI on both platforms. */
export function databaseDirectoryUri(directory: string): string {
  if (directory.startsWith('file:///')) return directory
  if (directory.startsWith('/')) return `file://${directory.split('/').map(encodeURIComponent).join('/')}`
  throw new PortabilityError('storage', 'invalid database directory')
}
