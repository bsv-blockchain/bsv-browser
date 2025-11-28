/**
 * Global error handler for React Native
 * Catches unhandled errors and prevents app crashes in production
 */

import { ErrorUtils } from 'react-native'

let errorHandlerInstalled = false

/**
 * Install global error handler
 * This should be called as early as possible in the app lifecycle
 */
export function installGlobalErrorHandler() {
  if (errorHandlerInstalled) {
    console.log('[ErrorHandler] Already installed, skipping')
    return
  }

  console.log('[ErrorHandler] Installing global error handler')

  // Store the original error handler
  const originalHandler = ErrorUtils.getGlobalHandler()

  // Set our custom error handler
  ErrorUtils.setGlobalHandler((error: Error, isFatal?: boolean) => {
    console.error('[ErrorHandler] Caught error:', {
      message: error.message,
      stack: error.stack,
      isFatal,
      name: error.name
    })

    // Log additional context
    if (isFatal) {
      console.error('[ErrorHandler] FATAL ERROR - This would normally crash the app')
    }

    // In production, we want to prevent the app from crashing
    // But still log the error for debugging
    if (__DEV__) {
      // In development, show the red screen
      if (originalHandler) {
        originalHandler(error, isFatal)
      }
    } else {
      // In production, just log and continue
      console.error('[ErrorHandler] Production error suppressed to prevent crash')

      // You can send to error tracking service here
      // Example: Sentry.captureException(error)
    }
  })

  errorHandlerInstalled = true
  console.log('[ErrorHandler] Global error handler installed successfully')
}

/**
 * Install promise rejection handler
 * Catches unhandled promise rejections
 */
export function installPromiseRejectionHandler() {
  // @ts-ignore - global Promise rejection tracking
  if (typeof global.Promise !== 'undefined') {
    const originalRejectionTracking = global.Promise._unhandledRejectionFn

    // @ts-ignore
    global.Promise._unhandledRejectionFn = (reason: any) => {
      console.error('[ErrorHandler] Unhandled Promise Rejection:', reason)

      // Call original handler if it exists
      if (originalRejectionTracking) {
        originalRejectionTracking(reason)
      }
    }

    console.log('[ErrorHandler] Promise rejection handler installed')
  }
}

/**
 * Install all error handlers
 */
export function installErrorHandlers() {
  installGlobalErrorHandler()
  installPromiseRejectionHandler()
}
