import React, { useState, useRef } from 'react'
import { WalletContextProvider } from '@bsv/expo-wallet-toolbox/core/context/WalletContext'
import type { WalletPermissionsManager } from '@bsv/wallet-toolbox-mobile'
import { EcpmSession, type EcpmWallet } from './ecpmSession'
import { EcpmPrompt } from './EcpmPrompt'

/** Stable host adapter: the toolbox calls dispose before every session transition. */
export function EcpmWalletProvider(props: React.ComponentProps<typeof WalletContextProvider>) {
  const permissions = useRef<WalletPermissionsManager | null>(null)
  const [session] = useState(() => new EcpmSession(() => permissions.current))
  const [host] = useState(() => ({
    create: (wallet: EcpmWallet) => ({ ecpm: session.replace(wallet) }),
    ready: (manager: WalletPermissionsManager) => { permissions.current = manager },
    dispose: () => { session.dispose(); permissions.current = null }
  }))
  return <WalletContextProvider {...props} permissionModuleHost={host}>
    <EcpmPrompt session={session} />
    {props.children}
  </WalletContextProvider>
}
