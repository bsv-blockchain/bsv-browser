/**
 * Dev-only profiling controls. Imported for its side effect from app/_layout.tsx
 * in __DEV__. Adds entries to the expo-dev-client menu (shake the device, or
 * Cmd+D on iOS sim / Cmd+M on Android) so profiling data can be captured without
 * a JS REPL — everything prints to the Metro terminal.
 *
 * Also exposes the same helpers on globalThis for use from a JS debugger console.
 */
import { perf } from '@/utils/perf'
import { setLoggingEnabled, isLoggingEnabled, setForwardWebViewLogs } from '@/utils/logging'

if (__DEV__) {
  // globalThis fallbacks (callable from a connected JS debugger).
  const g = globalThis as any
  g.perf = perf
  g.setLoggingEnabled = setLoggingEnabled
  g.setForwardWebViewLogs = setForwardWebViewLogs

  // Register dev-menu buttons. Wrapped in a try/catch + dynamic require so a
  // production/headless context (no dev client) never breaks.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { registerDevMenuItems } = require('expo-dev-client')
    registerDevMenuItems([
      {
        name: '📊 Perf: dump summary',
        callback: () => perf.dump()
      },
      {
        name: '🧹 Perf: reset buffer',
        callback: () => {
          perf.reset()
          console.log('[perf] buffer reset — reproduce the slow action, then dump')
        }
      },
      {
        name: '🔇 Toggle app logging',
        callback: () => {
          const next = !isLoggingEnabled()
          setLoggingEnabled(next)
          console.log(`[log] app logging ${next ? 'ON' : 'OFF'}`)
        }
      }
    ]).catch((e: unknown) => console.log('[devMenu] registration failed:', e))
  } catch (e) {
    console.log('[devMenu] expo-dev-client unavailable:', e)
  }
}

export {}
