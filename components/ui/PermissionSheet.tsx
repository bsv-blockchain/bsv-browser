import React, { useContext, useState, useCallback, useMemo } from 'react'
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native'
import Sheet from '@/components/ui/Sheet'
import { spacing, radii, typography } from '@/context/theme/tokens'
import { useTheme } from '@/context/theme/ThemeContext'
import { WalletContext } from '@/context/WalletContext'
import { UserContext } from '@/context/UserContext'
import AmountDisplay from '@/components/wallet/AmountDisplay'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PermissionKind = 'protocol' | 'basket' | 'certificate' | 'spending' | 'group'

interface GroupProtocol {
  protocolID: [number, string]
  counterparty?: string
  description?: string
}
interface GroupBasket {
  basket: string
  description?: string
}
interface GroupCertificate {
  type: string
  verifierPublicKey?: string
  fields?: string[]
  description?: string
}
interface GroupSpending {
  amount: number
  description?: string
}
interface GroupPermissions {
  protocolPermissions?: GroupProtocol[]
  basketAccess?: GroupBasket[]
  certificateAccess?: GroupCertificate[]
  spendingAuthorization?: GroupSpending
}

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
  /** Group-specific sub-permissions. */
  groupPermissions?: GroupPermissions
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
    // Map lineItems [{type, satoshis, description}] to detail rows
    const lineItemDetails: { label: string; value: string }[] =
      (r.lineItems ?? []).map((item: { description?: string; satoshis: number }) => ({
        label: item.description || 'Payment',
        value: `${item.satoshis} sats`
      }))
    return {
      kind: 'spending',
      requestID: r.requestID,
      originator: r.originator || 'Unknown app',
      title: 'Spending Authorization',
      description: r.description || 'wants to spend from your wallet',
      amount: r.authorizationAmount,
      renewal: r.renewal,
      details: lineItemDetails
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

  return (
    <Sheet
      visible={visible}
      onClose={handleDeny}
      heightPercent={0.92}
    >
      {active && (
        <View style={styles.sheetInner}>
          <View style={[styles.content, active.kind === 'group' && { flex: 1 }]}>
            {/* -------- Originator / domain -------- */}
            <View style={styles.originatorRow}>
              <View style={[styles.faviconPlaceholder, { backgroundColor: colors.buttonBackgroundDisabled }]}>
                <Text style={[styles.faviconLetter, { color: colors.protocolApproval }]}>
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

            {/* -------- Group permissions list -------- */}
            {active.kind === 'group' && active.groupPermissions && (
              <ScrollView style={styles.groupScroll} bounces={false}>
                {active.groupPermissions.spendingAuthorization && (
                  <View style={[styles.groupSection, { borderColor: colors.separator }]}>
                    <Text style={[styles.groupSectionTitle, { color: colors.textSecondary }]}>Spending</Text>
                    <View style={styles.groupRow}>
                      <Text style={[styles.groupRowLabel, { color: colors.textPrimary }]}>
                        <AmountDisplay>{active.groupPermissions.spendingAuthorization.amount}</AmountDisplay>
                      </Text>
                      {active.groupPermissions.spendingAuthorization.description && (
                        <Text style={[styles.groupRowDesc, { color: colors.textSecondary }]}>
                          {active.groupPermissions.spendingAuthorization.description}
                        </Text>
                      )}
                    </View>
                  </View>
                )}
                {active.groupPermissions.protocolPermissions && active.groupPermissions.protocolPermissions.length > 0 && (
                  <View style={[styles.groupSection, { borderColor: colors.separator }]}>
                    <Text style={[styles.groupSectionTitle, { color: colors.textSecondary }]}>Protocols</Text>
                    {active.groupPermissions.protocolPermissions.map((p, i) => (
                      <View key={i} style={styles.groupRow}>
                        <Text style={[styles.groupRowLabel, { color: colors.textPrimary }]}>{p.protocolID[1]}</Text>
                        {p.description && (
                          <Text style={[styles.groupRowDesc, { color: colors.textSecondary }]}>{p.description}</Text>
                        )}
                      </View>
                    ))}
                  </View>
                )}
                {active.groupPermissions.basketAccess && active.groupPermissions.basketAccess.length > 0 && (
                  <View style={[styles.groupSection, { borderColor: colors.separator }]}>
                    <Text style={[styles.groupSectionTitle, { color: colors.textSecondary }]}>Baskets</Text>
                    {active.groupPermissions.basketAccess.map((b, i) => (
                      <View key={i} style={styles.groupRow}>
                        <Text style={[styles.groupRowLabel, { color: colors.textPrimary }]}>{b.basket}</Text>
                        {b.description && (
                          <Text style={[styles.groupRowDesc, { color: colors.textSecondary }]}>{b.description}</Text>
                        )}
                      </View>
                    ))}
                  </View>
                )}
                {active.groupPermissions.certificateAccess && active.groupPermissions.certificateAccess.length > 0 && (
                  <View style={[styles.groupSection, { borderColor: colors.separator }]}>
                    <Text style={[styles.groupSectionTitle, { color: colors.textSecondary }]}>Certificates</Text>
                    {active.groupPermissions.certificateAccess.map((c, i) => (
                      <View key={i} style={styles.groupRow}>
                        <Text style={[styles.groupRowLabel, { color: colors.textPrimary }]}>{c.type}</Text>
                        {c.description && (
                          <Text style={[styles.groupRowDesc, { color: colors.textSecondary }]}>{c.description}</Text>
                        )}
                        {c.fields && c.fields.length > 0 && (
                          <Text style={[styles.groupRowDesc, { color: colors.textTertiary }]}>
                            Fields: {c.fields.join(', ')}
                          </Text>
                        )}
                      </View>
                    ))}
                  </View>
                )}
              </ScrollView>
            )}

            {/* -------- Expandable details (scrollable if tall) -------- */}
            {active.kind !== 'group' && (active.details.length > 0 || (active.fields && active.fields.length > 0)) && (
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
                  <ScrollView
                    style={[styles.detailsCard, { backgroundColor: colors.fillTertiary }]}
                    bounces={false}
                  >
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
                  </ScrollView>
                )}
              </View>
            )}

            {/* -------- Plain-English description -------- */}
            <Text style={[styles.description, { color: colors.primary }]}>
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
          </View>

          {/* -------- Action buttons — pinned at bottom, never move -------- */}
          <View style={[styles.buttonRow, { borderTopColor: colors.separator }]}>
            <TouchableOpacity
              style={[styles.buttonDeny, { borderColor: colors.separator }]}
              onPress={handleDeny}
              activeOpacity={0.7}
            >
              <Text style={[styles.buttonDenyText, { color: colors.textSecondary }]}>
                Reject
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.buttonAllow, { backgroundColor: colors.protocolApproval }]}
              onPress={handleGrant}
              activeOpacity={0.7}
            >
              <Text style={[styles.buttonAllowText, { color: '#FFFFFF' }]}>
                Authorize
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </Sheet>
  )
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  sheetInner: {
    flex: 1,
    justifyContent: 'flex-end'
  },
  content: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.lg
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
    textAlign: 'center',
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
    marginTop: spacing.sm,
    maxHeight: 180
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

  // Group permissions
  groupScroll: {
    flex: 1
  },
  groupSection: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: spacing.sm,
    marginBottom: spacing.sm
  },
  groupSectionTitle: {
    ...typography.caption1,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.xs
  },
  groupRow: {
    paddingVertical: spacing.xs
  },
  groupRowLabel: {
    ...typography.subhead,
    fontWeight: '500'
  },
  groupRowDesc: {
    ...typography.footnote,
    marginTop: 1
  },

  // Buttons — pinned outside ScrollView so they never move
  buttonRow: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
    paddingBottom: spacing.xxxl,
    borderTopWidth: StyleSheet.hairlineWidth
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
