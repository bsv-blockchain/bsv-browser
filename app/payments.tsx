/**
 * Retired route. Everything this screen did now lives in /pay → Pay → a handle.
 *
 * The file stays as a redirect because `peerpay:` deep links from before this
 * change — and anything a user has bookmarked — still target it. The target is
 * computed by legacyRedirectTarget so the mapping is tested in one place.
 */
import { Redirect, useLocalSearchParams } from 'expo-router'
import { legacyRedirectTarget } from '@/utils/pay/rails'

export default function RetiredPaymentsRoute() {
  const params = useLocalSearchParams<Record<string, string | string[]>>()
  const flat = Object.fromEntries(
    Object.entries(params).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])
  ) as Record<string, string | undefined>
  return <Redirect href={legacyRedirectTarget('payments', flat)} />
}
