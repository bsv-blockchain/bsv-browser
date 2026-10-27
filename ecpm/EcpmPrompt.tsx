import React, { useSyncExternalStore } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { EcpmSession, ecpmConsentText } from './ecpmSession'

export function EcpmPrompt({ session }: { session: EcpmSession }) {
  const pending = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
  return <Modal visible={pending !== null} animationType="slide" onRequestClose={() => pending?.answer(false)}>
    <SafeAreaView style={styles.page}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={styles.title}>Allow point masking?</Text>
        <Text selectable style={styles.text}>{pending && ecpmConsentText(pending.request)}</Text>
        <View style={styles.actions}>
          <Pressable accessibilityRole="button" onPress={() => pending?.answer(false)} style={styles.button}><Text style={styles.text}>Deny</Text></Pressable>
          <Pressable accessibilityRole="button" onPress={() => pending?.answer(true)} style={styles.button}><Text style={styles.text}>Allow for five minutes</Text></Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  </Modal>
}
const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 24 },
  title: { fontSize: 24, fontWeight: '600', color: '#111', marginBottom: 20 },
  text: { fontSize: 16, color: '#111' },
  actions: { gap: 16, marginTop: 24 },
  button: { padding: 16, borderWidth: 1, borderColor: '#777', borderRadius: 8 }
})
