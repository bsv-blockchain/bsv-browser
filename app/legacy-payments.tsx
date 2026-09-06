/**
 * Retired route. Everything this screen did now lives in
 * /pay → Get paid → a conventional wallet.
 *
 * The file stays as a redirect so anything a user has bookmarked still lands
 * somewhere useful. The target is computed by legacyRedirectTarget so the
 * mapping is tested in one place.
 */
import { Redirect, useLocalSearchParams } from 'expo-router'
import { legacyRedirectTarget } from '@bsv/expo-wallet-toolbox/core/pay/rails'

export default function RetiredLegacyPaymentsRoute() {
  const params = useLocalSearchParams<Record<string, string | string[]>>()
  const flat = Object.fromEntries(
    Object.entries(params).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])
  ) as Record<string, string | undefined>
  return <Redirect href={legacyRedirectTarget('legacy-payments', flat)} />
}
