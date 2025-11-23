import React, { useState } from 'react'
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  Alert,
  SafeAreaView,
  TextInput,
  ActivityIndicator
} from 'react-native'
import { router } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from '@/context/theme/ThemeContext'
import { useThemeStyles } from '@/context/theme/useThemeStyles'
import { useWallet } from '@/context/WalletContext'
import {
  generateMnemonicWallet,
  recoverMnemonicWallet,
  validateMnemonic,
  formatMnemonicForDisplay
} from '@/utils/mnemonicWallet'
import * as Clipboard from 'expo-clipboard'

type MnemonicMode = 'choose' | 'generate' | 'import'

export default function MnemonicScreen() {
  const { colors, isDark } = useTheme()
  const styles = useThemeStyles()
  const { managers, selectedNetwork } = useWallet()

  const [mode, setMode] = useState<MnemonicMode>('choose')
  const [mnemonic, setMnemonic] = useState<string>('')
  const [importedMnemonic, setImportedMnemonic] = useState<string>('')
  const [hasBackedUp, setHasBackedUp] = useState(false)
  const [loading, setLoading] = useState(false)

  // Generate a new mnemonic
  const handleGenerateNew = () => {
    try {
      const wallet = generateMnemonicWallet()
      setMnemonic(wallet.mnemonic)
      setMode('generate')
    } catch (error: any) {
      console.error('Error generating mnemonic:', error)
      Alert.alert('Error', 'Failed to generate mnemonic. Please try again.')
    }
  }

  // Copy mnemonic to clipboard
  const handleCopyMnemonic = async () => {
    await Clipboard.setStringAsync(mnemonic)
    Alert.alert('Copied', 'Mnemonic copied to clipboard')
  }

  // Continue with generated mnemonic
  const handleContinueWithGenerated = async () => {
    if (!hasBackedUp) {
      Alert.alert(
        'Backup Required',
        'Please confirm that you have backed up your mnemonic phrase. Without it, you will lose access to your wallet if you lose this device.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'I Have Backed It Up', onPress: () => setHasBackedUp(true) }
        ]
      )
      return
    }

    await initializeWallet(mnemonic)
  }

  // Validate and continue with imported mnemonic
  const handleContinueWithImported = async () => {
    const trimmedMnemonic = importedMnemonic.trim()

    if (!validateMnemonic(trimmedMnemonic)) {
      Alert.alert('Invalid Mnemonic', 'Please enter a valid 12, 15, 18, 21, or 24 word mnemonic phrase.')
      return
    }

    await initializeWallet(trimmedMnemonic)
  }

  // Initialize wallet with mnemonic
  const initializeWallet = async (mnemonicPhrase: string) => {
    setLoading(true)
    try {
      // Recover wallet from mnemonic
      const wallet = recoverMnemonicWallet(mnemonicPhrase)

      console.log('[Mnemonic] Wallet generated:', {
        identityKey: wallet.identityKey,
        network: selectedNetwork
      })

      // TODO: Initialize SimpleWalletManager with the primary key
      // For now, we'll store the mnemonic securely and navigate to browser
      // This will need to be integrated with WalletContext to properly initialize
      // the SimpleWalletManager

      // Store encrypted mnemonic in secure storage
      // await SecureStore.setItemAsync('encrypted_mnemonic', encryptMnemonic(mnemonicPhrase))

      Alert.alert(
        'Success',
        'Your self-custodial wallet has been created! Integration with wallet manager is pending.',
        [
          {
            text: 'Continue',
            onPress: () => {
              router.dismissAll()
              router.replace('/browser')
            }
          }
        ]
      )
    } catch (error: any) {
      console.error('[Mnemonic] Error initializing wallet:', error)
      Alert.alert('Error', `Failed to initialize wallet: ${error.message}`)
    } finally {
      setLoading(false)
    }
  }

  // Render word chips for display
  const renderMnemonicWords = (mnemonicPhrase: string) => {
    const words = formatMnemonicForDisplay(mnemonicPhrase)
    return (
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginVertical: 20 }}>
        {words.map((word, index) => (
          <View
            key={index}
            style={{
              backgroundColor: colors.inputBackground,
              borderColor: colors.inputBorder,
              borderWidth: 1,
              borderRadius: 8,
              paddingVertical: 8,
              paddingHorizontal: 12,
              minWidth: 100
            }}
          >
            <Text style={{ color: colors.textSecondary, fontSize: 12 }}>
              {index + 1}
            </Text>
            <Text style={{ color: colors.textPrimary, fontSize: 16, fontWeight: '600' }}>
              {word}
            </Text>
          </View>
        ))}
      </View>
    )
  }

  // Choose mode screen
  if (mode === 'choose') {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <StatusBar style={isDark ? 'light' : 'dark'} />
        <View style={{ padding: 20, flex: 1 }}>
          <Text style={[styles.title, { fontSize: 24, marginBottom: 10 }]}>
            Self-Custodial Wallet
          </Text>
          <Text style={[styles.textSecondary, { marginBottom: 30 }]}>
            Your keys, your coins. Complete independence with no backend services required.
          </Text>

          <TouchableOpacity
            style={[
              styles.button,
              {
                backgroundColor: colors.primary,
                padding: 20,
                borderRadius: 12,
                marginBottom: 15
              }
            ]}
            onPress={handleGenerateNew}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}>
              <Ionicons name="add-circle-outline" size={24} color={colors.buttonText} style={{ marginRight: 10 }} />
              <View>
                <Text style={[styles.buttonText, { fontSize: 18, fontWeight: 'bold' }]}>
                  Create New Wallet
                </Text>
                <Text style={[{ color: colors.buttonText, opacity: 0.8, fontSize: 14 }]}>
                  Generate a new mnemonic seed phrase
                </Text>
              </View>
            </View>
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.button,
              {
                backgroundColor: colors.inputBackground,
                borderWidth: 1,
                borderColor: colors.inputBorder,
                padding: 20,
                borderRadius: 12
              }
            ]}
            onPress={() => setMode('import')}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}>
              <Ionicons name="download-outline" size={24} color={colors.primary} style={{ marginRight: 10 }} />
              <View>
                <Text style={[styles.text, { fontSize: 18, fontWeight: 'bold', color: colors.textPrimary }]}>
                  Import Existing Wallet
                </Text>
                <Text style={[styles.textSecondary, { fontSize: 14 }]}>
                  Recover from your mnemonic phrase
                </Text>
              </View>
            </View>
          </TouchableOpacity>

          <TouchableOpacity
            style={{ marginTop: 30, alignSelf: 'center' }}
            onPress={() => router.back()}
          >
            <Text style={[styles.text, { color: colors.secondary }]}>
              Go Back
            </Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    )
  }

  // Generate mode - show generated mnemonic
  if (mode === 'generate') {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <StatusBar style={isDark ? 'light' : 'dark'} />
        <ScrollView style={{ flex: 1, padding: 20 }}>
          <Text style={[styles.title, { fontSize: 24, marginBottom: 10 }]}>
            Backup Your Mnemonic
          </Text>

          <View style={{
            backgroundColor: colors.error + '20',
            borderColor: colors.error,
            borderWidth: 1,
            borderRadius: 8,
            padding: 15,
            marginBottom: 20
          }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
              <Ionicons name="warning" size={24} color={colors.error} style={{ marginRight: 8 }} />
              <Text style={[styles.text, { fontWeight: 'bold', color: colors.error }]}>
                Important Warning
              </Text>
            </View>
            <Text style={[styles.textSecondary]}>
              Write down these 12 words in order. This is the ONLY way to recover your wallet.
              If you lose these words, you lose your funds permanently.
            </Text>
          </View>

          {renderMnemonicWords(mnemonic)}

          <TouchableOpacity
            style={[
              styles.button,
              {
                backgroundColor: colors.inputBackground,
                borderWidth: 1,
                borderColor: colors.inputBorder,
                marginBottom: 20
              }
            ]}
            onPress={handleCopyMnemonic}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}>
              <Ionicons name="copy-outline" size={20} color={colors.primary} style={{ marginRight: 8 }} />
              <Text style={[styles.text, { color: colors.primary }]}>
                Copy to Clipboard
              </Text>
            </View>
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.button,
              {
                backgroundColor: hasBackedUp ? colors.primary : colors.inputBackground,
                opacity: loading ? 0.5 : 1
              }
            ]}
            onPress={handleContinueWithGenerated}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator color={colors.buttonText} />
            ) : (
              <Text style={[styles.buttonText, { color: hasBackedUp ? colors.buttonText : colors.textPrimary }]}>
                {hasBackedUp ? 'Continue' : 'I Have Backed Up My Mnemonic'}
              </Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={{ marginTop: 20, alignSelf: 'center' }}
            onPress={() => setMode('choose')}
          >
            <Text style={[styles.text, { color: colors.secondary }]}>
              Go Back
            </Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    )
  }

  // Import mode - paste existing mnemonic
  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <ScrollView style={{ flex: 1, padding: 20 }}>
        <Text style={[styles.title, { fontSize: 24, marginBottom: 10 }]}>
          Import Wallet
        </Text>
        <Text style={[styles.textSecondary, { marginBottom: 20 }]}>
          Enter your 12, 15, 18, 21, or 24 word mnemonic phrase to recover your wallet.
        </Text>

        <Text style={[styles.inputLabel, { marginBottom: 8 }]}>
          Mnemonic Phrase
        </Text>
        <TextInput
          style={[
            styles.input,
            {
              minHeight: 120,
              textAlignVertical: 'top',
              paddingTop: 12
            }
          ]}
          value={importedMnemonic}
          onChangeText={setImportedMnemonic}
          placeholder="Enter your mnemonic words separated by spaces"
          placeholderTextColor={colors.textSecondary}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
        />

        <TouchableOpacity
          style={[
            styles.button,
            {
              backgroundColor: importedMnemonic.trim() ? colors.primary : colors.inputBackground,
              marginTop: 20,
              opacity: loading ? 0.5 : 1
            }
          ]}
          onPress={handleContinueWithImported}
          disabled={!importedMnemonic.trim() || loading}
        >
          {loading ? (
            <ActivityIndicator color={colors.buttonText} />
          ) : (
            <Text style={[styles.buttonText, { color: importedMnemonic.trim() ? colors.buttonText : colors.textPrimary }]}>
              Import Wallet
            </Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={{ marginTop: 20, alignSelf: 'center' }}
          onPress={() => setMode('choose')}
        >
          <Text style={[styles.text, { color: colors.secondary }]}>
            Go Back
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  )
}
