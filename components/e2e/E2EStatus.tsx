import React, { useEffect, useState } from 'react'
import { Text } from 'react-native'
import { e2eStatusTestId } from '@/utils/e2e/policy'
import { getE2EStatus, subscribeE2EStatus } from '@/utils/e2e/status'

/**
 * Small status label for Maestro. Rendered only from the e2e build.
 * `testID` changes with the status so a flow can wait on a specific id
 * (`e2e-status-page-home`) without parsing WebView contents.
 */
export function E2EStatus() {
  const [status, setStatus] = useState(getE2EStatus)

  useEffect(() => subscribeE2EStatus(setStatus), [])

  useEffect(() => {
    // LanguageProvider's own effect may set the device language first
    // (child effects run before parent effects). Re-assert English after that.
    const timer = setTimeout(() => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const i18nModule = require('@bsv/expo-wallet-toolbox/core/i18n/translations')
        const i18n = i18nModule.default ?? i18nModule
        if (i18n && typeof i18n.changeLanguage === 'function') void i18n.changeLanguage('en')
      } catch {
        // The fixture flows also set the emulator locale to en-US.
      }
    }, 0)
    return () => clearTimeout(timer)
  }, [])

  return (
    <Text
      testID={e2eStatusTestId(status)}
      accessibilityLabel={status}
      pointerEvents="none"
      importantForAccessibility="yes"
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: 12,
        height: 12,
        fontSize: 4,
        color: '#111',
        zIndex: 100000
      }}
    >
      {status}
    </Text>
  )
}
