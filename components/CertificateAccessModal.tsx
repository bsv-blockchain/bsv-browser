import React, { useContext } from 'react'
import { View, Text, StyleSheet, Modal, TouchableOpacity, ScrollView } from 'react-native'
import { WalletContext } from '../context/WalletContext'
import { UserContext } from '../context/UserContext'
import { useThemeStyles } from '../context/theme/useThemeStyles'
import AppChip from './AppChip'
import { deterministicColor } from '../utils/deterministicColor'

type CertificateAccessRequest = {
  requestID: string
  certificateType?: string
  fields?: any
  fieldsArray?: string[]
  verifierPublicKey?: string
  originator: string
  description?: string
  renewal?: boolean
}

const CertificateAccessModal = () => {
  const { certificateRequests, advanceCertificateQueue, managers } = useContext(WalletContext)
  const { certificateAccessModalOpen, setCertificateAccessModalOpen } = useContext(UserContext)
  const themeStyles = useThemeStyles()

  // Handle denying the top request in the queue
  const handleDeny = async () => {
    if (certificateRequests.length > 0) {
      managers.permissionsManager?.denyPermission(certificateRequests[0].requestID)
    }
    advanceCertificateQueue()
    setCertificateAccessModalOpen(false)
  }

  // Handle granting the top request in the queue
  const handleGrant = async () => {
    if (certificateRequests.length > 0) {
      managers.permissionsManager?.grantPermission({
        requestID: certificateRequests[0].requestID
      })
    }
    advanceCertificateQueue()
    setCertificateAccessModalOpen(false)
  }

  if (!certificateAccessModalOpen || !certificateRequests.length) return null

  const { originator, verifierPublicKey, certificateType, fieldsArray, description, renewal } =
    certificateRequests[0] as CertificateAccessRequest

  return (
    <Modal visible={certificateAccessModalOpen} animationType="fade" transparent={true} onRequestClose={handleDeny}>
      <View style={[styles.modalContainer, { backgroundColor: 'rgba(0, 0, 0, 0.69)' }]}>
        <View style={[styles.modalContent, themeStyles.card]}>
          <ScrollView>
            {/* Title */}
            <Text style={[styles.title, themeStyles.text]}>
              {renewal ? 'Certificate Access Renewal' : 'Certificate Access Request'}
            </Text>

            {/* App section */}
            <View style={styles.infoRow}>
              <Text style={[styles.label, themeStyles.text]}>Application:</Text>
              <Text style={[styles.value, themeStyles.text]}>{originator || 'unknown'}</Text>
            </View>

            <View style={styles.divider} />

            {/* Certificate Type */}
            {certificateType && (
              <View style={styles.infoRow}>
                <Text style={[styles.label, themeStyles.text]}>Type:</Text>
                <Text style={[styles.value, themeStyles.text]}>{certificateType}</Text>
              </View>
            )}

            {/* Verifier */}
            {verifierPublicKey && (
              <View style={styles.infoRow}>
                <Text style={[styles.label, themeStyles.text]}>Verifier:</Text>
                <Text style={[styles.value, themeStyles.text]} numberOfLines={1}>
                  {verifierPublicKey}
                </Text>
              </View>
            )}

            {/* Fields */}
            {fieldsArray && fieldsArray.length > 0 && (
              <>
                <View style={styles.divider} />
                <Text style={[styles.sectionTitle, themeStyles.text]}>Required Fields:</Text>
                {fieldsArray.map((field, index) => (
                  <Text key={index} style={[styles.fieldItem, themeStyles.text]}>
                    • {field}
                  </Text>
                ))}
              </>
            )}

            {/* Description */}
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
                { backgroundColor: deterministicColor(JSON.stringify(certificateRequests[0])) }
              ]}
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
    backgroundColor: 'rgba(0, 0, 0, 0.5)'
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
  sectionTitle: {
    fontWeight: 'bold',
    marginBottom: 10
  },
  fieldItem: {
    marginLeft: 10,
    marginBottom: 5
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
    borderRadius: 8,
    marginHorizontal: 5
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

export default CertificateAccessModal
