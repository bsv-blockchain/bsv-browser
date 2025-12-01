import React, { useContext, useState, useEffect } from 'react'
import { View, Text, StyleSheet, Modal, TouchableOpacity, ScrollView } from 'react-native'
import { WalletContext } from '../context/WalletContext'
import { UserContext } from '../context/UserContext'
import { useThemeStyles } from '../context/theme/useThemeStyles'
import { useTheme } from '../context/theme/ThemeContext'
import AppChip from './AppChip'
import { deterministicColor } from '../utils/deterministicColor'
import AmountDisplay from './AmountDisplay'
import { ExchangeRateContext } from '../context/ExchangeRateContext'

const SpendingAuthorizationModal = () => {
  const { spendingRequests, advanceSpendingQueue, managers } = useContext(WalletContext)
  const { colors } = useTheme() // Import colors from theme

  const { spendingAuthorizationModalOpen, setSpendingAuthorizationModalOpen } = useContext(UserContext)
  const { satoshisPerUSD } = useContext(ExchangeRateContext)
  const themeStyles = useThemeStyles()

  // Handle denying the request
  const handleDeny = async () => {
    if (spendingRequests.length > 0) {
      managers.permissionsManager?.denyPermission(spendingRequests[0].requestID)
      advanceSpendingQueue()
    }
    // Close the modal
    setSpendingAuthorizationModalOpen(false)
  }

  // Handle granting the request
  const handleGrant = async ({ singular = true, amount }: { singular?: boolean; amount?: number }) => {
    if (spendingRequests.length > 0) {
      managers.permissionsManager?.grantPermission({
        requestID: spendingRequests[0].requestID,
        ephemeral: singular,
        amount
      })
      advanceSpendingQueue()
    }
    // Close the modal
    setSpendingAuthorizationModalOpen(false)
  }

  const determineUpgradeAmount = (previousAmountInSats: any, returnType = 'sats') => {
    let usdAmount
    const previousAmountInUsd = previousAmountInSats / satoshisPerUSD

    // The supported spending limits are $5, $10, $20, $50
    if (previousAmountInUsd <= 5) {
      usdAmount = 5
    } else if (previousAmountInUsd <= 10) {
      usdAmount = 10
    } else if (previousAmountInUsd <= 20) {
      usdAmount = 20
    } else {
      usdAmount = 50
    }

    if (returnType === 'sats') {
      return Math.round(usdAmount * satoshisPerUSD)
    }
    return usdAmount
  }

  // Use debug data for testing, otherwise check if we should display modal
  if (!spendingAuthorizationModalOpen || spendingRequests.length === 0) return null

  const {
    originator,
    description,
    transactionAmount,
    totalPastSpending,
    amountPreviouslyAuthorized,
    authorizationAmount,
    renewal,
    lineItems
  } = spendingRequests[0]

  const upgradeAmount = determineUpgradeAmount(amountPreviouslyAuthorized)

  return (
    <Modal visible={spendingAuthorizationModalOpen} transparent={true} animationType="fade">
      <View style={styles.modalContainer}>
        <View style={[styles.modalContent, { backgroundColor: colors.background }]}>
          <ScrollView>
            {/* App section */}
            <View style={styles.appRow}>
              <Text style={styles.origin}>{originator || 'unknown'}</Text>
            </View>
            <View style={styles.infoRow}>
              <Text style={[styles.label, themeStyles.text]}>{description || 'wants to spend'}</Text>
            </View>
            <View style={styles.costRow}>
              <Text style={[styles.value, themeStyles.text]}><AmountDisplay>{authorizationAmount}</AmountDisplay></Text>
            </View>

            {/* Action buttons */}
            <View style={styles.buttonContainer}>
              <TouchableOpacity style={styles.buttonSecondary} onPress={handleDeny}>
                <Text style={styles.buttonSecondaryText}>Deny</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.buttonPrimary}
                onPress={() => handleGrant({ singular: true, amount: authorizationAmount })}
              >
                <Text style={styles.buttonPrimaryText}>Approve</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  modalContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.69)'
  },
  modalContent: {
    width: '90%',
    maxWidth: 400,
    maxHeight: '80%',
    borderRadius: 12,
    padding: 20,
    elevation: 5
  },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
    marginBottom: 20,
    textAlign: 'center'
  },
  divider: {
    height: 1,
    backgroundColor: '#E0E0E0',
    marginVertical: 15
  },
  label: {
    flex: 1
  },
  value: {
    textAlign: 'right',
    fontWeight: 'bold'
  },
  amountContainer: {
    flex: 2,
    alignItems: 'flex-end'
  },
  subValue: {
    fontSize: 12,
    marginTop: 2
  },
  sectionTitle: {
    fontWeight: 'bold',
    marginBottom: 10
  },
  lineItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginVertical: 5,
    paddingHorizontal: 10
  },
  lineItemText: {
    flex: 1,
    marginRight: 10
  },
  visualSignature: {
    height: 4,
    width: '100%',
    marginVertical: 20,
    borderRadius: 2
  },
  origin: {
    fontSize: 20,
    fontWeight: 'bold',
    marginBottom: 10,
    textAlign: 'center',
    color: 'white'
  },
  buttonContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 10,
    gap: 40
  },
  buttonPrimaryText: {
    color: 'black',
    fontWeight: 'bold'
  },
  buttonPrimary: {
    flex: 1,
    backgroundColor: 'white',
    paddingVertical: 15,
    paddingHorizontal: 40,
    borderRadius: 10,
    alignItems: 'center',
    color: 'black'
  },
  buttonSecondary: {
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 8,
    borderColor: '#5d5d5dff',
    borderWidth: 1,
    alignItems: 'center'
  },
  buttonSecondaryText: {
    color: 'white',
    fontWeight: 'bold'
  },
  denyButton: {
    borderWidth: 1
  },
  grantButton: {},
  buttonText: {
    textAlign: 'center',
    fontWeight: '600',
    fontSize: 12
  },
  appRow: {
    width: '100%',
    alignItems: 'center',
    marginVertical: 5,
    marginBottom: 5
  },
  infoRow: {
    alignItems: 'center',
    marginVertical: 5,
  },
  costRow: {
    width: '100%',
    alignItems: 'center',
    marginTop: 5,
    marginBottom: 30
  }
})

export default SpendingAuthorizationModal
