import { useState, useEffect, createContext, useContext, ReactNode } from 'react'

// Hard-code our known breakpoints:
type Breakpoint = 'xs' | 'sm' | 'md' | 'or'
type BreakpointMatches = Record<Breakpoint, boolean>

// Provide a default value matching our hard-coded breakpoints:
const defaultValue: BreakpointMatches = {
  xs: false,
  sm: false,
  md: false,
  or: false
}

// Create a context with our specific type:
const BreakpointContext = createContext<BreakpointMatches>(defaultValue)

// Define the provider’s props to require a "queries" object that maps our breakpoints to strings:
interface BreakpointProviderProps {
  children: ReactNode
  queries: Record<Breakpoint, string>
}

const BreakpointProvider: React.FC<BreakpointProviderProps> = ({ children, queries }) => {
  const [queryMatch, setQueryMatch] = useState<BreakpointMatches>(defaultValue)

  useEffect(() => {
    // Type the media query lists using our Breakpoint keys:
    const mediaQueryLists: Record<Breakpoint, MediaQueryList> = {} as any
    // Cast the keys from Object.keys:
    const keys = Object.keys(queries) as Breakpoint[]
    let isAttached = false
    const handleQueryListener = () => {
      const updatedMatches = keys.reduce((acc, media) => {
        acc[media] = !!(mediaQueryLists[media] && mediaQueryLists[media].matches)
        return acc
      }, {} as BreakpointMatches)
      setQueryMatch(updatedMatches)
    }
    if (window && window.matchMedia) {
      const matches = {} as BreakpointMatches
      keys.forEach(media => {
        if (typeof queries[media] === 'string') {
          mediaQueryLists[media] = window.matchMedia(queries[media])
          matches[media] = mediaQueryLists[media].matches
        } else {
          matches[media] = false
        }
      })
      setQueryMatch(matches)
      isAttached = true
      keys.forEach(media => {
        if (typeof queries[media] === 'string') {
          mediaQueryLists[media].addListener(handleQueryListener)
        }
      })
    }
    return () => {
      if (isAttached) {
        keys.forEach(media => {
          if (typeof queries[media] === 'string') {
            mediaQueryLists[media].removeListener(handleQueryListener)
          }
        })
      }
    }
  }, [queries])

  return <BreakpointContext.Provider value={queryMatch}>{children}</BreakpointContext.Provider>
}

const useBreakpoint = (): BreakpointMatches => {
  const context = useContext(BreakpointContext)
  return context
}

export { useBreakpoint, BreakpointProvider }
