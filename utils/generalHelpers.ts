import { kNEW_TAB_URL } from '@/shared/constants'

// Helper function to validate URL
export function isValidUrl(url: string): boolean {
  if (!url) return false
<<<<<<< HEAD

  // Handle UHRP protocol
  if (url.startsWith('uhrp://')) {
    return true
  }

  // Handle data URLs (base64 encoded content)
  if (url.startsWith('data:')) {
    return true
  }

=======
>>>>>>> dev
  try {
    new URL(url.startsWith('http') ? url : `https://${url}`)
    return url.startsWith('http://') || url.startsWith('https://') || url === kNEW_TAB_URL
  } catch {
    return false
  }
}
