import React, { useEffect, useState, useSyncExternalStore } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useTheme } from '@bsv/expo-wallet-toolbox/core/theme/ThemeContext'
import { EcpmSession } from './ecpmSession'

export function EcpmPrompt({ session }: { session: EcpmSession }) {
  const pending = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
  const [details, setDetails] = useState(false)
  useEffect(() => setDetails(false), [pending])
  const { colors } = useTheme()
  const request = pending?.request, once = pending?.durationMs === 0
  return <Modal visible={pending !== null} animationType="slide" onRequestClose={() => pending?.answer(false)}>
    <SafeAreaView style={[styles.page, { backgroundColor: colors.backgroundSecondary }]}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={[styles.title, { color: colors.textPrimary }]}>Allow card and data masking?</Text>
        <Text selectable style={[styles.text, { color: colors.textPrimary }]}>Application: {request?.originator}</Text>
        <Text style={[styles.text, { color: colors.textPrimary }]}>Use wallet-held keys to mask and reveal data for this app feature. The app receives computed points; your private keys stay in the wallet. No payment permission is requested.</Text>
        <Text style={[styles.text, { color: colors.textPrimary }]}>{once ? 'Approves this operation, point and key ID once.' : 'Allows masking and unmasking for all key IDs and points in this feature, for up to five minutes. Ends when the wallet changes.'}</Text>
        <Text style={[styles.text, { color: colors.textPrimary }]}>Feature: {request?.logicalProtocolID}</Text>
        {request?.privileged && <Text style={[styles.text, { color: colors.textPrimary, fontWeight: '700' }]}>Protected wallet key. Reason: {request.privilegedReason}</Text>}
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: details }} onPress={() => setDetails(value => !value)} style={styles.button}><Text style={{ color: colors.textPrimary }}>Technical details</Text></Pressable>
        {details && <Text selectable style={[styles.text, { color: colors.textPrimary }]}>{`Security level: ${request?.securityLevel}\nCounterparty scope: ${request?.securityLevel === 1 ? 'All counterparties' : request?.counterparty}\nFirst key ID: ${request?.keyID}\nOperation: ${request?.operation}\nPoint: ${request?.point}`}</Text>}
      </ScrollView>
      <View style={styles.actions}>
        <Pressable accessibilityRole="button" onPress={() => pending?.answer(false)} style={styles.button}><Text style={{ color: colors.textPrimary }}>Don’t allow</Text></Pressable>
        <Pressable accessibilityRole="button" onPress={() => pending?.answer(true)} style={styles.button}><Text style={{ color: colors.textPrimary }}>{once ? 'Allow once' : 'Allow for five minutes'}</Text></Pressable>
      </View>
    </SafeAreaView>
  </Modal>
}
const styles = StyleSheet.create({
  page: { flex: 1 }, content: { padding: 24, gap: 16 },
  title: { fontSize: 24, fontWeight: '600' }, text: { fontSize: 16, lineHeight: 23 },
  actions: { gap: 12, padding: 20 }, button: { minHeight: 48, padding: 14, borderWidth: 1, borderColor: '#777', borderRadius: 8 }
})
