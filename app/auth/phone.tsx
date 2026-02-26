import React, { useState, useCallback } from 'react'
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
  KeyboardAvoidingView,
  TextInput,
  Modal,
  FlatList,
  Pressable
} from 'react-native'
import CustomSafeArea from '@/components/ui/CustomSafeArea'
import { router } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useTranslation } from 'react-i18next'
import { useTheme } from '@/context/theme/ThemeContext'
import { useThemeStyles } from '@/context/theme/useThemeStyles'
import { useWallet } from '@/context/WalletContext'
import { useBrowserMode } from '@/context/BrowserModeContext'
import { countryCodes } from '@/utils/countryCodes'
import { WalletAuthenticationManager } from '@bsv/wallet-toolbox-mobile'

export default function PhoneScreen() {
  const { t } = useTranslation()
  const [phoneNumber, setPhoneNumber] = useState('')
  const [selectedCountry, setSelectedCountry] = useState(countryCodes[222])
  const [showCountryPicker, setShowCountryPicker] = useState(false)
  const [loading, setLoading] = useState(false)
  const { managers } = useWallet()
  const { showWeb3Benefits } = useBrowserMode()

  // Get theme styles and colors
  const { colors, isDark } = useTheme()
  const styles = useThemeStyles()

  // Format the full phone number with country code
  const formattedNumber = `${selectedCountry.dialCode}${phoneNumber}`

  // Check if phone number is valid
  const isValidPhoneNumber = useCallback(() => {
    return phoneNumber.length > 6 // Simple validation, adjust as needed
  }, [phoneNumber])

  // Handle country selection
  const handleSelectCountry = (country: (typeof countryCodes)[0]) => {
    setSelectedCountry(country)
    setShowCountryPicker(false)
  }

  // Handle login button press
  const handleContinue = useCallback(async () => {
    if (!isValidPhoneNumber()) return

    setLoading(true)

    try {
      const cwiManager = managers!.walletManager as WalletAuthenticationManager
      await cwiManager.startAuth({
        phoneNumber: formattedNumber
      })

      // Navigate to OTP screen
      router.push({
        pathname: '/auth/otp',
        params: { phoneNumber: formattedNumber }
      })
    } catch (error) {
      console.error('Error sending OTP:', error)
      // Show error message to user
    } finally {
      setLoading(false)
    }
  }, [managers, formattedNumber, isValidPhoneNumber])

  // Handle skip login for web2 mode
  const handleSkipLogin = useCallback(() => {
    // Show the benefits modal first
    showWeb3Benefits(
      // onContinue - if they still want to skip
      () => {
        router.replace({
          pathname: '/',
          params: { mode: 'web2' }
        })
      },
      // onGoToLogin - if they decide to get Web3 identity
      () => {
        // Just close the modal, they're already on the phone screen
      }
    )
  }, [showWeb3Benefits])

  return (
    <CustomSafeArea style={styles.container}>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <View style={styles.contentContainer}>
          <Text style={styles.title}>{t('enter_phone_number')}</Text>
          <Text style={styles.subtitle}>{t('send_verification_code')}</Text>

          <View style={styles.inputContainer}>
            <View style={[styles.input, { paddingLeft: 0 }]}>
              {/* Country code selector */}
              <TouchableOpacity
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  paddingHorizontal: 10,
                  borderRightWidth: 1,
                  borderRightColor: colors.inputBorder,
                  width: 80
                }}
                onPress={() => setShowCountryPicker(true)}
              >
                <Text style={{ color: colors.textPrimary, fontSize: 16, marginRight: 5 }}>
                  {selectedCountry.dialCode}
                </Text>
                <Text style={{ fontSize: 10, color: colors.textSecondary }}>▼</Text>
              </TouchableOpacity>

              {/* Phone number input */}
              <TextInput
                style={styles.inputText}
                placeholder={t('phone_number')}
                placeholderTextColor={colors.textSecondary}
                keyboardType="phone-pad"
                value={phoneNumber}
                onChangeText={setPhoneNumber}
                autoFocus
              />
            </View>

            {/* Country picker modal */}
            <Modal
              visible={showCountryPicker}
              animationType="slide"
              transparent
              onRequestClose={() => setShowCountryPicker(false)}
            >
              <View
                style={{
                  flex: 1,
                  justifyContent: 'flex-end',
                  backgroundColor: 'rgba(0,0,0,0.5)'
                }}
              >
                <View
                  style={{
                    backgroundColor: colors.paperBackground,
                    borderTopLeftRadius: 20,
                    borderTopRightRadius: 20,
                    maxHeight: '80%'
                  }}
                >
                  <View
                    style={{
                      flexDirection: 'row',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: 15,
                      borderBottomWidth: 1,
                      borderBottomColor: colors.inputBorder
                    }}
                  >
                    <Text style={[styles.text, { fontWeight: 'bold', fontSize: 18 }]}>{t('select_country')}</Text>
                    <TouchableOpacity onPress={() => setShowCountryPicker(false)}>
                      <Text style={{ fontSize: 18, color: colors.textSecondary }}>✕</Text>
                    </TouchableOpacity>
                  </View>

                  <FlatList
                    data={countryCodes}
                    keyExtractor={item => item.code}
                    renderItem={({ item }) => (
                      <Pressable
                        style={{
                          flexDirection: 'row',
                          justifyContent: 'space-between',
                          padding: 15,
                          borderBottomWidth: 1,
                          borderBottomColor: colors.inputBorder
                        }}
                        onPress={() => handleSelectCountry(item)}
                      >
                        <Text style={styles.text}>{item.name}</Text>
                        <Text style={styles.textSecondary}>{item.dialCode}</Text>
                      </Pressable>
                    )}
                  />
                </View>
              </View>
            </Modal>
          </View>

          <TouchableOpacity
            style={[styles.button, !isValidPhoneNumber() && styles.buttonDisabled]}
            onPress={handleContinue}
            disabled={!isValidPhoneNumber() || loading}
          >
            {loading ? (
              <ActivityIndicator color={colors.buttonTextDisabled} />
            ) : (
              <Text style={[styles.buttonText, (!isValidPhoneNumber() || loading) && styles.buttonTextDisabled]}>{t('continue')}</Text>
            )}
          </TouchableOpacity>

          {/* Skip login button for web2 mode */}
          <TouchableOpacity
            style={[
              styles.button,
              { backgroundColor: colors.paperBackground, borderWidth: 1, borderColor: colors.inputBorder },
              loading && { opacity: 0.7 }
            ]}
            onPress={handleSkipLogin}
            disabled={loading}
          >
            <Text style={[styles.buttonText, { color: colors.textPrimary }]}>Continue without login</Text>
          </TouchableOpacity>

          <Text style={{ fontSize: 12, color: colors.textSecondary, textAlign: 'center', marginTop: 10 }}>
            {t('terms_privacy_agree')}
          </Text>
        </View>
      </KeyboardAvoidingView>
    </CustomSafeArea>
  )
}
