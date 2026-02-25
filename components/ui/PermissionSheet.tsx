import React, { useContext, useState, useCallback, useMemo } from 'react'
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native'
import Sheet from '@/components/ui/Sheet'
import { spacing, radii, typography } from '@/context/theme/tokens'
import { useTheme } from '@/context/theme/ThemeContext'
import { WalletContext } from '@/context/WalletContext'
import { UserContext } from '@/context/UserContext'
import AmountDisplay from '@/components/AmountDisplay'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PermissionKind = 'protocol' | 'basket' | 'certificate' | 'spending'

/** Common shape derived from the four existing modals. */
interface ActivePermission {
  kind: PermissionKind
  requestID: string
  originator: string
  title: string
  description: string
  details: { label: string; value: string }[]
  /** Certificate-specific list of required fields. */
  fields?: string[]
  /** Spending-specific authorization amount (satoshis). */
  amount?: number
  /** Whether this is a renewal rather than a first-time request. */
  renewal?: boolean
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive the human-friendly "what is being asked" description for each
 * permission type. Technical specifics go into the expandable Details section.
 */
function deriveActive(ctx: {
  protocolRequests: any[]
  basketRequests: any[]
  certificateRequests: any[]
  spendingRequests: any[]
  protocolAccessModalOpen: boolean
  basketAccessModalOpen: boolean
  certificateAccessModalOpen: boolean
  spendingAuthorizationModalOpen: boolean
}): ActivePermission | null {
  // Priority: spending > certificate > protocol > basket (spending is most
  // time-sensitive). We show only one at a time — exactly like the originals.

  if (ctx.spendingAuthorizationModalOpen && ctx.spendingRequests.length > 0) {
    const r = ctx.spendingRequests[0]
    return {
      kind: 'spending',
      requestID: r.requestID,
      originator: r.originator || 'Unknown app',
      title: 'Spending Authorization',
      description: r.description || 'wants to spend from your wallet',
      amount: r.authorizationAmount,
      renewal: r.renewal,
      details: [
        { label: 'Transaction amount', value: `${r.transactionAmount} satoshis` },
        { label: 'Previously authorized', value: `${r.amountPreviouslyAuthorized} satoshis` },
        { label: 'Total past spending', value: `${r.totalPastSpending} satoshis` }
      ]
    }
  }

  if (ctx.certificateAccessModalOpen && ctx.certificateRequests.length > 0) {
    const r = ctx.certificateRequests[0]
    const certType = r.certificate?.certType ?? r.certificateType
    const verifier = r.certificate?.verifier ?? r.verifierPublicKey
    const fieldsArray: string[] =
      r.fieldsArray ??
      (r.certificate?.fields ? Object.keys(r.certificate.fields) : [])

    const details: { label: string; value: string }[] = []
    if (certType) details.push({ label: 'Certificate type', value: certType })
    if (verifier) details.push({ label: 'Verifier', value: truncate(verifier, 20) })

    return {
      kind: 'certificate',
      requestID: r.requestID,
      originator: r.originator || 'Unknown app',
      title: r.renewal ? 'Certificate Access Renewal' : 'Certificate Access',
      description: r.description || 'wants to access certificate information',
      renewal: r.renewal,
      fields: fieldsArray.length > 0 ? fieldsArray : undefined,
      details
    }
  }

  if (ctx.protocolAccessModalOpen && ctx.protocolRequests.length > 0) {
    const r = ctx.protocolRequests[0]
    return {
      kind: 'protocol',
      requestID: r.requestID,
      originator: r.originator || 'Unknown app',
      title: r.renewal ? 'Protocol Access Renewal' : 'Protocol Access',
      description: r.description || 'wants to use a cryptographic protocol',
      renewal: r.renewal,
      details: [
        { label: 'Protocol ID', value: truncate(r.protocolID, 28) },
        { label: 'Security level', value: String(r.protocolSecurityLevel) }
      ]
    }
  }

  if (ctx.basketAccessModalOpen && ctx.basketRequests.length > 0) {
    const r = ctx.basketRequests[0]
    return {
      kind: 'basket',
      requestID: r.requestID,
      originator: r.originator || 'Unknown app',
      title: r.renewal ? 'Basket Access Renewal' : 'Basket Access',
      description: r.reason || 'wants to access a transaction basket',
      renewal: r.renewal,
      details: r.basket ? [{ label: 'Basket', value: r.basket }] : []
    }
  }

  return null
}

function truncate(str: string, max: number): string {
  if (!str) return ''
  return str.length > max ? str.slice(0, max - 1) + '\u2026' : str
}

/** Map permission kind to the themed accent color key. */
function accentForKind(kind: PermissionKind, colors: any): string {
  switch (kind) {
    case 'protocol':
      return colors.permissionProtocol
    case 'basket':
      return colors.permissionBasket
    case 'certificate':
      return colors.permissionIdentity
    case 'spending':
      return colors.permissionSpending
    default:
      return colors.accent
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const PermissionSheet: React.FC = () => {
  const { colors } = useTheme()

  const {
    protocolRequests,
    basketRequests,
    certificateRequests,
    spendingRequests,
    advanceProtocolQueue,
    advanceBasketQueue,
    advanceCertificateQueue,
    advanceSpendingQueue,
    managers
  } = useContext(WalletContext)

  const {
    protocolAccessModalOpen,
    setProtocolAccessModalOpen,
    basketAccessModalOpen,
    setBasketAccessModalOpen,
    certificateAccessModalOpen,
    setCertificateAccessModalOpen,
    spendingAuthorizationModalOpen,
    setSpendingAuthorizationModalOpen
  } = useContext(UserContext)

  const [detailsExpanded, setDetailsExpanded] = useState(false)

  // Derive what (if anything) we should show.
  const active = useMemo(
    () =>
      deriveActive({
        protocolRequests,
        basketRequests,
        certificateRequests,
        spendingRequests,
        protocolAccessModalOpen,
        basketAccessModalOpen,
        certificateAccessModalOpen,
        spendingAuthorizationModalOpen
      }),
    [
      protocolRequests,
      basketRequests,
      certificateRequests,
      spendingRequests,
      protocolAccessModalOpen,
      basketAccessModalOpen,
      certificateAccessModalOpen,
      spendingAuthorizationModalOpen
    ]
  )

  const visible = active !== null

  // ---- Deny ----
  const handleDeny = useCallback(async () => {
    if (!active) return
    try {
      await managers.permissionsManager?.denyPermission(active.requestID)
    } catch {
      // User denial is expected -- not an error condition
    }
    switch (active.kind) {
      case 'protocol':
        advanceProtocolQueue()
        setProtocolAccessModalOpen(false)
        break
      case 'basket':
        advanceBasketQueue()
        setBasketAccessModalOpen(false)
        break
      case 'certificate':
        advanceCertificateQueue()
        setCertificateAccessModalOpen(false)
        break
      case 'spending':
        advanceSpendingQueue()
        setSpendingAuthorizationModalOpen(false)
        break
    }
    setDetailsExpanded(false)
  }, [
    active,
    managers.permissionsManager,
    advanceProtocolQueue,
    advanceBasketQueue,
    advanceCertificateQueue,
    advanceSpendingQueue,
    setProtocolAccessModalOpen,
    setBasketAccessModalOpen,
    setCertificateAccessModalOpen,
    setSpendingAuthorizationModalOpen
  ])

  // ---- Grant ----
  const handleGrant = useCallback(async () => {
    if (!active) return
    if (active.kind === 'spending') {
      managers.permissionsManager?.grantPermission({
        requestID: active.requestID,
        ephemeral: true,
        amount: active.amount
      })
      advanceSpendingQueue()
      setSpendingAuthorizationModalOpen(false)
    } else {
      managers.permissionsManager?.grantPermission({
        requestID: active.requestID
      })
      switch (active.kind) {
        case 'protocol':
          advanceProtocolQueue()
          setProtocolAccessModalOpen(false)
          break
        case 'basket':
          advanceBasketQueue()
          setBasketAccessModalOpen(false)
          break
        case 'certificate':
          advanceCertificateQueue()
          setCertificateAccessModalOpen(false)
          break
      }
    }
    setDetailsExpanded(false)
  }, [
    active,
    managers.permissionsManager,
    advanceProtocolQueue,
    advanceBasketQueue,
    advanceCertificateQueue,
    advanceSpendingQueue,
    setProtocolAccessModalOpen,
    setBasketAccessModalOpen,
    setCertificateAccessModalOpen,
    setSpendingAuthorizationModalOpen
  ])

  // Accent tint for the current permission kind
  const accent = active ? accentForKind(active.kind, colors) : colors.accent

  return (
    <Sheet
      visible={visible}
      onClose={handleDeny}
      heightPercent={active?.kind === 'spending' ? 0.45 : 0.55}
    >
      {active && (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          bounces={false}
        >
          {/* -------- Originator / domain -------- */}
          <View style={styles.originatorRow}>
            <View style={[styles.faviconPlaceholder, { backgroundColor: accent + '22' }]}>
              <Text style={[styles.faviconLetter, { color: accent }]}>
                {(active.originator[0] ?? '?').toUpperCase()}
              </Text>
            </View>
            <Text
              style={[styles.originator, { color: colors.textPrimary }]}
              numberOfLines={1}
            >
              {active.originator}
            </Text>
          </View>

          {/* -------- Renewal badge -------- */}
          {active.renewal && (
            <View style={[styles.renewalBadge, { backgroundColor: colors.accentSecondary + '1A' }]}>
              <Text style={[styles.renewalText, { color: colors.accentSecondary }]}>
                Renewal
              </Text>
            </View>
          )}

          {/* -------- Plain-English description -------- */}
          <Text style={[styles.description, { color: colors.textSecondary }]}>
            {active.description}
          </Text>

          {/* -------- Spending: prominent amount -------- */}
          {active.kind === 'spending' && active.amount != null && (
            <View style={styles.amountBlock}>
              <Text style={[styles.amountValue, { color: colors.textPrimary }]}>
                <AmountDisplay>{active.amount}</AmountDisplay>
              </Text>
            </View>
          )}

          {/* -------- Expandable details -------- */}
          {(active.details.length > 0 || (active.fields && active.fields.length > 0)) && (
            <View style={styles.detailsSection}>
              <TouchableOpacity
                onPress={() => setDetailsExpanded(prev => !prev)}
                style={styles.detailsToggle}
                activeOpacity={0.7}
              >
                <Text style={[styles.detailsToggleText, { color: colors.textSecondary }]}>
                  {detailsExpanded ? 'Hide details' : 'Details'}
                </Text>
                <Text style={[styles.chevron, { color: colors.textTertiary }]}>
                  {detailsExpanded ? '\u25B2' : '\u25BC'}
                </Text>
              </TouchableOpacity>

              {detailsExpanded && (
                <View style={[styles.detailsCard, { backgroundColor: colors.fillTertiary }]}>
                  {active.details.map((d, i) => (
                    <View key={i} style={styles.detailRow}>
                      <Text style={[styles.detailLabel, { color: colors.textSecondary }]}>
                        {d.label}
                      </Text>
                      <Text
                        style={[styles.detailValue, { color: colors.textPrimary }]}
                        numberOfLines={1}
                      >
                        {d.value}
                      </Text>
                    </View>
                  ))}
                  {active.fields && active.fields.length > 0 && (
                    <>
                      <Text style={[styles.detailLabel, { color: colors.textSecondary, marginTop: spacing.sm }]}>
                        Requested fields
                      </Text>
                      {active.fields.map((f, i) => (
                        <Text
                          key={i}
                          style={[styles.fieldItem, { color: colors.textPrimary }]}
                        >
                          {'\u2022'} {f}
                        </Text>
                      ))}
                    </>
                  )}
                </View>
              )}
            </View>
          )}

          {/* -------- Action buttons -------- */}
          <View style={styles.buttonRow}>
            <TouchableOpacity
              style={[styles.buttonDeny, { borderColor: colors.separator }]}
              onPress={handleDeny}
              activeOpacity={0.7}
            >
              <Text style={[styles.buttonDenyText, { color: colors.textPrimary }]}>
                Don't Allow
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.buttonAllow, { backgroundColor: accent }]}
              onPress={handleGrant}
              activeOpacity={0.7}
            >
              <Text style={[styles.buttonAllowText, { color: '#FFFFFF' }]}>
                Allow
              </Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      )}
    </Sheet>
  )
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  scroll: {
    flex: 1
  },
  scrollContent: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xxxl
  },

