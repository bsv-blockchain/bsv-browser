import React, { useState } from 'react'
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  Alert,
  SafeAreaView,
  TextInput,
  ActivityIndicator,
  Share
} from 'react-native'
import { router } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from '@/context/theme/ThemeContext'
import { useThemeStyles } from '@/context/theme/useThemeStyles'
import { useWallet } from '@/context/WalletContext'
import {
  generateMnemonicWallet,
  validateMnemonic,
  formatMnemonicForDisplay
} from '@/utils/mnemonicWallet'
import * as Clipboard from 'expo-clipboard'
import { useLocalStorage } from '@/context/LocalStorageProvider'

type MnemonicMode = 'choose' | 'generate' | 'import'

export default function MnemonicScreen() {
  const { colors, isDark } = useTheme()
  const styles = useThemeStyles()
  const { buildWalletFromMnemonic } = useWallet()
  const { setMnemonic: storeMnemonic } = useLocalStorage()

  const [mode, setMode] = useState<MnemonicMode>('choose')
  const [mnemonic, setMnemonic] = useState<string>('')
  const [importedMnemonic, setImportedMnemonic] = useState<string>('')
  const [hasShared, setHasShared] = useState(false)
  const [hasAcknowledged, setHasAcknowledged] = useState(false)
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

  // Share mnemonic as text file via system share dialog
  const handleShareMnemonic = async () => {
    try {
      const result = await Share.share({
        message: mnemonic,
        title: 'BSV Wallet Recovery Phrase'
      })
      if (result.action === Share.sharedAction) {
        setHasShared(true)
      }
    } catch (error) {
      console.error('Error sharing mnemonic:', error)
    }
  }

  // Copy mnemonic to clipboard
  const handleCopyMnemonic = async () => {
    await Clipboard.setStringAsync(mnemonic)
    Alert.alert('Copied', 'Recovery phrase copied to clipboard')
  }

  // Continue with generated mnemonic after acknowledgment
  const handleContinueWithGenerated = async () => {
    if (!hasAcknowledged) return
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
      console.log('[Mnemonic] Starting wallet initialization with mnemonic')
      await storeMnemonic(mnemonicPhrase)
      await buildWalletFromMnemonic()
      console.log('[Mnemonic] Wallet setup complete, navigating to browser')
      router.dismissAll()
      router.push('/')
    } catch (error: any) {
      console.error('[Mnemonic] Error setting up wallet:', error)
      Alert.alert('Error', `Failed to set up wallet: ${error.message}`)
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
            Set Up Your Wallet
          </Text>
          <Text style={[styles.textSecondary, { marginBottom: 30 }]}>
            Your keys, your coins. Your wallet is stored locally on this device.
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
                  Generate a new recovery phrase
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
                  Paste your recovery phrase
                </Text>
              </View>
            </View>
          </TouchableOpacity>

          <TouchableOpacity
            style={{ marginTop: 30, alignSelf: 'center' }}
            onPress={() => router.back()}
          >
            <Text style={[styles.text, { color: colors.secondary }]}>
              Cancel
            </Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    )
  }

  // Generate mode - show generated mnemonic with share + acknowledge
  if (mode === 'generate') {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <StatusBar style={isDark ? 'light' : 'dark'} />
        <ScrollView style={{ flex: 1, padding: 20 }}>
          <Text style={[styles.title, { fontSize: 24, marginBottom: 10 }]}>
            Save Your Recovery Phrase
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
                Important
              </Text>
            </View>
            <Text style={[styles.textSecondary]}>
              Save these 12 words somewhere safe. This is the ONLY way to recover your wallet.
              If you lose this phrase, your funds and digital identity are permanently lost.
            </Text>
          </View>

          {renderMnemonicWords(mnemonic)}

          {/* Share button (primary action) */}
          <TouchableOpacity
            style={[
              styles.button,
              {
                backgroundColor: colors.primary,
                marginBottom: 10
              }
            ]}
            onPress={handleShareMnemonic}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}>
              <Ionicons name="share-outline" size={20} color={colors.buttonText} style={{ marginRight: 8 }} />
              <Text style={[styles.buttonText]}>
                {hasShared ? 'Share Again' : 'Save Recovery Phrase'}
              </Text>
            </View>
          </TouchableOpacity>

          {/* Copy to clipboard (secondary action) */}
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

          {/* Acknowledgment checkbox */}
          <TouchableOpacity
            style={{
              flexDirection: 'row',
              alignItems: 'flex-start',
              marginBottom: 20,
              padding: 15,
              borderRadius: 8,
              backgroundColor: hasAcknowledged ? colors.primary + '10' : colors.inputBackground,
              borderWidth: 1,
              borderColor: hasAcknowledged ? colors.primary : colors.inputBorder
            }}
            onPress={() => setHasAcknowledged(!hasAcknowledged)}
          >
            <Ionicons
              name={hasAcknowledged ? 'checkbox' : 'square-outline'}
              size={24}
              color={hasAcknowledged ? colors.primary : colors.textSecondary}
              style={{ marginRight: 12, marginTop: 2 }}
            />
            <Text style={[styles.text, { flex: 1, fontSize: 14, lineHeight: 20 }]}>
              I have saved my recovery phrase. I understand that if I lose it, my funds and digital identity are permanently lost and I will have to start from scratch.
            </Text>
          </TouchableOpacity>

          {/* Continue button */}
          <TouchableOpacity
            style={[
              styles.button,
              {
                backgroundColor: hasAcknowledged ? colors.primary : colors.inputBackground,
                opacity: loading ? 0.5 : 1
              }
            ]}
            onPress={handleContinueWithGenerated}
            disabled={!hasAcknowledged || loading}
          >
            {loading ? (
              <ActivityIndicator color={colors.buttonText} />
            ) : (
              <Text style={[styles.buttonText, { color: hasAcknowledged ? colors.buttonText : colors.textSecondary }]}>
                Continue
              </Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={{ marginTop: 20, alignSelf: 'center', marginBottom: 40 }}
            onPress={() => {
              setMode('choose')
              setHasShared(false)
              setHasAcknowledged(false)
            }}
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
          Paste your recovery phrase to restore your wallet.
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
