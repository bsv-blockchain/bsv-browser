import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  Image,
  Alert,
  Modal,
  ActivityIndicator,
  Platform
} from 'react-native'
import CustomSafeArea from '@/components/CustomSafeArea'
import { StatusBar } from 'expo-status-bar'
import { Ionicons } from '@expo/vector-icons'
import Clipboard from '@react-native-clipboard/clipboard'
import { useNavigation } from '@react-navigation/native'
import { useTranslation } from 'react-i18next'

// THEME (existing in your project)
import { useTheme } from '@/context/theme/ThemeContext'

// SETTINGS CONTEXT (same semantics as web app)
// NOTE: adjust the import path if your WalletContext lives elsewhere
import { useWallet } from '@/context/WalletContext'

// VALIDATION util (mirrors your web validateTrust utility)
// NOTE: adjust path if different in mobile project
import validateTrust from '@/utils/validateTrust'

// -------------------- Types --------------------
export type Certifier = {
  name: string
  description: string
  icon?: string  // Made optional to match wallet library
  identityKey: string
  trust: number // 1..10
}

// -------------------- Helpers --------------------
const maskKey = (k: string) => (k?.length > 16 ? `${k.slice(0, 8)}...${k.slice(-8)}` : k)

const deepEqualCertifierArrays = (a: Certifier[], b: Certifier[]) => {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  const norm = (arr: Certifier[]) =>
    [...arr]
      .map(x => ({
        name: x.name,
        description: x.description,
        icon: x.icon,
        identityKey: x.identityKey,
        trust: x.trust
      }))
      .sort((x, y) => (x.identityKey > y.identityKey ? 1 : -1))
  const A = norm(a)
  const B = norm(b)
  for (let i = 0; i < A.length; i++) {
    const x = A[i]
    const y = B[i]
    if (
      x.name !== y.name ||
      x.description !== y.description ||
      x.icon !== y.icon ||
      x.identityKey !== y.identityKey ||
      x.trust !== y.trust
    ) {
      return false
    }
  }
  return true
}

const fetchWithTimeout = async (url: string, ms: number) => {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), ms)
  try {
    const res = await fetch(url, { signal: controller.signal })
    return res
  } finally {
    clearTimeout(id)
  }
}

