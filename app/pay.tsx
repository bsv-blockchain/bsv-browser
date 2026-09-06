import { PayScreen } from '@bsv/expo-wallet-toolbox/ui'

/**
 * `dismissTo` defaults to '/' upstream, which is the wallet home in a
 * wallet-first host. Here '/' is the Browser, so a completed payment would drop
 * the user out of the wallet into a tab.
 */
export default function Pay() {
  return <PayScreen dismissTo="/wallet" />
}
