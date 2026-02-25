import React, { createContext, useCallback, useContext, useState, useRef } from 'react'

/**
 * Sheet routes for the unified bottom sheet system.
 * Replaces 8+ boolean drawer states from the old Browser component.
 */
export type SheetRoute =
  | 'closed'
  | 'bookmarks'
  | 'history'
  | 'menu'
  | 'settings'
  | 'identity'
  | 'trust'
  | 'permissions'
  | 'tabs'

export interface SheetContextType {
  route: SheetRoute
  params: Record<string, any>
  history: SheetRoute[]
  push: (route: SheetRoute, params?: Record<string, any>) => void
  pop: () => void
  close: () => void
  isOpen: boolean
}

const SheetContext = createContext<SheetContextType>({
  route: 'closed',
  params: {},
  history: [],
  push: () => {},
  pop: () => {},
  close: () => {},
  isOpen: false,
})

export const useSheet = () => useContext(SheetContext)

export const SheetProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [route, setRoute] = useState<SheetRoute>('closed')
  const [params, setParams] = useState<Record<string, any>>({})
  const [history, setHistory] = useState<SheetRoute[]>([])

  const push = useCallback((nextRoute: SheetRoute, nextParams?: Record<string, any>) => {
    setRoute(prev => {
      if (prev !== 'closed') {
        setHistory(h => [...h, prev])
      }
      return nextRoute
    })
    setParams(nextParams || {})
  }, [])

  const pop = useCallback(() => {
    setHistory(h => {
      const next = [...h]
      const prev = next.pop()
      setRoute(prev || 'closed')
      return next
    })
    setParams({})
  }, [])

  const close = useCallback(() => {
    setRoute('closed')
    setParams({})
    setHistory([])
  }, [])

  return (
    <SheetContext.Provider
      value={{
        route,
        params,
        history,
        push,
        pop,
        close,
        isOpen: route !== 'closed',
      }}
    >
      {children}
    </SheetContext.Provider>
  )
}
