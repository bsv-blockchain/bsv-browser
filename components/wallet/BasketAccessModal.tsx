import React, { useContext } from 'react'
import { View, Text, StyleSheet, Modal, TouchableOpacity } from 'react-native'
import { WalletContext } from '../../context/WalletContext'
import { UserContext } from '../../context/UserContext'
import { useThemeStyles } from '../../context/theme/useThemeStyles'
import { deterministicColor } from '../../utils/deterministicColor'

const BasketAccessModal = () => {
  const { basketRequests, advanceBasketQueue, managers } = useContext(WalletContext)
  const { basketAccessModalOpen, setBasketAccessModalOpen } = useContext(UserContext)
  const themeStyles = useThemeStyles()

  // Handle denying the top request in the queue
  const handleDeny = async () => {
    if (basketRequests.length > 0) {
      try {
        await managers.permissionsManager?.denyPermission(basketRequests[0].requestID)
      } catch {
        // User denial is expected - this is a normal user choice, not an error condition
        console.log('User denied basket access')
      }
    }
    advanceBasketQueue()
    setBasketAccessModalOpen(false)
  }

  // Handle granting the top request in the queue
  const handleGrant = async () => {
    if (basketRequests.length > 0) {
      managers.permissionsManager?.grantPermission({
        requestID: basketRequests[0].requestID
      })
    }
    advanceBasketQueue()
    setBasketAccessModalOpen(false)
  }

  if (!basketAccessModalOpen || !basketRequests.length) return null

  const { basket, originator, reason, renewal } = basketRequests[0]

  return (
    <Modal visible={basketAccessModalOpen} animationType="slide" transparent={true} onRequestClose={handleDeny}>
      <View style={[styles.modalContainer, { backgroundColor: 'rgba(0, 0, 0, 0.5)' }]}>
        <View style={[styles.modalContent, themeStyles.card]}>
          {/* Title */}
          <Text style={[styles.title, themeStyles.text]}>
            {renewal ? 'Basket Access Renewal' : 'Basket Access Request'}
          </Text>

          {/* App section */}
          <View style={styles.infoRow}>
            <Text style={[styles.label, themeStyles.text]}>Application:</Text>
            <Text style={[styles.value, themeStyles.text]}>{originator || 'unknown'}</Text>
          </View>

          <View style={styles.divider} />

          {/* Basket section */}
          <View style={styles.infoRow}>
            <Text style={[styles.label, themeStyles.text]}>Basket:</Text>
            <Text style={[styles.value, themeStyles.text]} numberOfLines={1}>
              {basket}
            </Text>
          </View>

          {/* Reason section */}
          {reason && (
            <>
              <View style={styles.divider} />
              <View style={styles.infoRow}>
                <Text style={[styles.label, themeStyles.text]}>Reason:</Text>
                <Text style={[styles.value, themeStyles.text]}>{reason}</Text>
              </View>
            </>
          )}

          {/* Visual signature */}
          <View
            style={[styles.visualSignature, { backgroundColor: deterministicColor(JSON.stringify(basketRequests[0])) }]}
          />

          {/* Action buttons */}
          <View style={styles.buttonContainer}>
            <TouchableOpacity style={themeStyles.buttonSecondary} onPress={handleDeny}>
              <Text style={themeStyles.buttonSecondaryText}>Deny</Text>
            </TouchableOpacity>
            <TouchableOpacity style={themeStyles.button} onPress={handleGrant}>
              <Text style={themeStyles.buttonText}>Grant Access</Text>
            </TouchableOpacity>
          </View>
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
    backgroundColor: 'rgba(0, 0, 0, 0.5)'
  },
  modalContent: {
    width: '90%',
    maxWidth: 400,
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
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginVertical: 5
  },
  label: {
    fontWeight: 'bold',
    flex: 1
  },
  value: {
    flex: 2,
    textAlign: 'right'
  },
  visualSignature: {
    height: 4,
    width: '100%',
    marginVertical: 20,
    borderRadius: 2
  },
  buttonContainer: {
    flexDirection: 'column',
    justifyContent: 'space-between',
    marginTop: 10
  },
  button: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8
  },
  denyButton: {
    borderWidth: 1
  },
  grantButton: {},
  buttonText: {
    textAlign: 'center',
    fontWeight: '600'
  }
})

export default BasketAccessModal
