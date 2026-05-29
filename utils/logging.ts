let lastLogTime = performance.now()

// Detect truecolor support
const supportsTruecolor = process.env.COLORTERM === 'truecolor'

// Import logging configuration with error handling
let loggingConfig: { [file: string]: boolean } = { default: true }
try {
  loggingConfig = require('./logging.config').default || { default: true }
} catch (e) {
  console.warn('Failed to load logging.config.ts, using default settings:', e)
}

// ---------------------------------------------------------------------------
// Runtime master switch
// ---------------------------------------------------------------------------
// Raw console.log calls scattered through the app bypass loggingConfig entirely
// and flood the JS thread / bridge (a top cause of UI jank). This master switch
// gates the helpers below at runtime so all app logging can be silenced with one
// call — e.g. before profiling an interaction:  setLoggingEnabled(false)
//
// Defaults: on in dev, off in production.
let loggingEnabled = typeof __DEV__ !== 'undefined' ? __DEV__ : true

// Whether to forward web-page console.* messages from WebViews onto the RN JS
// thread. Off by default — this is one of the worst offenders for jank on chatty
// pages. Flip on only when actively debugging a specific site.
let forwardWebViewLogs = false

export const setLoggingEnabled = (enabled: boolean) => {
  loggingEnabled = enabled
}
export const isLoggingEnabled = () => loggingEnabled

export const setForwardWebViewLogs = (enabled: boolean) => {
  forwardWebViewLogs = enabled
}
export const shouldForwardWebViewLogs = () => forwardWebViewLogs

/**
 * Gated drop-in replacement for raw `console.log`. Use this in hot paths so the
 * master switch (and production builds) can silence the flood. Cheap when off:
 * it returns before touching its arguments.
 */
export const devLog = (...args: any[]) => {
  if (!loggingEnabled) return
  console.log(...args)
}

const colorize = (elapsed: number) => {
  if (elapsed > 1.0) {
    return supportsTruecolor
      ? `\x1b[38;2;255;0;0m` // red
      : `\x1b[31m` // ANSI red
  } else if (elapsed > 0.5) {
    return supportsTruecolor
      ? `\x1b[38;2;255;165;0m` // orange
      : `\x1b[33;1m` // bright yellow as orange
  } else if (elapsed > 0.3) {
    return supportsTruecolor
      ? `\x1b[38;2;255;255;0m` // yellow
      : `\x1b[33m` // ANSI yellow
  } else {
    return `\x1b[0m` // default
  }
}

export const logWithTimestamp = (file: string = 'unknown', message: string = 'No message', ...args: any[]) => {
  // Master runtime switch first (cheapest bail-out).
  if (!loggingEnabled) return
  // Check if logging is enabled for this file (fall back to default if not set)
  const isEnabled = loggingConfig[file] !== undefined ? loggingConfig[file] : loggingConfig['default']
  if (!isEnabled) return

  const now = performance.now()
  const elapsedSec = (now - lastLogTime) / 1000
  lastLogTime = now

  const timestamp = new Date().toISOString()
  const elapsed = elapsedSec.toFixed(3)
  const color = colorize(elapsedSec)

  console.log(`[${timestamp}] ${color}[${elapsed}s]\x1b[0m [${file}] ${message}`, ...args)
}
