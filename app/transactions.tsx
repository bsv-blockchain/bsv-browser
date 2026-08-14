/**
 * Legacy /transactions route.
 *
 * Activity now lives inline on the wallet screen, below the balance and the
 * three destinations, so checking whether a payment went through no longer
 * costs a separate navigation. This stub keeps existing links and any deep
 * links working by forwarding to /wallet.
 */
import { Redirect } from 'expo-router'

export default function TransactionsRedirect() {
  return <Redirect href="/wallet" />
}
