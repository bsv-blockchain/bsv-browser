import React, { useState, useEffect } from 'react'
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  TouchableWithoutFeedback,
  Keyboard,
  Share,
  Alert
} from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { Ionicons } from '@expo/vector-icons'
import { Utils } from '@bsv/sdk'
import { useWallet } from '@/context/WalletContext'
import { useTheme } from '@/context/theme/ThemeContext'

const RecoveryKeySaver = () => {
  // Theme hooks
  const { colors } = useTheme()

  // State management
  const [open, setOpen] = useState(false)
  const [recoveryKey, setRecoveryKey] = useState('')
  const [resolve, setResolve] = useState<Function>(() => {})
  const [reject, setReject] = useState<Function>(() => {})
  const [copied, setCopied] = useState(false)

  // Checkbox states
  const [affirmative1, setAffirmative1] = useState(false)
  const [affirmative2, setAffirmative2] = useState(false)
  const [affirmative3, setAffirmative3] = useState(false)

  const { managers, setRecoveryKeySaver } = useWallet()

  const isAllChecked = affirmative1 && affirmative2 && affirmative3

  useEffect(() => {
    setRecoveryKeySaver((): any => {
      return (key: number[]): Promise<true> => {
        return new Promise((resolve, reject) => {
          const keyAsStr = Utils.toBase64(key)
          setResolve(() => {
            return resolve
          })
          setReject(() => {
            return reject
          })
          setRecoveryKey(keyAsStr)
          setOpen(true)
        })
      }
    })
  }, [managers, setRecoveryKeySaver])

  const handleClose = () => {
    setOpen(false)
    setAffirmative1(false)
    setAffirmative2(false)
    setAffirmative3(false)
    setCopied(false)
  }

  const onAbandon = () => {
    reject(new Error('User abandoned recovery key'))
    handleClose()
  }

  const onKeySaved = () => {
    resolve(true)
    handleClose()
  }

  const handleCopy = async () => {
    try {
      await Clipboard.setStringAsync(recoveryKey)
      setCopied(true)
      Alert.alert('Success', 'Recovery key copied to clipboard')
      setTimeout(() => setCopied(false), 3000)
    } catch {
      Alert.alert('Error', 'Failed to copy recovery key')
    }
  }

  const handleShare = async () => {
    try {
      const result = await Share.share({
        message: `BSV Browser Recovery Key:\n\n${recoveryKey}\n\nSaved: ${new Date().toLocaleString()}`,
        title: 'BSV Browser Recovery Key'
      })

      if (result.action === Share.sharedAction) {
        Alert.alert('Success', 'Recovery key shared successfully')
      }
    } catch (error) {
      console.error('Error sharing recovery key:', error)
      Alert.alert('Error', 'Failed to share recovery key')
    }
  }

  // Custom checkbox component for consistent styling
  const Checkbox = ({ checked, onPress, label }: { checked: boolean; onPress: () => void; label: string }) => (
    <TouchableOpacity style={styles.checkboxContainer} onPress={onPress} activeOpacity={0.6}>
      <View style={[styles.checkbox, { borderColor: colors.primary }]}>
        {checked && <Ionicons name="checkmark" size={18} color={colors.primary} />}
      </View>
      <Text style={[styles.checkboxLabel, { color: colors.textPrimary }]}>{label}</Text>
    </TouchableOpacity>
  )

  return (
    <Modal visible={open} transparent={true} animationType="fade" onRequestClose={onAbandon}>
      <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
        <View style={[styles.modalContainer, { backgroundColor: 'rgba(0,0,0,0.5)' }]}>
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.keyboardAvoid}>
            <View style={[styles.modalContent, { backgroundColor: colors.background }]}>
              <Text style={[styles.title, { color: colors.textPrimary }]}>Save Your Recovery Key Now</Text>

              <ScrollView style={styles.scrollView}>
                {!affirmative1 && (
                  <View>
                    <View
                      style={[
                        styles.keyContainer,
                        { backgroundColor: colors.inputBackground, borderColor: colors.inputBorder }
                      ]}
                    >
                      <Text style={[styles.recoveryKey, { color: colors.textPrimary }]} selectable>
                        {recoveryKey}
                      </Text>
                    </View>

                    <View style={styles.buttonsRow}>
                      <TouchableOpacity
                        style={[styles.actionButton, { backgroundColor: colors.primary }]}
                        onPress={handleCopy}
                      >
                        <Ionicons
                          name={copied ? 'checkmark' : 'copy-outline'}
                          size={18}
                          color={colors.buttonText}
                          style={styles.buttonIcon}
                        />
                        <Text style={[styles.buttonText, { color: colors.buttonText }]}>Copy</Text>
                      </TouchableOpacity>

                      <TouchableOpacity
                        style={[styles.actionButton, { backgroundColor: colors.primary }]}
                        onPress={handleShare}
                      >
                        <Ionicons name="share-outline" size={18} color={colors.buttonText} style={styles.buttonIcon} />
                        <Text style={[styles.buttonText, { color: colors.buttonText }]}>Share</Text>
                      </TouchableOpacity>
                    </View>

                    <Text style={[styles.description, { color: colors.textSecondary }]}>
                      Take a screenshot, email it to yourself, print it out and put it in a safe, or save it to secure
                      cloud storage.
                    </Text>
                  </View>
                )}

                <View style={styles.checkboxesContainer}>
                  <Checkbox
                    checked={affirmative1}
                    onPress={() => setAffirmative1(!affirmative1)}
                    label="I have saved my recovery key"
                  />
                </View>

                {affirmative1 && (
                  <View>
                    <Text style={[styles.subtitle, { color: colors.textPrimary }]}>
                      Any 2 of 3 factors are required to access your data: Phone, Password, Recovery Key
                    </Text>

                    <View style={[styles.warningBox, { borderColor: colors.error }]}>
                      <Text style={[styles.warningText, { color: colors.error }]}>
                        Loss of two factors = PERMANENT TOTAL LOSS of all assets, and data.
                      </Text>
                    </View>

                    <View style={styles.checkboxesContainer}>
                      <Checkbox
                        checked={affirmative3}
                        onPress={() => setAffirmative3(!affirmative3)}
                        label="I will immediately recover lost factors using the other two"
                      />

                      <Checkbox
                        checked={affirmative2}
                        onPress={() => setAffirmative2(!affirmative2)}
                        label="I am solely responsible for maintaining access to my own data"
                      />
                    </View>
                  </View>
                )}
              </ScrollView>

              <View style={styles.buttonContainer}>
                <TouchableOpacity style={[styles.buttonSecondary]} onPress={onAbandon}>
                  <Text style={[styles.buttonSecondaryText, { color: colors.textPrimary }]}>Abandon</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[
                    styles.buttonPrimary,
                    {
                      backgroundColor: colors.buttonBackground,
                      opacity: isAllChecked ? 1 : 0.2
                    }
                  ]}
                  onPress={onKeySaved}
                  disabled={!isAllChecked}
                >
                  <Text style={[styles.buttonText, { color: colors.buttonText }]}>Securely Saved</Text>
                  <Ionicons name={isAllChecked ? "lock-closed" : "lock-open"} size={20} color={colors.buttonText} style={styles.buttonIcon} />
                </TouchableOpacity>
              </View>
            </View>
          </KeyboardAvoidingView>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  )
}

