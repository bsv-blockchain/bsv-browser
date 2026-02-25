interface FetchManifestParams {
  domain: string
}

export default async function fetchManifest({ domain }: FetchManifestParams): Promise<any | undefined> {
  try {
    // Remove any protocol prefixes (even if duplicated)
    const cleanDomain = domain.replace(/^(https?:\/\/)+/, '')

    // Decide protocol: use 'http' for localhost, otherwise default to 'https'
    const protocol = cleanDomain.startsWith('localhost:') ? 'http' : 'https'

    // Construct the final URL with the cleaned domain
    const url = `${protocol}://${cleanDomain}/manifest.json`
    return new Promise(async r => {
      try {
        setTimeout(() => {
          r({})
        }, 800)
        const response = await fetch(url)
        if (!response.ok) {
          r({})
          return
        }
        const json = await response.json()
        r(json)
      } catch {
        r({})
        return
      }
    })
  } catch {
    // Ignore the error as it's not our problem
    return {}
  }
}
