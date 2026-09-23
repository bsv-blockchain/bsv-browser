import { useState } from 'react'

/** Resume a cold host at its live URL without reloading mounted SPA routes. */
export function useWebViewSource(commandUrl: string, currentUrl: string): string {
  const [source, setSource] = useState(() => ({ commandUrl, uri: currentUrl }))
  if (source.commandUrl !== commandUrl) {
    // Only an explicit navigation command changes an already-mounted source.
    setSource({ commandUrl, uri: commandUrl })
    return commandUrl
  }
  return source.uri
}
