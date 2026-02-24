import React, { useState, useEffect, useRef, memo } from 'react'
import { View, Text, StyleSheet, ActivityIndicator, SectionList, Pressable, Platform } from 'react-native'
import { useTheme } from '@/context/theme/ThemeContext'
import { getDomainPermissions, setDomainPermission, PermissionState, PermissionType } from '@/utils/permissionsManager'
import { useTranslation } from 'react-i18next'
import SegmentedControl from '@react-native-segmented-control/segmented-control'

interface PermissionCategory {
  title: string
  data: PermissionType[]
}

const PERMISSION_CATEGORIES: PermissionCategory[] = [
  {
    title: 'Notifications',
    data: ['NOTIFICATIONS']
  },
  {
    title: 'Media',
    data: ['CAMERA', 'RECORD_AUDIO', 'READ_MEDIA_IMAGES', 'READ_MEDIA_VIDEO', 'READ_MEDIA_AUDIO']
  },
  {
    title: 'Location',
    data: ['ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION', 'ACCESS_BACKGROUND_LOCATION']
  },
  {
    title: 'Storage',
    data: ['READ_EXTERNAL_STORAGE', 'WRITE_EXTERNAL_STORAGE']
  },
  {
    title: 'Contacts',
    data: ['READ_CONTACTS', 'WRITE_CONTACTS']
  },
  {
    title: 'Calendar',
    data: ['READ_CALENDAR', 'WRITE_CALENDAR']
  },
  {
    title: 'Phone',
    data: [
      'READ_PHONE_STATE',
      'CALL_PHONE',
      'READ_CALL_LOG',
      'WRITE_CALL_LOG',
      'READ_PHONE_NUMBERS',
      'ANSWER_PHONE_CALLS'
    ]
  },
  {
    title: 'Sensors',
    data: ['BODY_SENSORS', 'ACTIVITY_RECOGNITION']
  },
  {
    title: 'Bluetooth',
    data: ['BLUETOOTH_SCAN', 'BLUETOOTH_CONNECT', 'BLUETOOTH_ADVERTISE']
  }
]

const ALL_PERMISSIONS: PermissionType[] = PERMISSION_CATEGORIES.reduce<PermissionType[]>(
  (acc, category) => [...acc, ...category.data],
  []
)

const ALWAYS_SHOW: PermissionType[] = [
  'NOTIFICATIONS',
  'CAMERA',
  'RECORD_AUDIO',
  'ACCESS_FINE_LOCATION'
]

interface PermissionsScreenProps {
  origin: string
  onPermissionChange?: (permission: PermissionType, state: PermissionState) => void
}