// -------------------- Main Screen --------------------
export default function TrustScreen() {
  const { t } = useTranslation()
  const { colors, isDark } = useTheme()
  const navigation = useNavigation()

  const { settings, updateSettings } = useWallet()

  // Source of truth from Settings
  const initialTrusted: Certifier[] = settings?.trustSettings?.trustedCertifiers || []
  const initialThreshold: number = settings?.trustSettings?.trustLevel || 2

  // Local working state
  const [trustedEntities, setTrustedEntities] = useState<Certifier[]>(initialTrusted)
  const [trustLevel, setTrustLevel] = useState<number>(initialThreshold)
  const [query, setQuery] = useState('')
  const [saving, setSaving] = useState(false)
  const [snack, setSnack] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)

  const totalTrustPoints = useMemo(
    () => trustedEntities.reduce((sum, e) => sum + (Number(e.trust) || 0), 0),
    [trustedEntities]
  )

  // Clamp threshold to available points (parity with web)
  useEffect(() => {
    if (trustLevel > totalTrustPoints && totalTrustPoints > 0) {
      setTrustLevel(totalTrustPoints)
    }
  }, [totalTrustPoints, trustLevel])

  // Detect unsaved changes (parity with web)
  const settingsNeedsUpdate =
    (settings?.trustSettings?.trustLevel ?? 0) !== trustLevel ||
    !deepEqualCertifierArrays(settings?.trustSettings?.trustedCertifiers || [], trustedEntities)

  // Save to settings (parity with web)
  const handleSave = useCallback(async (): Promise<boolean> => {
    try {
      setSaving(true)
      await updateSettings(
        JSON.parse(
          JSON.stringify({
            ...settings,
            trustSettings: {
              trustLevel,
              trustedCertifiers: trustedEntities
            }
          })
        )
      )
      setSnack(t('trust_updated') || 'Trust relationships updated!')
      return true
    } catch (e: any) {
      setSnack(e?.message || (t('failed_to_save') as string) || 'Failed to save settings')
      return false
    } finally {
      setSaving(false)
    }
  }, [updateSettings, settings, trustLevel, trustedEntities, t])

  // Block leaving the screen if there are unsaved changes
  useEffect(() => {
    const sub = navigation.addListener('beforeRemove', (e: any) => {
      if (!settingsNeedsUpdate) return
      e.preventDefault()
      Alert.alert(
        t('unsaved_changes') || 'Unsaved Changes',
        t('save_before_leaving') || 'You have unsaved changes. Do you want to save them before leaving?',
        [
          { text: t('dont_save') || "Don't Save", style: 'destructive', onPress: () => navigation.dispatch(e.data.action) },
          { text: t('cancel') || 'Cancel', style: 'cancel' },
          {
            text: t('save') || 'Save',
            onPress: async () => {
              const ok = await handleSave()
              if (ok) navigation.dispatch(e.data.action)
            }
          }
        ]
      )
    })
    return sub
  }, [navigation, settingsNeedsUpdate, trustLevel, trustedEntities, handleSave, t])

  // Search
  const filtered = useMemo(() => {
    if (!query.trim()) return trustedEntities
    const q = query.toLowerCase()
    return trustedEntities.filter(
      e => e.name.toLowerCase().includes(q) || e.description?.toLowerCase?.().includes(q)
    )
  }, [trustedEntities, query])

  const onChangeTrust = (identityKey: string, v: number) => {
    setTrustedEntities(prev => prev.map(c => (c.identityKey === identityKey ? { ...c, trust: v } : c)))
  }

  const onRemove = (identityKey: string) => {
    Alert.alert(
      t('confirm_delete') || 'Delete Trust Relationship',
      t('confirm_delete_body') || 'Are you sure you want to delete this trust relationship? This cannot be undone.',
      [
        { text: t('cancel') || 'Cancel', style: 'cancel' },
        {
          text: t('delete') || 'Delete',
          style: 'destructive',
          onPress: () => setTrustedEntities(prev => prev.filter(c => c.identityKey !== identityKey))
        }
      ]
    )
  }

  const copyKey = (identityKey: string) => {
    Clipboard.setString(identityKey)
    setSnack(t('copied') || 'Copied!')
  }

  return (
    <CustomSafeArea style={[styles.container, { backgroundColor: colors.background }]}>
      <StatusBar style={isDark ? 'light' : 'dark'} />

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingBottom: settingsNeedsUpdate ? 80 : 96 // Padding for save bar
        }}
        scrollEnabled={true}
        showsVerticalScrollIndicator={true}
        bounces={true}
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled={true}
        removeClippedSubviews={false}
        scrollEventThrottle={16}
        contentInsetAdjustmentBehavior="automatic"
      >
        {/* Header */}
        <View style={styles.header}>
          <Text style={[styles.title, { color: colors.textPrimary }]}>Trust</Text>
          <Text style={[styles.desc, { color: colors.textSecondary }]}>
            Give points to show which certifiers you trust the most to confirm the identity of counterparties. More points mean a higher priority.
          </Text>

          {/* Search + Add */}
          <View style={styles.row}>
            <View style={[styles.searchWrap, { borderColor: colors.inputBorder, backgroundColor: colors.inputBackground }]}>
              <Ionicons name="search" size={16} color={colors.textSecondary} style={{ marginRight: 8 }} />
              <TextInput
                style={[styles.searchInput, { color: colors.textPrimary }]}
                placeholder={'Search'}
                placeholderTextColor={colors.textSecondary}
                value={query}
                onChangeText={setQuery}
              />
            </View>
            <TouchableOpacity style={[styles.addBtn, { backgroundColor: colors.primary }]} onPress={() => setShowAdd(true)}>
              <Ionicons name="add" size={16} color={colors.background} />
              <Text style={[styles.addBtnText, { color: colors.background }]}>Add Provider</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Threshold */}
        <View style={[styles.thresholdCard, { borderColor: colors.inputBorder }]}>
          <Text style={[styles.thresholdTitle, { color: colors.textPrimary }]}>Trust Threshold</Text>
          <Text style={[styles.thresholdDesc, { color: colors.textSecondary }]}>
            You&apos;ve given out a total of <Text style={{ fontWeight: '700', color: colors.textPrimary }}>{totalTrustPoints} {totalTrustPoints === 1 ? 'point' : 'points'}</Text>.
            Set the minimum points any counterparty must have across your trust network to be shown.
          </Text>

          <View style={styles.thresholdRow}>
            <Text style={[styles.thresholdValue, { color: colors.textPrimary }]}>
              <Text style={{ fontWeight: '700' }}>{trustLevel}</Text> / {Math.max(totalTrustPoints, 1)}
            </Text>

            {/* Simple stepper to avoid extra slider deps */}
            <View style={styles.stepper}>
              <TouchableOpacity
                onPress={() => setTrustLevel(v => Math.max(1, Math.min(v - 1, Math.max(totalTrustPoints, 1))))}
                style={[styles.stepBtn, { borderColor: colors.inputBorder }]}
              >
                <Ionicons name="remove" size={18} color={colors.textPrimary} />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setTrustLevel(v => Math.max(1, Math.min(v + 1, Math.max(totalTrustPoints, 1))))}
                style={[styles.stepBtn, { borderColor: colors.inputBorder }]}
              >
                <Ionicons name="add" size={18} color={colors.textPrimary} />
              </TouchableOpacity>
            </View>
          </View>
        </View>

        {/* Certifier List */}
        <View style={{ paddingHorizontal: 8 }}>
          {filtered.length === 0 ? (
            <View style={styles.emptyBox}>
              <Text style={{ color: colors.textSecondary }}>No certifiers yet.</Text>
            </View>
          ) : (
            filtered.map((item) => (
              <View key={item.identityKey} style={[styles.card, { borderColor: colors.inputBorder, backgroundColor: colors.paperBackground }]}>
                <View style={styles.cardHeader}>
                  <View style={styles.rowLeft}>
                    {item.icon ? (
                      <Image source={{ uri: item.icon }} style={styles.icon} />
                    ) : (
                      <View style={[styles.placeholderIcon, { backgroundColor: colors.primary }]}>
                        <Text style={{ color: colors.background, fontWeight: '700' }}>{item.name?.[0] || '?'}</Text>
                      </View>
                    )}
                    <View style={{ flex: 1 }}>
                      <View style={[styles.row, { justifyContent: 'space-between' }]}>
                        <Text style={[styles.itemName, { color: colors.textPrimary }]} numberOfLines={1}>
                          {item.name}
                        </Text>
                        <TouchableOpacity onPress={() => onRemove(item.identityKey)}>
                          <Ionicons name="close" size={18} color={colors.error} />
                        </TouchableOpacity>
                      </View>
                      <Text style={[styles.itemDesc, { color: colors.textSecondary }]} numberOfLines={2}>
                        {item.description}
                      </Text>

                      {/* Key row */}
                      <View style={[styles.keyRow, { borderColor: colors.inputBorder, backgroundColor: colors.inputBackground }]}>
                        <Ionicons name="information-circle-outline" size={14} color={colors.textSecondary} style={{ marginRight: 6 }} />
                        <Text style={[styles.keyText, { color: colors.textPrimary }]}>{maskKey(item.identityKey)}</Text>
                        <TouchableOpacity onPress={() => copyKey(item.identityKey)} style={{ padding: 4, marginLeft: 'auto' }}>
                          <Ionicons name="copy-outline" size={14} color={colors.textSecondary} />
                        </TouchableOpacity>
                      </View>

                      {/* Trust row */}
                      <View style={[styles.row, { marginTop: 8, alignItems: 'center' }]}>
                        <View style={[styles.chip, { backgroundColor: colors.inputBackground }]}>
                          <Text style={{ fontSize: 12, color: colors.textSecondary }}>Trust Level: </Text>
                          <Text style={{ fontSize: 12, fontWeight: '700', color: colors.textPrimary }}>{item.trust}/10</Text>
                        </View>
                        <View style={styles.stepperSmall}>
                          <TouchableOpacity
                            onPress={() => onChangeTrust(item.identityKey, Math.max(1, Math.min((item.trust || 1) - 1, 10)))}
                            style={[styles.stepBtnSmall, { borderColor: colors.inputBorder }]}
                          >
                            <Ionicons name="remove" size={14} color={colors.textPrimary} />
                          </TouchableOpacity>
                          <TouchableOpacity
                            onPress={() => onChangeTrust(item.identityKey, Math.max(1, Math.min((item.trust || 1) + 1, 10)))}
                            style={[styles.stepBtnSmall, { borderColor: colors.inputBorder }]}
                          >
                            <Ionicons name="add" size={14} color={colors.textPrimary} />
                          </TouchableOpacity>
                        </View>
                      </View>
                    </View>
                  </View>
                </View>
              </View>
            ))
          )}
        </View>
      </ScrollView>

      {/* Non-Absolute Save Bar */}
      {settingsNeedsUpdate && (
        <View style={[styles.saveBarFixed, { backgroundColor: colors.paperBackground, borderTopColor: colors.inputBorder }]}>
          <Text style={{ color: colors.textSecondary }}>You have unsaved changes</Text>
          <TouchableOpacity
            onPress={handleSave}
            disabled={saving}
            style={[styles.saveBtn, { backgroundColor: colors.primary, opacity: saving ? 0.6 : 1 }]}
          >
            {saving ? (
              <ActivityIndicator size="small" color={colors.background} />
            ) : (
              <Text style={{ color: colors.background, fontWeight: '700' }}>Save</Text>
            )}
          </TouchableOpacity>
        </View>
      )}

      {/* Simple snack */}
      {snack && (
        <TouchableOpacity
          activeOpacity={0.9}
          onPress={() => setSnack(null)}
          style={[styles.snack, { backgroundColor: colors.paperBackground, borderColor: colors.inputBorder }]}
        >
          <Text style={{ color: colors.textPrimary }}>{snack}</Text>
        </TouchableOpacity>
      )}

      {/* Add Provider Modal */}
      <AddProviderModal
        visible={showAdd}
        onClose={() => setShowAdd(false)}
        onAdd={(c) => {
          // prevent dupes by identityKey
          if (trustedEntities.some(x => x.identityKey === c.identityKey)) {
            setSnack('An entity with this public key is already in the list!')
            return
          }
          setTrustedEntities(prev => [{ ...c, trust: 5 }, ...prev])
          setShowAdd(false)
        }}
        colors={colors}
      />
    </CustomSafeArea>
  )
}

