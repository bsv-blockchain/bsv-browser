import { File, Directory, Paths } from 'expo-file-system'
import { shareAsync } from 'expo-sharing'

const DOWNLOADS_DIR = 'downloads'

function deriveFilename(url?: string, suggestedName?: string, mimeType?: string): string {
  if (suggestedName) return suggestedName

  if (url) {
    try {
      const pathname = new URL(url).pathname
      const lastSegment = pathname.split('/').pop()
      if (lastSegment && lastSegment.includes('.')) return decodeURIComponent(lastSegment)
    } catch {}
  }

  const extMap: Record<string, string> = {
    'application/pdf': 'download.pdf',
    'image/png': 'download.png',
    'image/jpeg': 'download.jpg',
    'image/gif': 'download.gif',
    'image/webp': 'download.webp',
    'image/svg+xml': 'download.svg',
    'text/csv': 'download.csv',
    'text/plain': 'download.txt',
    'text/html': 'download.html',
    'application/json': 'download.json',
    'application/zip': 'download.zip',
    'application/x-tar': 'download.tar',
    'application/gzip': 'download.gz',
    'audio/mpeg': 'download.mp3',
    'video/mp4': 'download.mp4',
    'application/octet-stream': 'download.bin',
  }

  if (mimeType && extMap[mimeType]) return extMap[mimeType]

  return 'download'
}

function getDownloadsDir(): Directory {
  return new Directory(Paths.cache, DOWNLOADS_DIR)
}

export function cleanupDownloadsCache(): void {
  try {
    const dir = getDownloadsDir()
    if (dir.exists) dir.delete()
  } catch {}
}

export async function handleUrlDownload(
  url: string,
  mimeType?: string,
  filename?: string
): Promise<void> {
  const dir = getDownloadsDir()
  if (!dir.exists) dir.create({ intermediates: true })

  const name = deriveFilename(url, filename, mimeType)

  try {
    const dest = new File(dir, name)
    const file = await File.downloadFileAsync(url, dest, { idempotent: true })
    await shareAsync(file.uri, {
      mimeType: mimeType || undefined,
      dialogTitle: name,
    })
    try { file.delete() } catch {}
  } catch (e) {
    console.warn('[Download] URL download failed:', e)
  }
}

export async function handleBase64Download(
  base64: string,
  mimeType: string,
  filename?: string
): Promise<void> {
  const dir = getDownloadsDir()
  if (!dir.exists) dir.create({ intermediates: true })

  const name = deriveFilename(undefined, filename, mimeType)
  const file = new File(dir, name)

  try {
    file.create({ overwrite: true })
    file.write(base64, { encoding: 'base64' })
    await shareAsync(file.uri, {
      mimeType,
      dialogTitle: name,
    })
    try { file.delete() } catch {}
  } catch (e) {
    console.warn('[Download] Base64 download failed:', e)
  }
}
