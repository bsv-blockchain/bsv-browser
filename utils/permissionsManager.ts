import AsyncStorage from '@react-native-async-storage/async-storage'
import { check, request, PERMISSIONS, RESULTS } from 'react-native-permissions'
import { Platform } from 'react-native'

/**
 * Defines the types of permissions a website can request.
 */
export type PermissionType =
  | 'ACCEPT_HANDOVER'
  | 'ACCESS_BACKGROUND_LOCATION'
  | 'ACCESS_COARSE_LOCATION'
  | 'ACCESS_FINE_LOCATION'
  | 'ACCESS_MEDIA_LOCATION'
  | 'ACTIVITY_RECOGNITION'
  | 'ADD_VOICEMAIL'
  | 'ANSWER_PHONE_CALLS'
  | 'BLUETOOTH_ADVERTISE'
  | 'BLUETOOTH_CONNECT'
  | 'BLUETOOTH_SCAN'
  | 'BODY_SENSORS'
  | 'BODY_SENSORS_BACKGROUND'
  | 'CALL_PHONE'
  | 'CAMERA'
  | 'GET_ACCOUNTS'
  | 'NEARBY_WIFI_DEVICES'
  | 'PROCESS_OUTGOING_CALLS'
  | 'READ_CALENDAR'
  | 'READ_CALL_LOG'
  | 'READ_CONTACTS'
  | 'READ_EXTERNAL_STORAGE'
  | 'READ_MEDIA_AUDIO'
  | 'READ_MEDIA_IMAGES'
  | 'READ_MEDIA_VIDEO'
  | 'READ_MEDIA_VISUAL_USER_SELECTED'
  | 'READ_PHONE_NUMBERS'
  | 'READ_PHONE_STATE'
  | 'READ_SMS'
  | 'RECEIVE_MMS'
  | 'RECEIVE_SMS'
  | 'RECEIVE_WAP_PUSH'
  | 'RECORD_AUDIO'
  | 'SEND_SMS'
  | 'USE_SIP'
  | 'UWB_RANGING'
  | 'WRITE_CALENDAR'
  | 'WRITE_CALL_LOG'
  | 'WRITE_CONTACTS'
  | 'WRITE_EXTERNAL_STORAGE'

// Platform-specific permission mapping
const platformPermissionMap: Partial<Record<PermissionType, any>> =
  Platform.select({
    android: {
      CAMERA: PERMISSIONS.ANDROID.CAMERA,
      RECORD_AUDIO: PERMISSIONS.ANDROID.RECORD_AUDIO,
      ACCESS_FINE_LOCATION: PERMISSIONS.ANDROID.ACCESS_FINE_LOCATION,
      ACCESS_COARSE_LOCATION: PERMISSIONS.ANDROID.ACCESS_COARSE_LOCATION,
      READ_EXTERNAL_STORAGE: PERMISSIONS.ANDROID.READ_EXTERNAL_STORAGE,
      WRITE_EXTERNAL_STORAGE: PERMISSIONS.ANDROID.WRITE_EXTERNAL_STORAGE,
      READ_CONTACTS: PERMISSIONS.ANDROID.READ_CONTACTS,
      WRITE_CONTACTS: PERMISSIONS.ANDROID.WRITE_CONTACTS,
      READ_CALENDAR: PERMISSIONS.ANDROID.READ_CALENDAR,
      WRITE_CALENDAR: PERMISSIONS.ANDROID.WRITE_CALENDAR,
      READ_PHONE_STATE: PERMISSIONS.ANDROID.READ_PHONE_STATE,
      CALL_PHONE: PERMISSIONS.ANDROID.CALL_PHONE,
      READ_CALL_LOG: PERMISSIONS.ANDROID.READ_CALL_LOG,
      WRITE_CALL_LOG: PERMISSIONS.ANDROID.WRITE_CALL_LOG,
      ADD_VOICEMAIL: PERMISSIONS.ANDROID.ADD_VOICEMAIL,
      USE_SIP: PERMISSIONS.ANDROID.USE_SIP,
      PROCESS_OUTGOING_CALLS: PERMISSIONS.ANDROID.PROCESS_OUTGOING_CALLS,
      BODY_SENSORS: PERMISSIONS.ANDROID.BODY_SENSORS,
      SEND_SMS: PERMISSIONS.ANDROID.SEND_SMS,
      RECEIVE_SMS: PERMISSIONS.ANDROID.RECEIVE_SMS,
      READ_SMS: PERMISSIONS.ANDROID.READ_SMS,
      RECEIVE_WAP_PUSH: PERMISSIONS.ANDROID.RECEIVE_WAP_PUSH,
      RECEIVE_MMS: PERMISSIONS.ANDROID.RECEIVE_MMS,
      // READ_CELL_BROADCASTS is not available in the current version of react-native-permissions
      ACCESS_BACKGROUND_LOCATION: PERMISSIONS.ANDROID.ACCESS_BACKGROUND_LOCATION,
      ACCEPT_HANDOVER: PERMISSIONS.ANDROID.ACCEPT_HANDOVER,
      ACTIVITY_RECOGNITION: PERMISSIONS.ANDROID.ACTIVITY_RECOGNITION,
      ANSWER_PHONE_CALLS: PERMISSIONS.ANDROID.ANSWER_PHONE_CALLS,
      READ_PHONE_NUMBERS: PERMISSIONS.ANDROID.READ_PHONE_NUMBERS,
      UWB_RANGING: PERMISSIONS.ANDROID.UWB_RANGING,
      BLUETOOTH_SCAN: PERMISSIONS.ANDROID.BLUETOOTH_SCAN,
      BLUETOOTH_CONNECT: PERMISSIONS.ANDROID.BLUETOOTH_CONNECT,
      BLUETOOTH_ADVERTISE: PERMISSIONS.ANDROID.BLUETOOTH_ADVERTISE,
      NEARBY_WIFI_DEVICES: PERMISSIONS.ANDROID.NEARBY_WIFI_DEVICES,
      READ_MEDIA_IMAGES: PERMISSIONS.ANDROID.READ_MEDIA_IMAGES,
      READ_MEDIA_VIDEO: PERMISSIONS.ANDROID.READ_MEDIA_VIDEO,
      READ_MEDIA_AUDIO: PERMISSIONS.ANDROID.READ_MEDIA_AUDIO
    },
    ios: {
      // iOS permissions will be added later
      // For now, we'll just have placeholders for the most common ones
      CAMERA: PERMISSIONS.IOS.CAMERA,
      RECORD_AUDIO: PERMISSIONS.IOS.MICROPHONE,
      ACCESS_FINE_LOCATION: PERMISSIONS.IOS.LOCATION_WHEN_IN_USE,
      ACCESS_COARSE_LOCATION: PERMISSIONS.IOS.LOCATION_WHEN_IN_USE
    }
  }) || {}

