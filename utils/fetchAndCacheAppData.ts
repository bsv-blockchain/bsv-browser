import isImageUrl from './isImageUrl'
import parseAppManifest from './parseAppManifest'

interface AppManifest {
  name?: string
  // Add other properties if needed
}

type SetStateString = React.Dispatch<React.SetStateAction<string>>

/**
 * Fetches and caches the favicon and manifest data for a given app domain.
 *
 * @param appDomain - The domain name of the app (e.g. "example.com").
 * @param setAppIcon - React setState function for updating the app icon URL.
 * @param setAppName - React setState function for updating the app name string.
 * @param DEFAULT_APP_ICON - A fallback icon URL to use if no valid favicon can be found.
 */
async function fetchAndCacheAppData(
  appDomain: string,
  setAppIcon: SetStateString,
  setAppName: SetStateString,
  DEFAULT_APP_ICON: string
): Promise<void> {
  // Try to load data from cache first
  // const cachedFavicon = window.localStorage.getItem(faviconKey);
  // const cachedManifest = window.localStorage.getItem(manifestKey);

  // if (cachedFavicon) {
  //   setAppIcon(cachedFavicon);
  // } else {
  // If no cache, default to fallback icon
  setAppIcon(DEFAULT_APP_ICON)
  // }

  // if (cachedManifest) {
  // setAppName(cachedManifest);
  // }

  // Always fetch the latest data
  try {
    const manifest: AppManifest | null = await parseAppManifest({ domain: appDomain })
    if (manifest) {
      const faviconUrl = appDomain.startsWith('http') ? appDomain : `https://${appDomain}/favicon.ico`
      const isValidImage = await isImageUrl(faviconUrl)

      if (isValidImage) {
        setAppIcon(faviconUrl)
        // window.localStorage.setItem(faviconKey, faviconUrl);
      } else {
        setAppIcon(DEFAULT_APP_ICON)
      }

      if (typeof manifest.name === 'string') {
        setAppName(manifest.name)
        // window.localStorage.setItem(manifestKey, manifest.name);
      }
    }
  } catch (error) {
    console.error(error)
  }
}

export default fetchAndCacheAppData