const PermissionsScreen: React.FC<PermissionsScreenProps> = ({ origin, onPermissionChange }) => {
  console.log('[PermissionsScreen] Rendering component with origin:', origin)
  const { colors } = useTheme()
  const { t } = useTranslation()
  const [permissions, setPermissions] = useState<Partial<Record<PermissionType, PermissionState>>>({})
  const [loading, setLoading] = useState(true)
  const [expandedCategories, setExpandedCategories] = useState<Record<string, boolean>>({})

  const lastOriginRef = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      if (!origin) {
        if (!cancelled) setLoading(false)
        return
      }
      if (lastOriginRef.current === origin && Object.keys(permissions).length > 0) {
        return
      }
      lastOriginRef.current = origin
      if (!cancelled) setLoading(true)
      const fetchedPerms = await getDomainPermissions(origin)
      const requested = new Set(Object.keys(fetchedPerms || {}) as PermissionType[])
      const visible = new Set<PermissionType>([...ALWAYS_SHOW, ...requested])

      const finalPermissions: Record<PermissionType, PermissionState> = {} as Record<PermissionType, PermissionState>
      visible.forEach(perm => {
        const fallback: PermissionState = perm === 'NOTIFICATIONS' ? 'deny' : 'ask'
        finalPermissions[perm] = (fetchedPerms?.[perm] as PermissionState) || fallback
      })

      if (cancelled) return
      setPermissions(finalPermissions)

      const initialExpandedState: Record<string, boolean> = {}
      PERMISSION_CATEGORIES.forEach(category => {
        const hasAny = category.data.some(p => p in finalPermissions)
        const isDefaultCategory = category.data.some(p => ALWAYS_SHOW.includes(p))
        const expand = isDefaultCategory && hasAny
        initialExpandedState[category.title] = expand
      })
      setExpandedCategories(initialExpandedState)
      setLoading(false)
    }
    run()
    return () => {
      cancelled = true
    }
    // Only rerun when origin changes or when local permissions are empty for first load
  }, [origin, permissions])

  const handleValueChange = (permission: PermissionType, value: string) => {
    const state = value.toLowerCase() as PermissionState
    console.log(`[PermissionsScreen] Setting ${permission} to ${state} for ${origin}`)

    setPermissions(prev => ({ ...prev, [permission]: state }))

    setDomainPermission(origin, permission, state)
      .then(() => {
        console.log(`[PermissionsScreen] Successfully updated ${permission} to ${state}`)

        // Notify parent component (Browser) about the permission change
        if (onPermissionChange) {
          console.log(`[PermissionsScreen] Notifying parent about permission change: ${permission} -> ${state}`)
          onPermissionChange(permission, state)
        }
      })
      .catch(error => {
        console.error(`[PermissionsScreen] Error setting permission:`, error)
      })
  }

  const formatPermissionName = (permission: string) => {
    const formatted = permission
      .split('_')
      .map(word => word.charAt(0) + word.slice(1).toLowerCase())
      .join(' ')
      .replace('Media', '')
      .replace('Record Audio', 'Microphone')
      .replace('Access Fine Location', 'Precise Location')
      .replace('Access Coarse Location', 'Approximate Location')
      .trim()
    return formatted
  }

  if (!origin) {
    return (
      <View style={styles.centered}>
        <Text style={{ color: colors.textSecondary }}>{t('no_domain') || 'No domain specified'}</Text>
      </View>
    )
  }

  console.log('[PermissionsScreen] Current state before rendering:', {
    origin,
    loading,
    permissionCount: Object.keys(permissions).length,
    categoriesCount: PERMISSION_CATEGORIES.length,
    allPermCount: ALL_PERMISSIONS.length
  })

  const sectionsToRender = PERMISSION_CATEGORIES.map(category => {
    const permissionsInCategory = category.data
    const isExpanded = expandedCategories[category.title] ?? false
    console.log(
      `[PermissionsScreen] Category ${category.title} has ${permissionsInCategory.length} permissions, expanded: ${isExpanded}`
    )

    const availablePermissions = permissionsInCategory.filter(perm => perm in permissions)

    console.log(
      `[PermissionsScreen] Category ${category.title} has ${availablePermissions.length} available permissions after filtering`
    )

    if (availablePermissions.length === 0) {
      return null
    }

    return {
      title: category.title,
      data: isExpanded ? availablePermissions : [],
      isExpanded: isExpanded // Add the expanded state for rendering
    }
  }).filter((section): section is { title: string; data: PermissionType[]; isExpanded: boolean } => section !== null)

  const isIOS = Platform.OS === 'ios'

  const UnifiedSegmented = ({
    values,
    selectedIndex,
    onValueChange,
    style
  }: {
    values: string[]
    selectedIndex: number
    onValueChange: (value: string) => void
    style?: any
  }) => {
    const { colors } = useTheme()
    return (
      <View
        style={[
          {
            flexDirection: 'row',
            borderRadius: 8,
            overflow: 'hidden',
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: colors.inputBorder,
            backgroundColor: colors.inputBackground,
            height: 32
          },
          style
        ]}
      >
        {values.map((label, idx) => {
          const selected = idx === selectedIndex
          return (
            <Pressable
              key={idx}
              onPress={() => onValueChange(label)}
              style={{
                flex: 1,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: selected ? colors.buttonBackground : 'transparent'
              }}
            >
              <Text style={{ color: selected ? colors.buttonText : colors.textSecondary, fontWeight: selected ? '600' : '500' }}>
                {label}
              </Text>
            </Pressable>
          )
        })}
      </View>
    )
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Text
        style={[styles.origin, { color: colors.textSecondary, borderBottomColor: colors.inputBorder }]}
        numberOfLines={1}
      >
        {origin || 'Unknown Domain'}
      </Text>

      {loading ? (
        <ActivityIndicator size="large" color={colors.primary} style={{ marginTop: 20 }} />
      ) : sectionsToRender.length === 0 ? (
        <View style={[styles.centered, { backgroundColor: colors.background }]}>
          <Text style={{ color: colors.textPrimary, fontSize: 16, textAlign: 'center' }}>
            {t('no_permissions_found') || 'No permissions available for this domain'}
          </Text>
        </View>
      ) : (
        <View style={{ flex: 1, backgroundColor: colors.background }}>
          <Text style={{ margin: 10, color: colors.textSecondary }}>
            {`${Object.keys(permissions).length} permissions found. Tap a category to expand/collapse.`}
          </Text>
          <SectionList
            style={{ flex: 1 }}
            contentContainerStyle={{ flexGrow: 1, paddingBottom: 20 }}
            sections={sectionsToRender}
            keyExtractor={item => item}
            renderSectionHeader={({ section: { title } }) => {
              const isExpanded = expandedCategories[title] ?? false
              return (
                <Pressable
                  onPress={() => setExpandedCategories(prev => ({ ...prev, [title]: !isExpanded }))}
                  style={[styles.sectionHeader, { backgroundColor: colors.inputBackground || '#f0f0f0' }]}
                >
                  <Text style={[styles.sectionHeaderText, { color: colors.textPrimary }]}>
                    {isExpanded ? '▼ ' : '▶ '}
                    {title}
                  </Text>
                </Pressable>
              )
            }}
            renderItem={({ item: perm }) => {
              if (perm === 'NOTIFICATIONS') {
                const state = (permissions[perm] as PermissionState) || (isIOS ? 'ask' : 'deny')
                const selectedIndex = isIOS ? (state === 'deny' ? 1 : 0) : state === 'allow' ? 0 : 1
                return (
                  <View style={[styles.permissionRow, { backgroundColor: colors.background }]}>
                    <Text style={[styles.permissionLabel, { color: colors.textPrimary }]}>
                      {formatPermissionName(perm)}
                    </Text>
                    {isIOS ? (
                      <UnifiedSegmented
                        values={[t('ask') || 'Ask', t('deny') || 'Deny']}
                        selectedIndex={selectedIndex}
                        onValueChange={value => {
                          const newState: PermissionState = value === (t('ask') || 'Ask') ? 'ask' : 'deny'
                          handleValueChange(perm, newState)
                        }}
                        style={{ width: 120 }}
                      />
                    ) : (
                      <SegmentedControl
                        values={[t('allow') || 'Allow', t('deny') || 'Deny']}
                        selectedIndex={selectedIndex}
                        onValueChange={value => {
                          const newState: PermissionState = value === (t('allow') || 'Allow') ? 'allow' : 'deny'
                          handleValueChange(perm, newState)
                        }}
                        tintColor={colors.buttonBackground}
                        fontStyle={{ color: colors.textPrimary }}
                        activeFontStyle={{ color: colors.buttonText, fontWeight: '600' }}
                        style={{
                          width: 120,
                          backgroundColor: colors.inputBackground,
                          borderColor: colors.inputBorder,
                          borderWidth: StyleSheet.hairlineWidth,
                          borderRadius: 8,
                          height: 32
                        }}
                      />
                    )}
                  </View>
                )
              }

              const state = (permissions[perm] as PermissionState) || 'ask'
              const selectedIndex = isIOS
                ? (state === 'deny' ? 1 : 0) // treat 'allow' as 'ask' for display on iOS
                : Math.max(['allow', 'ask', 'deny'].indexOf(state), 0)
              return (
                <View style={[styles.permissionRow, { backgroundColor: colors.background }]}>
                  <Text style={[styles.permissionLabel, { color: colors.textPrimary }]}>
                    {formatPermissionName(perm)}
                  </Text>
                  {isIOS ? (
                    <UnifiedSegmented
                      values={[t('ask') || 'Ask', t('deny') || 'Deny']}
                      selectedIndex={selectedIndex}
                      onValueChange={value => {
                        const newState: PermissionState = value === (t('ask') || 'Ask') ? 'ask' : 'deny'
                        handleValueChange(perm, newState)
                      }}
                      style={{ width: 180 }}
                    />
                  ) : (
                    <SegmentedControl
                      values={[t('allow') || 'Allow', t('ask') || 'Ask', t('deny') || 'Deny']}
                      selectedIndex={selectedIndex}
                      onValueChange={value => {
                        handleValueChange(perm, value)
                      }}
                      tintColor={colors.buttonBackground}
                      fontStyle={{ color: colors.textPrimary }}
                      activeFontStyle={{ color: colors.buttonText, fontWeight: '600' }}
                      style={{
                        width: 180,
                        backgroundColor: colors.inputBackground,
                        borderColor: colors.inputBorder,
                        borderWidth: StyleSheet.hairlineWidth,
                        borderRadius: 8,
                        height: 32
                      }}
                    />
                  )}
                </View>
              )
            }}
            ItemSeparatorComponent={() => (
              <View
                style={{
                  height: 1,
                  backgroundColor: colors.inputBorder,
                  marginLeft: 16
                }}
              />
            )}
            ListEmptyComponent={
              <View style={styles.centered}>
                <Text style={{ color: colors.textSecondary }}>
                  {t('no_permissions') || 'No permissions to display'}
                </Text>
              </View>
            }
            stickySectionHeadersEnabled={false}
          />
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 0
  },
  centered: {
    justifyContent: 'center',
    alignItems: 'center',
    flex: 1
  },
  header: {
    fontSize: 20,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 8
  },
  origin: {
    fontSize: 16,
    textAlign: 'center',
    paddingBottom: 16,
    marginBottom: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ccc'
  },
  sectionHeader: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    marginTop: 12,
    marginBottom: 4,
    borderRadius: 8,
    backgroundColor: '#f0f0f0',
    flexDirection: 'row',
    alignItems: 'center'
  },
  sectionHeaderText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#333'
  },
  permissionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
    backgroundColor: 'white'
  },
  permissionLabel: {
    fontSize: 15,
    flex: 1,
    paddingRight: 12,
    color: '#333'
  }
})

export default memo(PermissionsScreen)
