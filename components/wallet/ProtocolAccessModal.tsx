import React, { useContext } from 'react'
import { View, Text, StyleSheet, Modal } from 'react-native'
import { WalletContext } from '../../context/WalletContext'
import { UserContext } from '../../context/UserContext'
import { useThemeStyles } from '../../context/theme/useThemeStyles'
import { useTheme } from '../../context/theme/ThemeContext'
import { spacing, radii } from '../../context/theme/tokens'
import { deterministicColor } from '../../utils/deterministicColor'
import PressableScale from '../ui/PressableScale'
import { haptics } from '../../hooks/useHaptics'

const ProtocolAccessModal = () => {
  const { protocolRequests, advanceProtocolQueue, managers } = useContext(WalletContext)
  const { protocolAccessModalOpen, setProtocolAccessModalOpen } = useContext(UserContext)
  const themeStyles = useThemeStyles()
  const { colors } = useTheme()

  // Handle denying the top request in the queue
  const handleDeny = async () => {
    if (protocolRequests.length > 0) {
      try {
        await managers.permissionsManager?.denyPermission(protocolRequests[0].requestID)
      } catch {
        // User denial is expected - this is a normal user choice, not an error condition
        console.log('User denied protocol access')
      }
    }
    advanceProtocolQueue()
    setProtocolAccessModalOpen(false)
  }

  // Handle granting the top request in the queue
  const handleGrant = async () => {
    if (protocolRequests.length > 0) {
      managers.permissionsManager?.grantPermission({
        requestID: protocolRequests[0].requestID
      })
    }
    advanceProtocolQueue()
    setProtocolAccessModalOpen(false)
  }

  if (!protocolAccessModalOpen || !protocolRequests.length) return null

  const { protocolID, originator, description, renewal, protocolSecurityLevel } = protocolRequests[0]

  return (
    <Modal visible={protocolAccessModalOpen} animationType="fade" transparent={true} onRequestClose={handleDeny}>
      <View style={[styles.modalContainer, { backgroundColor: 'rgba(0, 0, 0, 0.69)' }]}>
        <View style={[styles.modalContent, themeStyles.card]}>
          {/* Title */}
          <Text style={[styles.title, themeStyles.text]}>
            {renewal ? 'Protocol Access Renewal' : 'Protocol Access Request'}
          </Text>

          {/* App section */}
          <View style={styles.infoRow}>
            <Text style={[styles.label, themeStyles.text]}>Application:</Text>
            <Text style={[styles.value, themeStyles.text]}>{originator || 'unknown'}</Text>
          </View>

          <View style={styles.divider} />

          {/* Protocol section */}
          <View style={styles.infoRow}>
            <Text style={[styles.label, themeStyles.text]}>Protocol ID:</Text>
            <Text style={[styles.value, themeStyles.text]} numberOfLines={1}>
              {protocolID}
            </Text>
          </View>

          <View style={styles.infoRow}>
            <Text style={[styles.label, themeStyles.text]}>Security Level:</Text>
            <Text style={[styles.value, themeStyles.text]}>{protocolSecurityLevel}</Text>
          </View>

          {/* Description section */}
          {description && (
            <>
              <View style={styles.divider} />
              <View style={styles.infoRow}>
                <Text style={[styles.label, themeStyles.text]}>Description:</Text>
                <Text style={[styles.value, themeStyles.text]}>{description}</Text>
              </View>
            </>
          )}

          {/* Visual signature */}
          <View
            style={[
              styles.visualSignature,
              { backgroundColor: deterministicColor(JSON.stringify(protocolRequests[0])) }
            ]}
          />

          {/* Action buttons */}
          <View style={styles.buttonContainer}>
            <PressableScale
              style={[styles.buttonDeny, { borderColor: colors.separator }]}
              onPress={() => { haptics.warning(); handleDeny() }}
            >
              <Text style={[styles.buttonDenyText, { color: colors.textSecondary }]}>Deny</Text>
            </PressableScale>
            <PressableScale
              style={[styles.buttonAllow, { backgroundColor: colors.accent }]}
              onPress={() => { haptics.confirm(); handleGrant() }}
            >
              <Text style={[styles.buttonAllowText, { color: colors.textOnAccent }]}>Grant Access</Text>
            </PressableScale>
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
    flexDirection: 'row',
    marginTop: 10,
    gap: spacing.md
  },
  buttonDeny: {
    flex: 1,
    minHeight: 44,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center'
  },
  buttonDenyText: {
    fontWeight: '600',
    fontSize: 17
  },
  buttonAllow: {
    flex: 1,
    minHeight: 44,
    borderRadius: radii.lg,
    alignItems: 'center',
    justifyContent: 'center'
  },
  buttonAllowText: {
    fontWeight: '600',
    fontSize: 17
  }
})

export default ProtocolAccessModal
