import { useEffect, useRef, useCallback } from 'react'
import { Linking, Platform } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { FIRST_TOUCH_DATE_KEY } from '@/app/_layout'
import { showAlert } from '@/components/ui/AlertCard'
import { showToast } from '@/components/ui/Toast'

const DEFAULT_BROWSER_PROMPT_KEY = 'hasShownDefaultBrowserPrompt'

/** Number of days after first launch before showing the default browser prompt */
const DEFAULT_BROWSER_PROMPT_DELAY_DAYS = 3

const markPromptShown = async () => {
  try {
    await AsyncStorage.setItem(DEFAULT_BROWSER_PROMPT_KEY, 'true')
  } catch (error) {
    console.error('Error saving prompt state:', error)
  }
}

const openDefaultBrowserSettings = async () => {
  try {
    if (Platform.OS === 'android') {
      // Try opening Android default apps settings
      const androidUrls = [
        'android.settings.MANAGE_DEFAULT_APPS_SETTINGS',
        'android.settings.APPLICATION_SETTINGS',
        'android.settings.SETTINGS'
      ]

      let opened = false
      for (const url of androidUrls) {
        try {
          const canOpen = await Linking.canOpenURL(url)
          if (canOpen) {
            await Linking.openURL(url)
            opened = true
            break
          }
        } catch {
          // Next URL
        }
      }

      if (!opened) {
        await Linking.openSettings()
      }
    } else if (Platform.OS === 'ios') {
      // Show iOS instructions
      const choice = await showAlert({
        title: 'Set Default Browser',
        message: 'To set BSV Browser as your default browser:\n\n1. Go to Settings\n2. Scroll down to BSV Browser\n3. Tap "Default Browser App"\n4. Select BSV Browser',
        buttons: [
          { text: 'Cancel', style: 'cancel', key: 'cancel' },
          { text: 'Open Settings', key: 'open' },
        ],
      })
      if (choice === 'open') Linking.openSettings()
    }

    await markPromptShown()
  } catch (error) {
    console.error('Error opening settings:', error)
    showToast('Could not open settings. Please manually set BSV Browser as your default browser in your device settings.', { type: 'error' })
    await markPromptShown()
  }
}

const showDefaultBrowserPrompt = async () => {
  const choice = await showAlert({
    title: 'Set as Default Browser',
    message: 'Would you like to set BSV Browser as your default browser? This will allow you to open web links directly in BSV Browser.',
    buttons: [
      { text: 'Not Now', style: 'cancel', key: 'later' },
      { text: 'Set as Default', key: 'set' },
    ],
  })
  if (choice === 'set') await openDefaultBrowserSettings()
  else if (choice === 'later') await markPromptShown()
}

export default function DefaultBrowserPrompt() {
  const hasCheckedRef = useRef(false)

  const checkAndShowPrompt = useCallback(async () => {
    if (hasCheckedRef.current) return

    hasCheckedRef.current = true

    try {
      const hasShown = await AsyncStorage.getItem(DEFAULT_BROWSER_PROMPT_KEY)
      if (hasShown) return

      // Only show after the user has been using the app for a few days
      const firstTouch = await AsyncStorage.getItem(FIRST_TOUCH_DATE_KEY)
      if (!firstTouch) return // No first-touch date yet, skip this launch

      const daysSinceFirstTouch = (Date.now() - new Date(firstTouch).getTime()) / (1000 * 60 * 60 * 24)
      if (daysSinceFirstTouch < DEFAULT_BROWSER_PROMPT_DELAY_DAYS) return

      // Show prompt after app loads
      setTimeout(() => {
        showDefaultBrowserPrompt()
      }, 2000)
    } catch (error) {
      console.error('Error checking default browser prompt:', error)
    }
  }, [])

  useEffect(() => {
    checkAndShowPrompt()
  }, [checkAndShowPrompt])

  return null
}

export const showManualDefaultBrowserPrompt = async () => {
  const choice = await showAlert({
    title: 'Set as Default Browser',
    message: 'Set BSV Browser as your default browser to open web links directly in the app.',
    buttons: [
      { text: 'Cancel', style: 'cancel', key: 'cancel' },
      { text: 'Open Settings', key: 'open' },
    ],
  })
  if (choice !== 'open') return

  if (Platform.OS === 'android') {
    Linking.openSettings()
  } else {
    const iosChoice = await showAlert({
      title: 'Set Default Browser',
      message: 'To set BSV Browser as your default browser:\n\n1. Go to Settings\n2. Scroll down to BSV Browser\n3. Tap "Default Browser App"\n4. Select BSV Browser',
      buttons: [
        { text: 'Cancel', style: 'cancel', key: 'cancel' },
        { text: 'Open Settings', key: 'open' },
      ],
    })
    if (iosChoice === 'open') Linking.openSettings()
  }
}
