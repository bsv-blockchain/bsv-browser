import React from 'react'
import { Text, View } from 'react-native'
import { render, screen } from '@testing-library/react-native'

describe('render sanity', () => {
  it('renders a Text inside a View', () => {
    render(
      <View>
        <Text>Hello BSV</Text>
      </View>
    )
    expect(screen.getByText('Hello BSV')).toBeTruthy()
  })
})
