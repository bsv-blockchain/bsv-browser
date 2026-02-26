import React from 'react'
import { Modal, View, Text, TouchableOpacity, StyleSheet } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from '@/context/theme/ThemeContext'

interface Web3BenefitsModalProps {
  visible: boolean
  onDismiss: () => void
  onContinueWithoutLogin: () => void
  onGoToLogin: () => void
}

const Web3BenefitsModal: React.FC<Web3BenefitsModalProps> = ({
  visible,
  onDismiss,
  onContinueWithoutLogin,
  onGoToLogin
}) => {
  const { colors } = useTheme()

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onDismiss}>
      <View style={styles.modalContainer}>
        <View style={[styles.modalContent, { backgroundColor: colors.background }]}>
          {/* Header */}
          <View style={styles.header}>
            <Text style={[styles.title, { color: colors.textPrimary }]}>Are you sure?</Text>
            <TouchableOpacity onPress={onDismiss} style={styles.closeButton}>
              <Ionicons name="close" size={24} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          {/* Content - Simple approach */}
          <View style={{ padding: 20 }}>
            <Text style={[{ fontSize: 16, marginBottom: 16, color: colors.textPrimary }]}>
              A Web3 identity brings you:
            </Text>

            <Text style={[{ fontSize: 16, fontWeight: 'bold', color: colors.textPrimary }]}>Micropayments</Text>
            <Text style={[{ fontSize: 14, lineHeight: 20, marginBottom: 8, color: colors.textPrimary }]}>
              where creators to earn directly.
            </Text>
            <Text style={[{ fontSize: 16, fontWeight: 'bold', color: colors.textPrimary }]}>Private Identity</Text>
            <Text style={[{ fontSize: 14, lineHeight: 20, marginBottom: 8, color: colors.textPrimary }]}>
              with mutual auth means no signups or logins.
            </Text>
            <Text style={[{ fontSize: 16, fontWeight: 'bold', color: colors.textPrimary }]}>Data Sovereignty</Text>
            <Text style={[{ fontSize: 14, lineHeight: 20, marginBottom: 8, color: colors.textPrimary }]}>
             you&apos;re in control, with no 3rd party tracking.
            </Text>
          </View>

          <Text style={[{ padding: 20, fontSize: 16, fontWeight: 'bold', color: colors.textPrimary }]}>Become an early adopter and lead your peers to the future of everything.</Text>

          {/* Action Buttons */}
          <View style={styles.buttonContainer}>
            <TouchableOpacity style={[styles.primaryButton, { backgroundColor: colors.primary }]} onPress={onGoToLogin}>
              <Text style={[styles.primaryButtonText, { color: colors.buttonText }]}>
                Get Started
              </Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.secondaryButton} onPress={onContinueWithoutLogin}>
              <Text style={[styles.secondaryButtonText, { color: colors.textPrimary }]}>Maybe Later</Text>
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
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20
  },
  modalContent: {
    width: '100%',
    maxWidth: 350,
    borderRadius: 20,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 10
    },
    shadowOpacity: 0.3,
    shadowRadius: 20,
    elevation: 10
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 20,
    paddingBottom: 10
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    flex: 1
  },
  closeButton: {
    padding: 5
  },
  buttonContainer: {
    padding: 20,
    paddingTop: 10
  },
  primaryButton: {
    paddingVertical: 16,
    paddingHorizontal: 24,
    borderRadius: 12,
    alignItems: 'center',
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 2
    },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3
  },
  primaryButtonText: {
    fontSize: 16,
    fontWeight: '600'
  },
  secondaryButton: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    alignItems: 'center',
    alignSelf: 'center',
    marginTop: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#666'
  },
  secondaryButtonText: {
    fontSize: 14,
    fontWeight: '300',
    opacity: 0.5
  }
})

export default Web3BenefitsModal
