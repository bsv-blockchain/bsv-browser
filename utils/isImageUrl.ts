import { Image } from 'react-native'

export default async (url: string): Promise<boolean> => {
  try {
    await Image.prefetch(url)
    return true
  } catch {
    return false
  }
}
