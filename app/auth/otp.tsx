import React, { useState, useEffect, useRef, useCallback } from 'react'
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  KeyboardAvoidingView,
  Alert,
  TextInput
} from 'react-native'
import CustomSafeArea from '@/components/ui/CustomSafeArea'
import { router, useLocalSearchParams } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useTranslation } from 'react-i18next'
import { useTheme } from '@/context/theme/ThemeContext'
import { useWallet } from '@/context/WalletContext'

export default function OtpScreen() {
  const { t } = useTranslation()
  // Apply theme
  const { colors, isDark } = useTheme()

  const { managers } = useWallet()
  const params = useLocalSearchParams()
  const phoneNumber = params.phoneNumber as string

  const [otp, setOtp] = useState('')
  const [loading, setLoading] = useState(false)
  const [countdown, setCountdown] = useState(60) // 60 second countdown for resending OTP
  const [canResend, setCanResend] = useState(false)

  // Create refs for the input fields
  const inputRefs = useRef<(TextInput | null)[]>([])

  // Start countdown timer when component mounts
  useEffect(() => {
    const timer = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          clearInterval(timer)
          setCanResend(true)
          return 0
        }
        return prev - 1
      })
    }, 1000)

    return () => clearInterval(timer)
  }, [])

  // Handle OTP verification
  const handleVerify = useCallback(
    async (otp: string) => {
      console.log({ otp })
      if (otp.length !== 6) return // Ensure OTP is complete

      setLoading(true)

      try {
        await managers!.walletManager!.completeAuth({
          phoneNumber,
          otp
        })

        // Navigate to password screen after OTP verification
        router.push({
          pathname: '/auth/password',
          params: { phoneNumber: phoneNumber }
        })
      } catch (error) {
        console.error('Error verifying OTP:', error)
        Alert.alert(t('verification_failed'), t('code_incorrect_try_again'))
      } finally {
        setLoading(false)
      }
    },
    [managers, phoneNumber, t]
  )

  // Handle resend OTP
  const handleResend = useCallback(async () => {
    if (!canResend) return

    setLoading(true)

    try {
      await managers!.walletManager!.startAuth({ phoneNumber })

      // Reset countdown
      setCountdown(60)
      setCanResend(false)

      Alert.alert(t('code_sent'), t('new_verification_code_sent'))
    } catch (error) {
      console.error('Error resending OTP:', error)
      Alert.alert(t('error'), t('failed_to_resend'))
    } finally {
      setLoading(false)
    }
  }, [canResend, managers, phoneNumber, t])

  return (
    <CustomSafeArea style={[styles.container, { backgroundColor: colors.background }]}>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <KeyboardAvoidingView behavior="padding" style={styles.keyboardAvoidingView}>
        <View style={[styles.contentContainer, { backgroundColor: colors.background }]}>
          <Text style={[styles.title, { color: colors.textPrimary }]}>{t('verification_code')}</Text>
          <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
            {t('enter_6_digit_code')} {phoneNumber}
          </Text>

          <View style={styles.otpContainer}>
            <View style={styles.otpInputsContainer}>
              {[0, 1, 2, 3, 4, 5].map(index => {
                return (
                  <TextInput
                    key={index}
                    ref={ref => {
                      inputRefs.current[index] = ref
                    }}
                    style={[
                      styles.otpInput,
                      {
                        backgroundColor: colors.inputBackground,
                        borderColor: colors.inputBorder,
                        color: colors.textPrimary
                      },
                      otp.length === index && {
                        borderColor: colors.primary,
                        borderWidth: 2
                      }
                    ]}
                    keyboardType="phone-pad"
                    maxLength={6}
                    value={otp[index] || ''}
                    onChangeText={text => {
                      let updatedOtp = otp

                      // Handle paste event
                      if (text.length > 1) {
                        updatedOtp = text.replace(/[^0-9]/g, '').slice(0, 6)
                      } else if (text.length === 0) {
                        // Backspace - clear current digit
                        updatedOtp = otp.slice(0, index)
                      } else {
                        // Single digit input
                        updatedOtp = otp.slice(0, index) + text + otp.slice(index + 1)

                        // Auto-focus next input if this one is filled
                        if (index < 5 && text.length === 1) {
                          if (inputRefs.current[index + 1]) {
                            inputRefs.current[index + 1]?.focus()
                          }
                        }
                      }

                      // Update OTP state
                      setOtp(updatedOtp)

                      // Verify if complete
                      if (updatedOtp.length === 6) {
                        handleVerify(updatedOtp)
                      }
                    }}
                    editable={!loading}
                    autoFocus={index === 0}
                  />
                )
              })}
            </View>
          </View>

          {loading && <ActivityIndicator style={{ marginBottom: 20 }} />}

          <View style={styles.resendContainer}>
            <Text style={[styles.resendText, { color: colors.textSecondary }]}>{t('didnt_receive_code')}</Text>
            {canResend ? (
              <TouchableOpacity onPress={handleResend} disabled={loading}>
                <Text style={[styles.resendActionText, { color: colors.secondary }]}>{t('resend_code')}</Text>
              </TouchableOpacity>
            ) : (
              <Text style={[styles.countdownText, { color: colors.textSecondary, opacity: 0.7 }]}>
                {t('resend_in')} {countdown}s
              </Text>
            )}
          </View>

          <TouchableOpacity style={styles.changeNumberButton} onPress={() => router.back()}>
            <Text style={[styles.changeNumberText, { color: colors.secondary }]}>{t('change_phone_number')}</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </CustomSafeArea>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1
  },
  keyboardAvoidingView: {
    flex: 1
  },
  contentContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 10,
    textAlign: 'center'
  },
  subtitle: {
    fontSize: 16,
    marginBottom: 30,
    textAlign: 'center'
  },
  otpContainer: {
    width: '100%',
    marginBottom: 30
  },
  otpInputsContainer: {
    width: '100%',
    flexDirection: 'row',
    justifyContent: 'space-between'
  },
  otpInput: {
    borderWidth: 1,
    borderRadius: 10,
    fontSize: 20,
    padding: 12,
    textAlign: 'center',
    width: 45,
    height: 55
  },
  otpInputFocused: {}, // Styles now applied inline with theme colors
  verifyButton: {
    paddingVertical: 15,
    paddingHorizontal: 40,
    borderRadius: 10,
    width: '100%',
    alignItems: 'center',
    marginBottom: 20
  },
  verifyButtonDisabled: {}, // Styles now applied inline with theme colors
  verifyButtonText: {
    fontSize: 16,
    fontWeight: 'bold'
  },
  resendContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 10,
    marginBottom: 20
  },
  resendText: {
    marginRight: 5
  },
  resendActionText: {
    fontWeight: 'bold'
  },
  countdownText: {}, // Color now applied inline with theme colors
  changeNumberButton: {
    marginTop: 20
  },
  changeNumberText: {
    fontSize: 14
  }
})
