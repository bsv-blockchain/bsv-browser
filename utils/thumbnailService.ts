import { RefObject } from 'react'
import { View } from 'react-native'
import { captureRef } from 'react-native-view-shot'
import { File, Directory, Paths } from 'expo-file-system'

const THUMBNAILS_DIR_NAME = 'tab-thumbnails'

function getThumbnailsDir(): Directory {
  const dir = new Directory(Paths.cache, THUMBNAILS_DIR_NAME)
  if (!dir.exists) dir.create()
  return dir
}

function getThumbnailFile(tabId: number): File {
  return new File(getThumbnailsDir(), `${tabId}.jpg`)
}

export async function captureThumbnail(
  viewRef: RefObject<View | null>,
  tabId: number
): Promise<string | null> {
  if (!viewRef.current) return null
  try {
    const tmpUri = await captureRef(viewRef, {
      format: 'jpg',
      quality: 0.6,
      width: 300,
      result: 'tmpfile',
    })
    const dest = getThumbnailFile(tabId)
    // Move temp file to our cache location
    const tmpFile = new File(tmpUri)
    if (dest.exists) dest.delete()
    tmpFile.move(dest)
    return dest.uri
  } catch (e) {
    console.warn('captureThumbnail failed:', e)
    return null
  }
}

export function deleteThumbnail(tabId: number): void {
  try {
    const file = getThumbnailFile(tabId)
    if (file.exists) file.delete()
  } catch (e) {
    console.warn('deleteThumbnail failed:', e)
  }
}

export function cleanupOrphanedThumbnails(activeTabIds: number[]): void {
  try {
    const dir = getThumbnailsDir()
    const activeSet = new Set(activeTabIds)
    for (const entry of dir.list()) {
      if (entry instanceof File && entry.name.endsWith('.jpg')) {
        const id = parseInt(entry.name.replace('.jpg', ''), 10)
        if (!Number.isNaN(id) && !activeSet.has(id)) {
          entry.delete()
        }
      }
    }
  } catch (e) {
    console.warn('cleanupOrphanedThumbnails failed:', e)
  }
}

export function thumbnailExists(uri: string | undefined): boolean {
  if (!uri) return false
  try {
    return new File(uri).exists
  } catch {
    return false
  }
}
