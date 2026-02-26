import React from 'react'
import { useBrowserMode } from '@/context/BrowserModeContext'
import Web3BenefitsModal from './Web3BenefitsModal'

const Web3BenefitsModalHandler: React.FC = () => {
  const { web3BenefitsVisible, hideWeb3Benefits, web3BenefitsCallbacks } = useBrowserMode()

  return (
    <Web3BenefitsModal
      visible={web3BenefitsVisible}
      onDismiss={hideWeb3Benefits}
      onContinueWithoutLogin={() => {
        hideWeb3Benefits()
        web3BenefitsCallbacks.onContinue?.()
      }}
      onGoToLogin={() => {
        hideWeb3Benefits()
        web3BenefitsCallbacks.onGoToLogin?.()
      }}
    />
  )
}

export default Web3BenefitsModalHandler