const styles = StyleSheet.create({
  modalContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center'
  },
  keyboardAvoid: {
    maxWidth: 500
  },
  modalContent: {
    borderRadius: 8,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 2
    },
    shadowOpacity: 0.25,
    shadowRadius: 3.84,
    elevation: 5,
  },
  scrollView: {
    maxHeight: 450,
    marginVertical: 16
  },
  title: {
    fontSize: 22,
    fontWeight: 'bold',
    marginBottom: 12
  },
  subtitle: {
    fontSize: 18,
    fontWeight: '600',
    marginTop: 16,
    marginBottom: 12
  },
  description: {
    fontSize: 16,
    marginTop: 12,
    marginBottom: 16
  },
  keyContainer: {
    padding: 16,
    borderRadius: 8,
    borderWidth: 1,
    marginVertical: 16
  },
  recoveryKey: {
    fontSize: 16,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    fontWeight: '500'
  },
  buttonsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginVertical: 12
  },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 6,
    flex: 0.48
  },
  buttonIcon: {
    marginLeft: 8
  },
  warningBox: {
    borderWidth: 1,
    borderRadius: 6,
    padding: 12,
    marginVertical: 16
  },
  warningText: {
    fontSize: 16,
    fontWeight: 'bold',
    textAlign: 'center'
  },
  centeredText: {
    textAlign: 'center',
    fontSize: 18,
    marginVertical: 12
  },
  checkboxesContainer: {
    marginVertical: 16
  },
  checkboxContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16
  },
  checkbox: {
    height: 24,
    width: 24,
    borderWidth: 2,
    borderRadius: 4,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12
  },
  checkboxLabel: {
    flex: 1,
    fontSize: 16
  },
  buttonContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 16
  },
  buttonPrimary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 6,
    minWidth: 150
  },
  buttonSecondary: {
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 6
  },
  buttonText: {
    fontSize: 16,
    fontWeight: '500',
  },
  buttonSecondaryText: {
    fontSize: 16
  }
})

export default RecoveryKeySaver
