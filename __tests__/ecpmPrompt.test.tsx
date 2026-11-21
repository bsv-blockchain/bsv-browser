jest.mock('@bsv/expo-wallet-toolbox/core/theme/ThemeContext', () => ({ useTheme: () => ({ colors: { backgroundSecondary: '#fff', textPrimary: '#111' } }) }))
import React from 'react'
import { fireEvent, render } from '@testing-library/react-native'
import { Modal } from 'react-native'
jest.mock('@bsv/ecpm-permission-module', () => ({ createEcpmModule: jest.fn() }), { virtual: true })
import { EcpmPrompt } from '../ecpm/EcpmPrompt'
import type { EcpmSession } from '../ecpm/ecpmSession'

function prompt() {
  const answer = jest.fn()
  const pending = { request: {
    originator: 'game.example', logicalProtocolID: 'mental poker deal',
    securityLevel: 2, keyID: 'deck', counterparty: 'self',
    operation: 'apply', point: '02' + '11'.repeat(32),
    privileged: true, privilegedReason: 'Protected shuffle'
  }, answer }
  const session = { getSnapshot: () => pending, subscribe: () => () => {} } as unknown as EcpmSession
  return { answer, session }
}

test('native consent displays the scope and forwards an explicit approval', () => {
  const { answer, session } = prompt()
  const view = render(<EcpmPrompt session={session} />)
  expect(view.getByText(/Application: game.example/)).toBeTruthy()
  expect(view.getByText(/all key IDs/)).toBeTruthy()
  expect(view.getByText(/Reason: Protected shuffle/)).toBeTruthy()
  fireEvent.press(view.getByText('Allow for five minutes'))
  expect(answer).toHaveBeenCalledWith(true)
})

test('deny and native back dismissal fail closed', () => {
  const { answer, session } = prompt()
  const view = render(<EcpmPrompt session={session} />)
  fireEvent.press(view.getByText('Don’t allow'))
  expect(answer).toHaveBeenLastCalledWith(false)
  fireEvent(view.UNSAFE_getByType(Modal), 'requestClose')
  expect(answer).toHaveBeenLastCalledWith(false)
})
