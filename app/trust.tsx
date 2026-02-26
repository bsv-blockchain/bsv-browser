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
  ActivityIndicator
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useTranslation } from 'react-i18next'

import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, radii, typography } from '@/context/theme/tokens'
import { useWallet } from '@/context/WalletContext'
import { GroupedSection } from '@/components/ui/GroupedList'
import validateTrust from '@/utils/validateTrust'

// -------------------- Types --------------------
export type Certifier = {
  name: string
  description: string
  icon?: string
  identityKey: string
  trust: number // 1..10
}

// -------------------- Helpers --------------------
const maskKey = (k: string) => (k?.length > 16 ? `${k.slice(0, 8)}...${k.slice(-8)}` : k)

const assignTrust = (certifiers: Certifier[]): Certifier[] =>
  certifiers.map((c, i) => ({ ...c, trust: i < 9 ? 10 - i : 1 }))

const orderChanged = (a: Certifier[], b: Certifier[]): boolean => {
  if (a.length !== b.length) return true
  for (let i = 0; i < a.length; i++) {
    if (a[i].identityKey !== b[i].identityKey) return true
  }
  return false
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
  const { colors } = useTheme()

  const { settings, updateSettings } = useWallet()

  // Source of truth from Settings — sort by trust descending so position matches priority
  const initialTrusted: Certifier[] = useMemo(
    () => [...(settings?.trustSettings?.trustedCertifiers || [])].sort((a, b) => b.trust - a.trust),
    [settings?.trustSettings?.trustedCertifiers]
  )

  // Local working state
  const [trustedEntities, setTrustedEntities] = useState<Certifier[]>(initialTrusted)
  const [query, setQuery] = useState('')
  const [saving, setSaving] = useState(false)
  const [snack, setSnack] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)

  // Detect unsaved changes — compare identity key arrays in order
  const settingsNeedsUpdate = orderChanged(initialTrusted, trustedEntities)

  // Save to settings
  const handleSave = useCallback(async (): Promise<boolean> => {
    try {
      setSaving(true)
      await updateSettings(
        JSON.parse(
          JSON.stringify({
            ...settings,
            trustSettings: {
              trustLevel: 1,
              trustedCertifiers: assignTrust(trustedEntities)
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
  }, [updateSettings, settings, trustedEntities, t])

  // Search
  const filtered = useMemo(() => {
    if (!query.trim()) return trustedEntities
    const q = query.toLowerCase()
    return trustedEntities.filter(
      e => e.name.toLowerCase().includes(q) || e.description?.toLowerCase?.().includes(q)
    )
  }, [trustedEntities, query])

  const isSearching = query.trim().length > 0

  const onMoveUp = (identityKey: string) => {
    setTrustedEntities(prev => {
      const idx = prev.findIndex(c => c.identityKey === identityKey)
      if (idx <= 0) return prev
      const next = [...prev]
      ;[next[idx - 1], next[idx]] = [next[idx], next[idx - 1]]
      return next
    })
  }

  const onMoveDown = (identityKey: string) => {
    setTrustedEntities(prev => {
      const idx = prev.findIndex(c => c.identityKey === identityKey)
      if (idx < 0 || idx >= prev.length - 1) return prev
      const next = [...prev]
      ;[next[idx], next[idx + 1]] = [next[idx + 1], next[idx]]
      return next
    })
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

  return (
    <View style={{ flex: 1, backgroundColor: colors.backgroundSecondary }}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingTop: spacing.lg,
          paddingBottom: settingsNeedsUpdate ? 80 : spacing.xxxl
        }}
        keyboardShouldPersistTaps="handled"
      >
        {/* Description */}
        <Text style={[styles.description, { color: colors.textSecondary }]}>
          Order certifiers by priority. Apps will display higher-ranked certifiers first.
        </Text>

        {/* ── Certifiers ── */}
        <GroupedSection header="Certifiers">
          {/* Search bar */}
          <View style={[styles.searchRow, { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator }]}>
            <Ionicons name="search" size={16} color={colors.textSecondary} style={{ marginRight: spacing.sm }} />
            <TextInput
              style={[styles.searchInput, { color: colors.textPrimary }]}
              placeholder="Search"
              placeholderTextColor={colors.textSecondary}
              value={query}
              onChangeText={setQuery}
            />
          </View>

          {filtered.length === 0 ? (
            <View style={styles.emptyBox}>
              <Text style={[styles.emptyText, { color: colors.textSecondary }]}>No certifiers yet.</Text>
            </View>
          ) : (
            filtered.map((item, idx) => {
              // Find real index in full list for proper up/down logic
              const realIdx = trustedEntities.findIndex(c => c.identityKey === item.identityKey)
              const isFirst = realIdx === 0
              const isLast = realIdx === trustedEntities.length - 1

              return (
                <View
                  key={item.identityKey}
                  style={[
                    styles.certifierCard,
                    idx < filtered.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator }
                  ]}
                >
                  <View style={styles.certifierHeader}>
                    {item.icon ? (
                      <Image source={{ uri: item.icon }} style={styles.certifierIcon} />
                    ) : (
                      <View style={[styles.certifierIconPlaceholder, { backgroundColor: colors.accent }]}>
                        <Text style={{ color: colors.background, fontWeight: '700' }}>{item.name?.[0] || '?'}</Text>
                      </View>
                    )}
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.certifierName, { color: colors.textPrimary }]} numberOfLines={1}>
                        {item.name}
                      </Text>
                      <Text style={[styles.certifierDesc, { color: colors.textSecondary }]} numberOfLines={2}>
                        {item.description}
                      </Text>
                    </View>
                    <View style={styles.actions}>
                      {!isFirst && !isSearching && (
                        <TouchableOpacity onPress={() => onMoveUp(item.identityKey)} style={styles.actionBtn}>
                          <Ionicons name="chevron-up" size={18} color={colors.textSecondary} />
                        </TouchableOpacity>
                      )}
                      {!isLast && !isSearching && (
                        <TouchableOpacity onPress={() => onMoveDown(item.identityKey)} style={styles.actionBtn}>
                          <Ionicons name="chevron-down" size={18} color={colors.textSecondary} />
                        </TouchableOpacity>
                      )}
                      <TouchableOpacity onPress={() => onRemove(item.identityKey)} style={styles.actionBtn}>
                        <Ionicons name="close" size={18} color={colors.error} />
                      </TouchableOpacity>
                    </View>
                  </View>
                </View>
              )
            })
          )}

          {/* Add Provider button */}
          <TouchableOpacity
            style={[styles.addProviderBtn, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.separator }]}
            onPress={() => setShowAdd(true)}
          >
            <Ionicons name="add" size={18} color={colors.accent} style={{ marginRight: spacing.sm }} />
            <Text style={[styles.addProviderText, { color: colors.accent }]}>Add Provider</Text>
          </TouchableOpacity>
        </GroupedSection>
      </ScrollView>

      {/* Save bar */}
      {settingsNeedsUpdate && (
        <View style={[styles.saveBar, { backgroundColor: colors.backgroundElevated, borderTopColor: colors.separator }]}>
          <Text style={[styles.saveBarText, { color: colors.textSecondary }]}>You have unsaved changes</Text>
          <TouchableOpacity
            onPress={handleSave}
            disabled={saving}
            style={[styles.saveBtn, { backgroundColor: colors.accent, opacity: saving ? 0.6 : 1 }]}
          >
            {saving ? (
              <ActivityIndicator size="small" color={colors.background} />
            ) : (
              <Text style={[styles.saveBtnText, { color: colors.background }]}>Save</Text>
            )}
          </TouchableOpacity>
        </View>
      )}

      {/* Snackbar */}
      {snack && (
        <TouchableOpacity
          activeOpacity={0.9}
          onPress={() => setSnack(null)}
          style={[styles.snack, { backgroundColor: colors.backgroundElevated, borderColor: colors.separator }]}
        >
          <Text style={{ color: colors.textPrimary }}>{snack}</Text>
        </TouchableOpacity>
      )}

      {/* Add Provider Modal */}
      <AddProviderModal
        visible={showAdd}
        onClose={() => setShowAdd(false)}
        onAdd={(c) => {
          if (trustedEntities.some(x => x.identityKey === c.identityKey)) {
            setSnack('An entity with this public key is already in the list!')
            return
          }
          setTrustedEntities(prev => [...prev, { ...c, trust: 1 }])
          setShowAdd(false)
        }}
        colors={colors}
      />
    </View>
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
        <View style={[styles.modalCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.separator }]}>
          <View style={[styles.modalHeader]}>
            <Text style={[styles.modalTitle, { color: colors.textPrimary }]}>Add Provider</Text>
            <TouchableOpacity onPress={onClose}>
              <Ionicons name="close" size={20} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          {!advanced ? (
            <>
              <Text style={[styles.modalDesc, { color: colors.textSecondary }]}>Enter the domain name for the provider you&apos;d like to add.</Text>
              <View style={[styles.inputRow, { borderColor: colors.separator, backgroundColor: colors.fillTertiary }]}>
                <Ionicons name="globe-outline" size={16} color={colors.textSecondary} style={{ marginRight: spacing.sm }} />
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
                <ActivityIndicator style={{ marginTop: spacing.md }} />
              ) : (
                <TouchableOpacity onPress={handleDomainSubmit} style={[styles.primaryBtn, { backgroundColor: colors.accent }]}>
                  <Ionicons name="document-text-outline" size={16} color={colors.background} />
                  <Text style={[styles.primaryBtnText, { color: colors.background }]}>Get Provider Details</Text>
                </TouchableOpacity>
              )}
            </>
          ) : (
            <>
              <Text style={[styles.modalDesc, { color: colors.textSecondary }]}>Directly enter the details for the provider you&apos;d like to add.</Text>

              {/* Name */}
              <View style={[styles.inputRow, { borderColor: colors.separator, backgroundColor: colors.fillTertiary }]}>
                <Ionicons name="person-outline" size={16} color={colors.textSecondary} style={{ marginRight: spacing.sm }} />
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
              <View style={[styles.inputRow, { borderColor: colors.separator, backgroundColor: colors.fillTertiary }]}>
                <Ionicons name="image-outline" size={16} color={colors.textSecondary} style={{ marginRight: spacing.sm }} />
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
              <View style={[styles.inputRow, { borderColor: colors.separator, backgroundColor: colors.fillTertiary }]}>
                <Ionicons name="key-outline" size={16} color={colors.textSecondary} style={{ marginRight: spacing.sm }} />
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
                <ActivityIndicator style={{ marginTop: spacing.md }} />
              ) : (
                <TouchableOpacity onPress={handleDirectValidate} style={[styles.primaryBtn, { backgroundColor: colors.accent }]}>
                  <Ionicons name="shield-checkmark-outline" size={16} color={colors.background} />
                  <Text style={[styles.primaryBtnText, { color: colors.background }]}>Validate Details</Text>
                </TouchableOpacity>
              )}
            </>
          )}

          {/* Toggle advanced */}
          <TouchableOpacity onPress={() => setAdvanced(v => !v)} style={styles.advancedBtn}>
            <Ionicons name={advanced ? 'chevron-up-outline' : 'chevron-down-outline'} size={16} color={colors.textPrimary} />
            <Text style={{ marginLeft: spacing.xs, color: colors.textPrimary }}>{advanced ? 'Hide' : 'Show'} Advanced</Text>
          </TouchableOpacity>

          {/* Preview + description edit */}
          {fieldsValid && (
            <View style={[styles.previewBox, { borderColor: colors.separator, backgroundColor: colors.fillTertiary }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                {icon ? (
                  <Image source={{ uri: icon }} style={styles.previewIcon} />
                ) : (
                  <View style={[styles.previewIcon, { backgroundColor: colors.accent, justifyContent: 'center', alignItems: 'center' }]}>
                    <Text style={{ color: colors.background, fontWeight: '700' }}>{name?.[0] || '?'}</Text>
                  </View>
                )}
                <View style={{ marginLeft: spacing.md, flex: 1 }}>
                  <Text style={{ fontWeight: '700', color: colors.textPrimary }}>{name}</Text>
                  <Text style={[styles.previewKey, { color: colors.textSecondary }]}>{maskKey(identityKey)}</Text>
                </View>
              </View>

              <View style={[styles.inputRow, { marginTop: spacing.md, borderColor: colors.separator, backgroundColor: colors.fillTertiary }]}>
                <Ionicons name="pricetag-outline" size={16} color={colors.textSecondary} style={{ marginRight: spacing.sm }} />
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
          <View style={styles.modalActions}>
            <TouchableOpacity onPress={onClose} style={[styles.secondaryBtn, { borderColor: colors.separator }]}>
              <Text style={{ color: colors.textPrimary }}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              disabled={!ready}
              onPress={() => onAdd({ name, description, icon, identityKey })}
              style={[styles.saveBtn, { backgroundColor: colors.accent, opacity: ready ? 1 : 0.5, flex: 0 }]}
            >
              <Ionicons name="shield-checkmark-outline" size={16} color={colors.background} />
              <Text style={[styles.saveBtnText, { color: colors.background }]}>Add</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  )
}

// -------------------- Styles --------------------
const styles = StyleSheet.create({
  description: {
    ...typography.footnote,
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.lg,
  },

  // Search
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  searchInput: {
    flex: 1,
    ...typography.body,
    padding: 0,
  },

  // Certifier cards
  certifierCard: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  certifierHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  certifierIcon: {
    width: 40,
    height: 40,
    borderRadius: radii.md,
    marginRight: spacing.md,
  },
  certifierIconPlaceholder: {
    width: 40,
    height: 40,
    borderRadius: radii.md,
    marginRight: spacing.md,
    justifyContent: 'center',
    alignItems: 'center',
  },
  certifierName: {
    ...typography.body,
    fontWeight: '700',
  },
  certifierDesc: {
    ...typography.footnote,
    marginTop: spacing.xs,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: spacing.sm,
  },
  actionBtn: {
    padding: spacing.xs,
  },
  emptyBox: {
    alignItems: 'center',
    paddingVertical: spacing.xxl,
  },
  emptyText: {
    ...typography.subhead,
  },

  // Add provider button
  addProviderBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.md,
  },
  addProviderText: {
    ...typography.body,
    fontWeight: '600',
  },

  // Save bar
  saveBar: {
    borderTopWidth: 1,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  saveBarText: {
    ...typography.subhead,
  },
  saveBtn: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radii.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
  },
  saveBtnText: {
    ...typography.subhead,
    fontWeight: '700',
  },

  // Snackbar
  snack: {
    margin: spacing.lg,
    marginTop: spacing.sm,
    borderRadius: radii.sm,
    borderWidth: 1,
    padding: spacing.md,
    alignItems: 'center',
  },

  // Modal
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  modalCard: {
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.lg,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  modalTitle: {
    ...typography.headline,
    fontWeight: '700',
  },
  modalDesc: {
    ...typography.subhead,
    marginBottom: spacing.sm,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    height: 40,
    marginTop: spacing.sm,
  },
  textInput: {
    flex: 1,
    ...typography.subhead,
    padding: 0,
  },
  primaryBtn: {
    marginTop: spacing.md,
    height: 44,
    borderRadius: radii.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryBtnText: {
    marginLeft: spacing.xs,
    ...typography.subhead,
    fontWeight: '700',
  },
  secondaryBtn: {
    height: 44,
    borderRadius: radii.sm,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  modalActions: {
    marginTop: spacing.lg,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: spacing.sm,
  },
  advancedBtn: {
    marginTop: spacing.sm,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
  },
  previewBox: {
    marginTop: spacing.md,
    borderWidth: 1,
    borderRadius: radii.sm,
    padding: spacing.md,
  },
  previewIcon: {
    width: 48,
    height: 48,
    borderRadius: radii.sm,
  },
  previewKey: {
    ...typography.caption1,
  },
  err: {
    ...typography.footnote,
    marginTop: spacing.xs,
  },
})
