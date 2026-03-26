import React from 'react'
import { View, Text, TouchableOpacity, Modal, StyleSheet } from 'react-native'
import { spacing, radii, typography } from '@/context/theme/tokens'
import { useTheme } from '@/context/theme/ThemeContext'
import type { ApprovalItem } from '@/context/WalletConnectionContext'

// ── Label / summary helpers ───────────────────────────────────────────────────

export function methodLabel(method: string): string {
  const labels: Record<string, string> = {
    listOutputs:                    'List Wallet Outputs',
    createAction:                   'Sign Transaction',
    signAction:                     'Sign Transaction',
    listActions:                    'List Transactions',
    internalizeAction:              'Accept Incoming Payment',
    acquireCertificate:             'Issue Certificate',
    relinquishCertificate:          'Revoke Certificate',
    revealCounterpartyKeyLinkage:   'Reveal Key Linkage',
  }
  return labels[method] ?? method
}

export function paramsSummary(method: string, params: unknown): { label: string; value: string }[] {
  if (!params || typeof params !== 'object') return []
  const p = params as Record<string, unknown>
  switch (method) {
    case 'listOutputs':
      return p.basket ? [{ label: 'Basket', value: String(p.basket) }] : []
    case 'createAction':
    case 'signAction':
      return p.description ? [{ label: 'Description', value: String(p.description) }] : []
    default:
      return Object.entries(p).slice(0, 3).map(([k, v]) => ({
        label: k,
        value: typeof v === 'object' ? JSON.stringify(v).slice(0, 60) : String(v).slice(0, 60),
      }))
  }
}

// ── Component ────────────────────────────────────────────────────────────────

interface Props {
  pending: ApprovalItem | null
  origin:  string
  onApprove: () => void
  onReject:  () => void
}

export function RpcApprovalModal({ pending, origin, onApprove, onReject }: Props) {
  const { colors } = useTheme()
  if (!pending) return null

  const details = paramsSummary(pending.method, pending.params)

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onReject}>
      <View style={styles.backdrop}>
        <View style={[styles.sheet, { backgroundColor: colors.backgroundElevated }]}>

          <View style={[styles.handle, { backgroundColor: colors.separator }]} />

          <View style={[styles.originPill, { backgroundColor: colors.fillTertiary }]}>
            <Text style={[styles.originText, { color: colors.textSecondary }]} numberOfLines={1}>
              {origin}
            </Text>
          </View>

          <Text style={[styles.methodTitle, { color: colors.textPrimary }]}>
            {methodLabel(pending.method)}
          </Text>
          <Text style={[styles.methodSubtitle, { color: colors.textSecondary }]}>
            is requesting permission
          </Text>

          {details.length > 0 && (
            <View style={[styles.detailsBox, { backgroundColor: colors.backgroundSecondary, borderColor: colors.separator }]}>
              {details.map((d, i) => (
                <View key={i}>
                  {i > 0 && <View style={[styles.detailDivider, { backgroundColor: colors.separator }]} />}
                  <View style={styles.detailRow}>
                    <Text style={[styles.detailLabel, { color: colors.textSecondary }]}>{d.label}</Text>
                    <Text style={[styles.detailValue, { color: colors.textPrimary }]} numberOfLines={2}>{d.value}</Text>
                  </View>
                </View>
              ))}
            </View>
          )}

          <View style={styles.buttonRow}>
            <TouchableOpacity
              style={[styles.rejectBtn, { backgroundColor: colors.fillSecondary, borderColor: colors.separator }]}
              onPress={onReject}
              activeOpacity={0.7}
            >
              <Text style={[styles.rejectText, { color: colors.textPrimary }]}>Reject</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.approveBtn, { backgroundColor: colors.info }]}
              onPress={onApprove}
              activeOpacity={0.7}
            >
              <Text style={[styles.approveText, { color: colors.textOnAccent }]}>Approve</Text>
            </TouchableOpacity>
          </View>

        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    paddingHorizontal: spacing.xxl,
    paddingBottom: spacing.xxxl,
    paddingTop: spacing.md,
    alignItems: 'center',
  },
  handle: {
    width: 36, height: 4, borderRadius: 2, marginBottom: spacing.xl,
  },
  originPill: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.pill,
    marginBottom: spacing.lg,
    maxWidth: '90%',
  },
  originText: { ...typography.footnote, fontWeight: '500' },
  methodTitle: { ...typography.title3, textAlign: 'center', marginBottom: spacing.xs },
  methodSubtitle: { ...typography.subhead, textAlign: 'center', marginBottom: spacing.xl },
  detailsBox: {
    width: '100%',
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: spacing.xl,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    padding: spacing.md,
  },
  detailDivider: { height: StyleSheet.hairlineWidth },
  detailLabel: { ...typography.footnote, flex: 1 },
  detailValue: { ...typography.footnote, fontWeight: '500', flex: 2, textAlign: 'right' },
  buttonRow: { flexDirection: 'row', gap: spacing.md, width: '100%' },
  rejectBtn: {
    flex: 1, paddingVertical: spacing.md + 2,
    borderRadius: radii.lg, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center',
  },
  rejectText: { ...typography.callout, fontWeight: '500' },
  approveBtn: {
    flex: 1, paddingVertical: spacing.md + 2,
    borderRadius: radii.lg, alignItems: 'center',
  },
  approveText: { ...typography.callout, fontWeight: '600' },
})