// -------------------- Add Provider Modal --------------------
function AddProviderModal({
  visible,
  onClose,
  onAdd,
  colors
}: {
  visible: boolean
  onClose: () => void
  onAdd: (c: Omit<Certifier, 'trust'>) => void
  colors: any
}) {
  const [advanced, setAdvanced] = useState(false)
  const [domain, setDomain] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [icon, setIcon] = useState('')
  const [identityKey, setIdentityKey] = useState('')
  const [loading, setLoading] = useState(false)
  const [fieldsValid, setFieldsValid] = useState(false)

  const [domainError, setDomainError] = useState<string | null>(null)
  const [nameError, setNameError] = useState<string | null>(null)
  const [iconError, setIconError] = useState<string | null>(null)
  const [keyError, setKeyError] = useState<string | null>(null)

  useEffect(() => {
    if (!visible) {
      // reset
      setAdvanced(false)
      setDomain('')
      setName('')
      setDescription('')
      setIcon('')
      setIdentityKey('')
      setFieldsValid(false)
      setDomainError(null)
      setNameError(null)
      setIconError(null)
      setKeyError(null)
    }
  }, [visible])

  const handleDomainSubmit = async () => {
    try {
      if (!domain) return
      setLoading(true)
      setDomainError(null)
      const url = domain.startsWith('http') ? `${domain}/manifest.json` : `https://${domain}/manifest.json`
      let res: Response
      try {
        res = await fetchWithTimeout(url, 15000)
      } catch (e: any) {
        if (e?.name === 'AbortError') throw new Error('The domain did not respond within 15 seconds')
        throw new Error('Could not fetch the trust data from that domain (it needs to follow the BRC-68 protocol)')
      }
      if (!res.ok) throw new Error('Failed to fetch trust manifest from that domain')
      const json = await res.json()
      const trust = json?.babbage?.trust
      if (!json?.babbage || !trust || typeof trust !== 'object') {
        throw new Error('This domain does not support importing a trust relationship (it needs to follow the BRC-68 protocol)')
      }
      await validateTrust(trust)
      setName(trust.name)
      setDescription(trust.note)
      setIcon(trust.icon)
      setIdentityKey(trust.publicKey)
      setFieldsValid(true)
    } catch (e: any) {
      setFieldsValid(false)
      setDomainError(e?.message || 'Failed to import trust relationship')
    } finally {
      setLoading(false)
    }
  }

  const handleDirectValidate = async () => {
    try {
      setLoading(true)
      setNameError(null)
      setIconError(null)
      setKeyError(null)
      await validateTrust({ name, icon, publicKey: identityKey }, { skipNote: true })
      setDescription(name)
      setFieldsValid(true)
    } catch (e: any) {
      setFieldsValid(false)
      // mimic web error shape: e.field can be 'name' | 'icon' | 'publicKey'
      if (e?.field === 'name') setNameError(e.message)
      else if (e?.field === 'icon') setIconError(e.message)
      else setKeyError(e?.message || 'Invalid public key')
    } finally {
      setLoading(false)
    }
  }

  const descriptionInvalid = !description || description.length < 5 || description.length > 50

  const ready = fieldsValid && !descriptionInvalid

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={[styles.modalCard, { backgroundColor: colors.paperBackground, borderColor: colors.inputBorder }]}>
          <View style={[styles.row, { justifyContent: 'space-between', marginBottom: 12 }]}>
            <Text style={[styles.modalTitle, { color: colors.textPrimary }]}>Add Provider</Text>
            <TouchableOpacity onPress={onClose}>
              <Ionicons name="close" size={20} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          {!advanced ? (
            <>
              <Text style={{ color: colors.textSecondary, marginBottom: 8 }}>Enter the domain name for the provider you&apos;d like to add.</Text>
              <View style={[styles.inputRow, { borderColor: colors.inputBorder, backgroundColor: colors.inputBackground }]}>
                <Ionicons name="globe-outline" size={16} color={colors.textSecondary} style={{ marginRight: 8 }} />
                <TextInput
                  placeholder="trustedentity.com"
                  placeholderTextColor={colors.textSecondary}
                  value={domain}
                  onChangeText={t => {
                    setDomain(t)
                    setDomainError(null)
                    setFieldsValid(false)
                  }}
                  style={[styles.textInput, { color: colors.textPrimary }]}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
              {!!domainError && <Text style={[styles.err, { color: colors.error }]}>{domainError}</Text>}
              {loading ? (
                <ActivityIndicator style={{ marginTop: 12 }} />
              ) : (
                <TouchableOpacity onPress={handleDomainSubmit} style={[styles.primaryBtn, { backgroundColor: colors.primary }]}>
                  <Ionicons name="document-text-outline" size={16} color={colors.background} />
                  <Text style={[styles.primaryBtnText, { color: colors.background }]}>Get Provider Details</Text>
                </TouchableOpacity>
              )}
            </>
          ) : (
            <>
              <Text style={{ color: colors.textSecondary, marginBottom: 8 }}>Directly enter the details for the provider you&apos;d like to add.</Text>

              {/* Name */}
              <View style={[styles.inputRow, { borderColor: colors.inputBorder, backgroundColor: colors.inputBackground }]}>
                <Ionicons name="person-outline" size={16} color={colors.textSecondary} style={{ marginRight: 8 }} />
                <TextInput
                  placeholder="Entity Name"
                  placeholderTextColor={colors.textSecondary}
                  value={name}
                  onChangeText={t => {
                    setName(t)
                    setNameError(null)
                    setFieldsValid(false)
                  }}
                  style={[styles.textInput, { color: colors.textPrimary }]}
                />
              </View>
              {!!nameError && <Text style={[styles.err, { color: colors.error }]}>{nameError}</Text>}

              {/* Icon */}
              <View style={[styles.inputRow, { borderColor: colors.inputBorder, backgroundColor: colors.inputBackground }]}>
                <Ionicons name="image-outline" size={16} color={colors.textSecondary} style={{ marginRight: 8 }} />
                <TextInput
                  placeholder="https://trustedentity.com/icon.png"
                  placeholderTextColor={colors.textSecondary}
                  value={icon}
                  onChangeText={t => {
                    setIcon(t)
                    setIconError(null)
                    setFieldsValid(false)
                  }}
                  style={[styles.textInput, { color: colors.textPrimary }]}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
              {!!iconError && <Text style={[styles.err, { color: colors.error }]}>{iconError}</Text>}

              {/* Public key */}
              <View style={[styles.inputRow, { borderColor: colors.inputBorder, backgroundColor: colors.inputBackground }]}>
                <Ionicons name="key-outline" size={16} color={colors.textSecondary} style={{ marginRight: 8 }} />
                <TextInput
                  placeholder="0295bf1c7842d14b..."
                  placeholderTextColor={colors.textSecondary}
                  value={identityKey}
                  onChangeText={t => {
                    setIdentityKey(t)
                    setKeyError(null)
                    setFieldsValid(false)
                  }}
                  style={[styles.textInput, { color: colors.textPrimary }]}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
              {!!keyError && <Text style={[styles.err, { color: colors.error }]}>{keyError}</Text>}

              {loading ? (
                <ActivityIndicator style={{ marginTop: 12 }} />
              ) : (
                <TouchableOpacity onPress={handleDirectValidate} style={[styles.primaryBtn, { backgroundColor: colors.primary }]}>
                  <Ionicons name="shield-checkmark-outline" size={16} color={colors.background} />
                  <Text style={[styles.primaryBtnText, { color: colors.background }]}>Validate Details</Text>
                </TouchableOpacity>
              )}
            </>
          )}

          {/* Toggle advanced */}
          <TouchableOpacity onPress={() => setAdvanced(v => !v)} style={styles.advancedBtn}>
            <Ionicons name={advanced ? 'chevron-up-outline' : 'chevron-down-outline'} size={16} color={colors.textPrimary} />
            <Text style={{ marginLeft: 6, color: colors.textPrimary }}>{advanced ? 'Hide' : 'Show'} Advanced</Text>
          </TouchableOpacity>

          {/* Preview + description edit */}
          {fieldsValid && (
            <View style={[styles.previewBox, { borderColor: colors.inputBorder, backgroundColor: colors.inputBackground }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                {icon ? (
                  <Image source={{ uri: icon }} style={styles.previewIcon} />
                ) : (
                  <View style={[styles.previewIcon, { backgroundColor: colors.primary, justifyContent: 'center', alignItems: 'center' }]}>
                    <Text style={{ color: colors.background, fontWeight: '700' }}>{name?.[0] || '?'}</Text>
                  </View>
                )}
                <View style={{ marginLeft: 12, flex: 1 }}>
                  <Text style={{ fontWeight: '700', color: colors.textPrimary }}>{name}</Text>
                  <Text style={{ color: colors.textSecondary, fontSize: 12 }}>{maskKey(identityKey)}</Text>
                </View>
              </View>

              <View style={[styles.inputRow, { marginTop: 12, borderColor: colors.inputBorder, backgroundColor: colors.inputBackground }]}>
                <Ionicons name="pricetag-outline" size={16} color={colors.textSecondary} style={{ marginRight: 8 }} />
                <TextInput
                  placeholder="Description"
                  placeholderTextColor={colors.textSecondary}
                  value={description}
                  onChangeText={setDescription}
                  style={[styles.textInput, { color: colors.textPrimary }]}
                />
              </View>
              {descriptionInvalid && (
                <Text style={[styles.err, { color: colors.error }]}>description must be between 5 and 50 characters</Text>
              )}
            </View>
          )}

          {/* Footer Actions */}
          <View style={[styles.modalActions]}>
            <TouchableOpacity onPress={onClose} style={[styles.secondaryBtn, { borderColor: colors.inputBorder }]}>
              <Text style={{ color: colors.textPrimary }}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              disabled={!ready}
              onPress={() => onAdd({ name, description, icon, identityKey })}
              style={[styles.primaryBtn, { backgroundColor: colors.primary, opacity: ready ? 1 : 0.5 }]}
            >
              <Ionicons name="shield-checkmark-outline" size={16} color={colors.background} />
              <Text style={[styles.primaryBtnText, { color: colors.background }]}>Add Identity Certifier</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  )
}

// -------------------- Styles --------------------
const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { padding: 16 },
  title: { fontSize: 24, fontWeight: 'bold', marginBottom: 4 },
  desc: { fontSize: 12, marginBottom: 12 },

  row: { flexDirection: 'row', alignItems: 'center' },
  rowLeft: { flexDirection: 'row', alignItems: 'flex-start' },

  searchWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    height: 40
  },
  searchInput: { flex: 1, fontSize: 14 },
  addBtn: {
    paddingHorizontal: 12,
    height: 40,
    borderRadius: 8,
    marginLeft: 8,
    flexDirection: 'row',
    alignItems: 'center'
  },
  addBtnText: { marginLeft: 6, fontWeight: '700' },

  thresholdCard: {
    marginHorizontal: 16,
    marginBottom: 8,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12
  },
  thresholdTitle: { fontWeight: '700', marginBottom: 6 },
  thresholdDesc: { fontSize: 12 },
  thresholdRow: { flexDirection: 'row', alignItems: 'center', marginTop: 10, justifyContent: 'space-between' },
  thresholdValue: { fontSize: 16 },
  stepper: { flexDirection: 'row' },
  stepBtn: { borderWidth: 1, borderRadius: 8, padding: 8, marginLeft: 8 },

  card: { borderWidth: 1, borderRadius: 12, marginHorizontal: 16, marginBottom: 12, padding: 12 },
  cardHeader: {},
  icon: { width: 48, height: 48, borderRadius: 24, marginRight: 12 },
  placeholderIcon: { width: 48, height: 48, borderRadius: 24, marginRight: 12, justifyContent: 'center', alignItems: 'center' },
  itemName: { fontSize: 16, fontWeight: '700' },
  itemDesc: { fontSize: 12, marginTop: 2 },
  chip: { borderRadius: 12, paddingHorizontal: 8, paddingVertical: 4 },
  stepperSmall: { flexDirection: 'row', marginLeft: 8 },
  stepBtnSmall: { borderWidth: 1, borderRadius: 8, paddingVertical: 4, paddingHorizontal: 8, marginLeft: 6 },

  keyRow: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6, marginTop: 8 },
  keyText: { fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }), fontSize: 12 },

  emptyBox: { alignItems: 'center', padding: 24 },

  saveBar: { position: 'absolute', left: 0, right: 0, bottom: 0, borderTopWidth: 1, padding: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  saveBarFixed: { borderTopWidth: 1, padding: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  saveBtn: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8 },

  snack: { margin: 16, marginTop: 8, borderRadius: 8, borderWidth: 1, padding: 12, alignItems: 'center' },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: 16 },
  modalCard: { borderWidth: 1, borderRadius: 12, padding: 16 },
  modalTitle: { fontSize: 18, fontWeight: '700' },
  inputRow: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, height: 40, marginTop: 8 },
  textInput: { flex: 1, fontSize: 14 },
  primaryBtn: { marginTop: 12, height: 44, borderRadius: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  primaryBtnText: { marginLeft: 6, fontWeight: '700' },
  secondaryBtn: { height: 44, borderRadius: 8, borderWidth: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  modalActions: { marginTop: 16, flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 8 },
  advancedBtn: { marginTop: 8, alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center' },
  previewBox: { marginTop: 12, borderWidth: 1, borderRadius: 8, padding: 12 },
  previewIcon: { width: 48, height: 48, borderRadius: 8 }
})