/**
 * Represents the state of a given permission: granted, denied, or requires a prompt.
 */
export type PermissionState = 'allow' | 'deny' | 'ask'

/**
 * A record of permission states for a specific domain.
 */
export type DomainPermissions = Partial<Record<PermissionType, PermissionState>>

/**
 * The shape of the entire permissions store, mapping domains to their permissions.
 */
export interface PermissionsStore {
  [domain: string]: DomainPermissions
}

const STORAGE_KEY = 'PERMISSIONS_STORE_V1'

/**
 * Retrieves the entire permissions store from AsyncStorage.
 * @returns {Promise<PermissionsStore>} The permissions store object.
 */
export async function getPermissionsStore(): Promise<PermissionsStore> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    // Basic validation to ensure it's an object
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed
    }
    return {}
  } catch (error) {
    console.error('Failed to get permissions store:', error)
    return {} // Return empty object on error
  }
}

/**
 * Saves the entire permissions store to AsyncStorage.
 * @param {PermissionsStore} store - The permissions store to save.
 */
export async function setPermissionsStore(store: PermissionsStore): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch (error) {
    console.error('Failed to set permissions store:', error)
  }
}

/**
 * Gets all permissions for a specific domain.
 * @param {string} domain - The domain to retrieve permissions for.
 * @returns {Promise<DomainPermissions>} An object of permissions for the domain.
 */
export async function getDomainPermissions(domain: string): Promise<DomainPermissions> {
  const store = await getPermissionsStore()
  return store[domain] || {}
}

/**
 * Sets the state for a specific permission on a given domain.
 * @param {string} domain - The domain to set the permission for.
 * @param {PermissionType} permission - The permission type.
 * @param {PermissionState} state - The new state for the permission.
 */
export async function setDomainPermission(
  domain: string,
  permission: PermissionType,
  state: PermissionState
): Promise<void> {
  try {
    const store = await getPermissionsStore()
    if (!store[domain]) {
      store[domain] = {}
    }
    store[domain][permission] = state
    await setPermissionsStore(store)
  } catch (error) {
    console.error(`Failed to set permission ${permission} for ${domain}:`, error)
  }
}

/**
 * Resets all permissions for a specific domain.
 * @param {string} domain - The domain whose permissions will be reset.
 */
export async function resetDomainPermissions(domain: string): Promise<void> {
  try {
    const store = await getPermissionsStore()
    if (store[domain]) {
      delete store[domain]
      await setPermissionsStore(store)
    }
  } catch (error) {
    console.error(`Failed to reset permissions for ${domain}:`, error)
  }
}

/**
 * Resets the entire permissions store for all domains.
 */
export async function resetAllPermissions(): Promise<void> {
  await setPermissionsStore({})
}

/**
 * Gets the current state of a single permission for a domain.
 * @param {string} domain - The domain to check.
 * @param {PermissionType} permission - The permission to check.
 * @returns {Promise<PermissionState>} The current state of the permission.
 */
export async function getPermissionState(domain: string, permission: PermissionType): Promise<PermissionState> {
  const domainPerms = await getDomainPermissions(domain)
  return domainPerms[permission] || 'ask'
}

export async function checkPermissionForDomain(domain: string, permission: PermissionType): Promise<boolean> {
  const domainState = await getPermissionState(domain, permission)

  if (domainState === 'deny') return false
  if (domainState === 'ask') {
    // We'll handle the UI prompt in the browser component
    // For now, just return false as we haven't shown the prompt yet
    return false
  }

  const osPermission = platformPermissionMap[permission]
  if (!osPermission) {
    console.warn(`No OS permission mapping found for ${permission}`)
    return false
  }

  const result = await check(osPermission as any)
  if (result === RESULTS.GRANTED) return true

  const requestResult = await request(osPermission as any)
  return requestResult === RESULTS.GRANTED
}
