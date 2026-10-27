import React, { useState } from 'react'
import { WalletContextProvider } from '@bsv/expo-wallet-toolbox/core/context/WalletContext'
import { EcpmSession, type EcpmWallet } from './ecpmSession'
import { EcpmPrompt } from './EcpmPrompt'

/** Stable host adapter: the toolbox calls dispose before every session transition. */
export function EcpmWalletProvider(props: React.ComponentProps<typeof WalletContextProvider>) {
  const [session] = useState(() => new EcpmSession())
  const [host] = useState(() => ({
    create: (wallet: EcpmWallet) => ({ ecpm: session.replace(wallet) }),
    dispose: session.dispose
  }))
  return <WalletContextProvider {...props} permissionModuleHost={host}>
    <EcpmPrompt session={session} />
    {props.children}
  </WalletContextProvider>
}
