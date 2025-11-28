/**
 * Root entry point for React Native app
 * Registers FCM background handler for Android headless mode BEFORE React starts
 */

// CRITICAL: Install error handlers FIRST to catch startup errors
import { installErrorHandlers } from './utils/errorHandler'
installErrorHandlers()

// Initialize react-native-quick-crypto
import { install } from 'react-native-quick-crypto'
install()

// Then start the normal Expo app
import 'expo-router/entry'