  // Originator
  originatorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.md
  },
  faviconPlaceholder: {
    width: 40,
    height: 40,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.md
  },
  faviconLetter: {
    ...typography.title3,
    fontWeight: '700'
  },
  originator: {
    ...typography.headline,
    flex: 1
  },

  // Renewal badge
  renewalBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radii.sm,
    marginBottom: spacing.md
  },
  renewalText: {
    ...typography.caption1,
    fontWeight: '600'
  },

  // Description
  description: {
    ...typography.body,
    marginBottom: spacing.lg
  },

  // Spending amount
  amountBlock: {
    alignItems: 'center',
    marginBottom: spacing.xl
  },
  amountValue: {
    ...typography.largeTitle
  },

  // Details
  detailsSection: {
    marginBottom: spacing.lg
  },
  detailsToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm
  },
  detailsToggleText: {
    ...typography.subhead,
    fontWeight: '500'
  },
  chevron: {
    ...typography.caption1,
    marginLeft: spacing.xs
  },
  detailsCard: {
    borderRadius: radii.md,
    padding: spacing.md,
    marginTop: spacing.sm
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginVertical: spacing.xs
  },
  detailLabel: {
    ...typography.footnote,
    flex: 1
  },
  detailValue: {
    ...typography.footnote,
    fontWeight: '500',
    flex: 1,
    textAlign: 'right'
  },
  fieldItem: {
    ...typography.footnote,
    marginLeft: spacing.md,
    marginTop: spacing.xs
  },

  // Buttons
  buttonRow: {
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: spacing.sm
  },
  buttonDeny: {
    flex: 1,
    paddingVertical: spacing.md,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center'
  },
  buttonDenyText: {
    ...typography.headline
  },
  buttonAllow: {
    flex: 1,
    paddingVertical: spacing.md,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center'
  },
  buttonAllowText: {
    ...typography.headline
  }
})

export default PermissionSheet
