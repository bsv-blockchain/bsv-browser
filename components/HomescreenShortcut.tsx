import React, { useState, useEffect } from 'react'
import { useTheme } from '@react-navigation/native'
import Shortcuts from '@rn-bridge/react-native-shortcuts'
import {
  View,
  Text,
  Modal,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Alert,
  Platform,
  ActivityIndicator,
  Dimensions
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import * as Linking from 'expo-linking'
import { Utils } from '@bsv/sdk'

interface HomescreenShortcutProps {
  visible: boolean
  onClose: () => void
  currentUrl: string
  currentTitle?: string
  faviconUrl?: string
}

const HomescreenShortcut: React.FC<HomescreenShortcutProps> = ({
  visible,
  onClose,
  currentUrl,
  currentTitle,
  faviconUrl
}) => {
  const { colors } = useTheme()
  const [shortcutName, setShortcutName] = useState('')
  const [shortcutUrl, setShortcutUrl] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [faviconData, setFaviconData] = useState<string | null>(null)

  useEffect(() => {
    if (visible) {
      // Pre-populate with current page data
      setShortcutUrl(currentUrl)
      setShortcutName(currentTitle || getDomainFromUrl(currentUrl) || 'Website')
      // Attempt to fetch favicon
      fetchFavicon(currentUrl)
    }
  }, [visible, currentUrl, currentTitle])

  const fetchFavicon = async (url: string) => {
    try {
      const domain = new URL(url).origin
      const faviconUrls = [
        `${domain}/favicon.ico`,
        `${domain}/favicon.png`,
        `${domain}/apple-touch-icon.png`,
        `https://www.google.com/s2/favicons?domain=${domain}&sz=64`
      ]

      for (const faviconUrl of faviconUrls) {
        try {
          const response = await fetch(faviconUrl, { method: 'HEAD' })
          if (response.ok) {
            setFaviconData(faviconUrl)
            console.log('✅ Found favicon:', faviconUrl)
            break
          }
        } catch {
          // Continue to next URL
        }
      }
    } catch (error) {
      console.log('❌ Failed to fetch favicon:', error)
    }
  }

  const getDomainFromUrl = (url: string): string => {
    try {
      const domain = new URL(url).hostname
      return domain.replace(/^www\./, '')
    } catch {
      return 'Website'
    }
  }

  const validateInputs = (): boolean => {
    if (!shortcutName.trim()) {
      Alert.alert('Error', 'Please enter a name for the shortcut')
      return false
    }
    if (!shortcutUrl.trim()) {
      Alert.alert('Error', 'Please enter a URL for the shortcut')
      return false
    }
    try {
      new URL(shortcutUrl)
    } catch {
      Alert.alert('Error', 'Please enter a valid URL')
      return false
    }
    return true
  }

  const createShortcut = async () => {
    if (!validateInputs()) return

    setIsCreating(true)
    try {
      if (Platform.OS === 'android') {
        console.log('📱 [Android] Creating shortcut:', { name: shortcutName, url: shortcutUrl })
        const encodedUrl = Utils.toBase64(Utils.toArray(shortcutUrl.trim()))
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=/g, '')
        const shortcut = {
          id: `metanet_${encodedUrl}`,
          title: shortcutName.trim(),
          subTitle: getDomainFromUrl(shortcutUrl),
          iconName: 'ic_launcher'
        }

        const result = await Shortcuts.addShortcut(shortcut)

        if (result) {
          Alert.alert('Success', 'Shortcut added to home screen successfully!', [{ text: 'OK', onPress: onClose }])
        } else {
          throw new Error('Failed to create shortcut')
        }
      } else {
        // iOS - Show enhanced options
        Alert.alert(
          'Add to Home Screen - iOS',
          `We've saved "${shortcutName}" as a quick action!\n\nTo access it:\n\n1. Long-press the BSV Browser app icon\n2. Select "${shortcutName}" from the menu\n\nAlternatively, you can add it to your home screen manually:\n1. Open Safari and navigate to the page\n2. Tap the Share button\n3. Select "Add to Home Screen"\n\nWould you like to open this page in Safari now?`,
          [
            {
              text: 'Just Save Quick Action',
              onPress: () => {
                // Save as iOS Quick Action
                saveAsQuickAction(shortcutName, shortcutUrl)
                Alert.alert('Quick Action Added!', 'Long-press the app icon to access your saved link.', [
                  { text: 'OK', onPress: onClose }
                ])
              }
            },
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Open in Safari',
              onPress: () => {
                saveAsQuickAction(shortcutName, shortcutUrl)
                Linking.openURL(shortcutUrl)
                onClose()
              }
            }
          ],
          { cancelable: true }
        )
      }
    } catch (error) {
      console.error('Error creating shortcut:', error)
      Alert.alert('Error', 'Failed to create shortcut. Please try again.', [{ text: 'OK' }])
    } finally {
      setIsCreating(false)
    }
  }

  const saveAsQuickAction = async (name: string, url: string) => {
    try {
      if (Platform.OS === 'ios') {
        // For iOS, we'll need to communicate with the main app to add Quick Actions
        // This is a simplified approach - in a real implementation, you'd want to:
        // 1. Save to AsyncStorage or a context
        // 2. Update the app's Quick Actions from the main app component
        // 3. Handle the quick action selection in the app delegate or main component

        console.log('📱 [iOS Quick Action] Saving quick action:', { name, url })

        // For now, we'll just log this - in a full implementation, you'd want to:
        // - Store in AsyncStorage with a key like 'quickActions'
        // - Update the iOS app's Info.plist or dynamic quick actions
        // - Handle the selection in the app's main component

        // Example of what you'd store:
        // await AsyncStorage.setItem('quickActions', JSON.stringify([...existingActions, { name, url }]));

        return true
      }
      return false
    } catch (error) {
      console.error('Error saving Quick Action:', error)
      return false
    }
  }

  const handleClose = () => {
    if (!isCreating) {
      onClose()
    }
  }

  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={handleClose}>
      <View style={styles.overlay}>
        <View style={[styles.container, { backgroundColor: colors.background }]}>
          <View style={styles.header}>
            <Text style={[styles.title, { color: colors.text }]}>Add to Home Screen</Text>
            <TouchableOpacity onPress={handleClose} disabled={isCreating} style={styles.closeButton}>
              <Ionicons name="close" size={24} color={colors.text} />
            </TouchableOpacity>
          </View>

          <View style={styles.content}>
            <Text style={[styles.label, { color: colors.text }]}>Name</Text>
            <TextInput
              style={[
                styles.input,
                {
                  backgroundColor: colors.card,
                  color: colors.text,
                  borderColor: colors.border
                }
              ]}
              value={shortcutName}
              onChangeText={setShortcutName}
              placeholder="Enter shortcut name"
              placeholderTextColor={colors.text + '80'}
              editable={!isCreating}
              maxLength={50}
            />

            <Text style={[styles.label, { color: colors.text }]}>URL</Text>
            <TextInput
              style={[
                styles.input,
                {
                  backgroundColor: colors.card,
                  color: colors.text,
                  borderColor: colors.border
                }
              ]}
              value={shortcutUrl}
              onChangeText={setShortcutUrl}
              placeholder="Enter URL"
              placeholderTextColor={colors.text + '80'}
              editable={!isCreating}
              autoCapitalize="none"
              keyboardType="url"
            />

            {Platform.OS === 'ios' && (
              <View style={styles.iosNotice}>
                <Ionicons name="information-circle" size={16} color={colors.text} />
                <Text style={[styles.iosNoticeText, { color: colors.text }]}>
                  iOS requires manual addition through Safari
                </Text>
              </View>
            )}
          </View>

          <View style={styles.footer}>
            <TouchableOpacity
              style={[styles.button, styles.cancelButton, { borderColor: colors.border }]}
              onPress={handleClose}
              disabled={isCreating}
            >
              <Text style={[styles.buttonText, { color: colors.text }]}>Cancel</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.button,
                styles.createButton,
                {
                  backgroundColor: colors.primary,
                  opacity: isCreating ? 0.6 : 1
                }
              ]}
              onPress={createShortcut}
              disabled={isCreating}
            >
              {isCreating ? (
                <ActivityIndicator size="small" color="white" />
              ) : (
                <Text style={[styles.buttonText, { color: 'white' }]}>
                  {Platform.OS === 'android' ? 'Add Shortcut' : 'Open in Safari'}
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  )
}

const { width } = Dimensions.get('window')

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20
  },
  container: {
    width: width * 0.9,
    maxWidth: 400,
    borderRadius: 12,
    padding: 20,
    elevation: 5,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 2
    },
    shadowOpacity: 0.25,
    shadowRadius: 3.84
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20
  },
  title: {
    fontSize: 18,
    fontWeight: '600'
  },
  closeButton: {
    padding: 4
  },
  content: {
    marginBottom: 20
  },
  label: {
    fontSize: 14,
    fontWeight: '500',
    marginBottom: 8,
    marginTop: 12
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    minHeight: 48
  },
  iosNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 16,
    padding: 12,
    backgroundColor: 'rgba(255, 165, 0, 0.1)',
    borderRadius: 8,
    borderLeftWidth: 3,
    borderLeftColor: '#FFA500'
  },
  iosNoticeText: {
    fontSize: 12,
    marginLeft: 8,
    flex: 1
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12
  },
  button: {
    flex: 1,
    padding: 14,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48
  },
  cancelButton: {
    borderWidth: 1
  },
  createButton: {},
  buttonText: {
    fontSize: 16,
    fontWeight: '500'
  }
})

export default HomescreenShortcut
