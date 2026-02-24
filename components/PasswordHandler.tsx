import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  TouchableWithoutFeedback,
  Keyboard,
  Alert
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useWallet } from '@/context/WalletContext'
import { useTheme } from '@/context/theme/ThemeContext'

// Stable dummy focus handlers (defined outside component to avoid recreation on every render)
const focusHandler = {
  isFocused: async () => true,
  onFocusRequested: () => {},
  onFocusRelinquished: () => {}
}

const PasswordHandler: React.FC = () => {

  // Get theme colors
  const { colors } = useTheme()

  const [wasOriginallyFocused, setWasOriginallyFocused] = useState<boolean>(false)
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [test, setTest] = useState<Function>(() => {
    return Promise.resolve(true)
  })
  const [resolve, setResolve] = useState<Function>(() => {})
  const [reject, setReject] = useState<Function>(() => {})
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const { setPasswordRetriever } = useWallet()

  const manageFocus = useCallback(() => {
    focusHandler.isFocused().then(focused => {
      setWasOriginallyFocused(focused)
      if (!focused) {
        focusHandler.onFocusRequested()
      }
    })
  }, [])

  // Define a dummy function for initialization
  const dummyPasswordHandler = useCallback((reason: string, test: (pwd: string) => boolean): Promise<string> => {
    console.warn('Password handler called before initialization')
    return Promise.resolve('')
  }, [])

  // Create a ref to store the handler function
  const handlerRef = useRef(dummyPasswordHandler)

  // Set up the actual handler function
  useEffect(() => {
    handlerRef.current = (reason: string, testFn: (passwordCandidate: string) => boolean): Promise<string> => {
      return new Promise<string>((resolvePromise: Function, rejectPromise: Function) => {
        setReason(reason)
        setTest(() => testFn)
        setResolve(() => resolvePromise)
        setReject(() => rejectPromise)
        setOpen(true)
        manageFocus()
      })
    }
  }, [manageFocus])

  // Register the handler exactly once on mount
  useEffect(() => {
    // Provide a stable reference that delegates to our ref
    const stableHandler = (): any => {
      return (reason: string, test: (passwordCandidate: string) => boolean): Promise<string> => {
        return handlerRef.current(reason, test)
      }
    }

    setPasswordRetriever(stableHandler)
  }, [setPasswordRetriever])

  const handleClose = useCallback(() => {
    setOpen(false)
    setPassword('')
    setShowPassword(false)

    if (!wasOriginallyFocused) {
      focusHandler.onFocusRelinquished()
    }
  }, [wasOriginallyFocused])

  const handleCancel = useCallback(() => {
    reject(new Error('User cancelled'))
    handleClose()
  }, [handleClose, reject])

  const handleSubmit = useCallback(async () => {
    try {
      const success = await test(password)
      if (success) {
        resolve(password)
        handleClose()
      } else {
        Alert.alert('Error', 'Password validation failed')
      }
    } catch {
      Alert.alert('Error', 'Password validation failed')
    }
  }, [handleClose, password, resolve, test])

  const toggleShowPassword = () => {
    setShowPassword(!showPassword)
  }

  return (
    <Modal visible={open} transparent={true} animationType="fade" onRequestClose={handleCancel}>
      <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
        <View style={[styles.modalContainer, { backgroundColor: 'rgba(0,0,0,0.5)' }]}>
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.keyboardAvoid}>
            <View style={[styles.modalContent, { backgroundColor: colors.background }]}>
              <View style={styles.contentContainer}>
                <Text style={[styles.title, { color: colors.textPrimary }]}>Enter Password</Text>
                <Text style={[styles.description, { color: colors.textSecondary }]}>
                  {reason || 'Please enter your password to continue'}
                </Text>

                <View style={styles.inputContainer}>
                  <TextInput
                    style={[
                      styles.input,
                      {
                        backgroundColor: colors.inputBackground,
                        borderColor: colors.inputBorder,
                        color: colors.textPrimary
                      }
                    ]}
                    value={password}
                    onChangeText={setPassword}
                    secureTextEntry={!showPassword}
                    placeholder="Enter password"
                    placeholderTextColor={colors.textSecondary}
                    autoFocus
                    onSubmitEditing={handleSubmit}
                  />
                  <TouchableOpacity style={styles.eyeIcon} onPress={toggleShowPassword}>
                    <Ionicons name={showPassword ? 'eye-off' : 'eye'} size={24} color={colors.textSecondary} />
                  </TouchableOpacity>
                </View>
              </View>

              <View style={styles.buttonContainer}>
                <TouchableOpacity
                  style={[styles.button, { backgroundColor: colors.inputBorder }]}
                  onPress={handleCancel}
                >
                  <Text style={[styles.buttonText, { color: colors.textPrimary }]}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.button, { backgroundColor: colors.primary }]} onPress={handleSubmit}>
                  <Text style={[styles.buttonText, { color: colors.buttonText }]}>Submit</Text>
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
    width: '90%',
    maxWidth: 400
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
    elevation: 5
  },
  contentContainer: {
    marginBottom: 20
  },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
    marginBottom: 12
  },
  description: {
    fontSize: 16,
    marginBottom: 20
  },
  inputContainer: {
    position: 'relative'
  },
  input: {
    height: 50,
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 12,
    fontSize: 16,
    paddingRight: 50
  },
  eyeIcon: {
    position: 'absolute',
    right: 12,
    top: 13
  },
  buttonContainer: {
    flexDirection: 'row',
    justifyContent: 'flex-end'
  },
  button: {
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 4,
    marginLeft: 10
  },
  buttonText: {
    fontSize: 16,
    fontWeight: '500'
  }
})

export default PasswordHandler
