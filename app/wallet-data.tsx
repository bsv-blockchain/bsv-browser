import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, AppState, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Stack } from 'expo-router'
import * as DocumentPicker from 'expo-document-picker'
import * as Sharing from 'expo-sharing'
import { useWallet } from '@bsv/expo-wallet-toolbox/core/context/WalletContext'
import { useTheme } from '@bsv/expo-wallet-toolbox/core/theme/ThemeContext'
import { useThemeStyles } from '@bsv/expo-wallet-toolbox/core/theme/useThemeStyles'
import { exportRetainedWalletImport, exportBeforeMergeRecoveryPoint, importWalletFile, listArchiveJobs, listWalletExports, type ArchiveJob, type SavedWalletExport } from '@/utils/walletPortability/native'
import { activateRestoredWalletData, restoreSeparateWalletCopy } from '@/utils/walletPortability/session'

export default function WalletDataScreen() {
  const { managers, selectedNetwork: appNetwork, walletBuilt, rebuildWallet } = useWallet()
  const selectedNetwork = appNetwork === 'teratest' ? 'ttn' : appNetwork
  const session = walletBuilt ? managers?.walletData : undefined
  const { colors } = useTheme()
  const styles = useThemeStyles()
  const [jobs, setJobs] = useState<ArchiveJob[]>([])
  const [exports, setExports] = useState<SavedWalletExport[]>([])
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [exportUri, setExportUri] = useState<string>()
  const operation = useRef<AbortController | undefined>(undefined)
  const mounted = useRef(true)
  const refresh = useCallback(async () => {
    const next = await listArchiveJobs()
    const saved = listWalletExports()
    if (mounted.current) { setJobs(next); setExports(saved) }
  }, [])
  const report = useCallback((message: string) => { if (mounted.current) setStatus(message) }, [])
  useEffect(() => {
    mounted.current = true
    void refresh().catch(() => report('Saved recovery files could not be opened. They have not been removed.'))
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') {
        operation.current?.abort()
        setPassword(''); setConfirmation('')
      }
    })
    return () => { mounted.current = false; subscription.remove(); operation.current?.abort() }
  }, [refresh, report])
  useEffect(() => () => { operation.current?.abort() }, [session, selectedNetwork])

  const run = async (action: (signal: AbortSignal) => Promise<void>) => {
    if (operation.current || !mounted.current) return
    const controller = new AbortController()
    operation.current = controller
    setBusy(true); setPassword(''); setConfirmation(''); setStatus('Preparing…')
    try { await action(controller.signal) }
    catch (error) { report(error instanceof Error ? error.message : 'The operation could not finish. Your original file and recovery copies remain available.') }
    finally {
      operation.current = undefined
      if (mounted.current) { setBusy(false); await refresh().catch(() => {}) }
    }
  }
  const share = async (uri: string) => {
    try {
      if (!(await Sharing.isAvailableAsync())) throw new Error('File sharing is unavailable on this device. The file remains saved in the app.')
      await Sharing.shareAsync(uri, { mimeType: 'application/octet-stream', UTI: 'public.data', dialogTitle: 'Save wallet data file' })
    } catch (error) { report(error instanceof Error ? error.message : 'Could not open the file sharing sheet. The file remains saved.') }
  }
  const choose = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true, multiple: false })
      if (result.canceled || !mounted.current) return
      const file = result.assets[0]
      // The picker can background this screen and clear password state; capture
      // the submitted value here only after the user returns to the app.
      setSelectedFile({ uri: file.uri, name: file.name })
      setStatus('File selected. Enter its passphrase below, then validate it.')
    } catch { report('The file picker could not open this file. No wallet data changed.') }
  }
  const [selectedFile, setSelectedFile] = useState<{ uri: string; name: string }>()
  const activate = (job: ArchiveJob) => {
    Alert.alert('Use this device copy as your main wallet?',
      'This changes storage only for the identity and network shown in the file. Keep your key recovery material and original file. Your previous storage is retained. Matching wallet keys are still required to sign in.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Use device copy', onPress: () => { void run(async signal => {
          await activateRestoredWalletData(job.id, selectedNetwork, report, signal, session)
          if (session) await rebuildWallet()
          report(session ? 'Device copy selected and wallet reopened.' : 'Device copy selected. Sign in with the matching wallet keys on this network to use it.')
        }) } }
      ])
  }
  const merge = (job: ArchiveJob) => Alert.alert('Merge this file into your current wallet?',
    'A complete recovery point is saved first. Existing and imported records are reconciled in a separate copy before verified pages reach your current wallet. If stopped, resume the same saved merge.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Merge wallet data', onPress: () => { void run(async signal => {
        if (!session) throw new Error('Sign in to the matching wallet before merging.')
        await session.merge(job.id, report, signal)
        report('Merge complete. Your original file and the recovery point are retained.')
      }) } }
    ])
  const button = (title: string, onPress: () => void, disabled = false, testID?: string) => (
    <TouchableOpacity accessibilityRole="button" accessibilityLabel={title} disabled={disabled || busy} testID={testID}
      onPress={onPress} style={[local.button, { backgroundColor: colors.secondary, opacity: disabled || busy ? 0.45 : 1 }]}>
      <Text style={{ color: colors.buttonText, fontWeight: '600', textAlign: 'center' }}>{title}</Text>
    </TouchableOpacity>
  )
  const matched = (job: ArchiveJob) => job.summary?.chain === selectedNetwork && (!session || job.summary.identityKey === session.identityKey)
  return <SafeAreaView style={styles.container} edges={['bottom']}>
    <Stack.Screen options={{ title: 'Wallet data files', headerShown: true }} />
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
      <Text style={[styles.text, local.title]}>Export, import and recover wallet data</Text>
      <Text style={styles.textSecondary}>Wallet data files contain transaction history, outputs, certificates and recovery records. They do not contain your signing keys. Keep your key recovery material separately.</Text>
      <Text style={[styles.text, { marginVertical: 12 }]}>{selectedNetwork === 'main' ? 'Mainnet' : selectedNetwork === 'test' ? 'Testnet' : 'Teratest'} · {session ? session.isDevicePrimary ? 'Device storage is primary' : 'Cloud storage is primary' : 'Sign in to export or merge your current wallet'}</Text>
      {button('Choose wallet data file', () => { void choose() }, false, 'wallet-data-choose')}
      {selectedFile && <Text style={styles.text}>{selectedFile.name}</Text>}
      <TextInput accessibilityLabel="Wallet file passphrase" testID="wallet-data-passphrase" placeholder="File passphrase"
        placeholderTextColor={colors.textSecondary} secureTextEntry autoCapitalize="none" autoCorrect={false}
        value={password} onChangeText={setPassword} editable={!busy} style={[local.input, { color: colors.textPrimary, borderColor: colors.textSecondary }]} />
      <Text style={styles.textSecondary}>Use the existing passphrase for import. An unencrypted BRC-38 file does not need one. For a new encrypted export, use at least 12 characters.</Text>
      {button('Validate selected file', () => {
        const file = selectedFile, passphrase = password
        if (file) void run(async signal => {
          const job = await importWalletFile(file.uri, file.name, passphrase, report, signal)
          report(`File verified: ${job.summary!.totalRecords.toLocaleString()} records. Review its identity and network before restoring.`)
        })
      }, !selectedFile, 'wallet-data-import')}
      <TextInput accessibilityLabel="Confirm export passphrase" placeholder="Confirm new export passphrase" placeholderTextColor={colors.textSecondary}
        secureTextEntry autoCapitalize="none" autoCorrect={false} value={confirmation} onChangeText={setConfirmation} editable={!busy}
        style={[local.input, { color: colors.textPrimary, borderColor: colors.textSecondary }]} />
      {button('Create encrypted export', () => {
        const passphrase = password
        if (session) void run(async signal => {
          const uri = await session.export(passphrase, report, signal)
          if (mounted.current) setExportUri(uri)
          report('Encrypted export ready. Use Save or share export to choose its destination.')
        })
      }, !session || password.length < 12 || password !== confirmation, 'wallet-data-export')}
      {exportUri && button('Save or share export', () => { void share(exportUri) }, false, 'wallet-data-share')}
      {!!status && <Text accessibilityLiveRegion="polite" testID="wallet-data-status" style={[styles.text, { marginVertical: 16 }]}>{status}</Text>}
      {busy && <TouchableOpacity accessibilityRole="button" onPress={() => { operation.current?.abort(); report('Stopping after the current safe checkpoint…') }} style={local.button}>
        <Text style={styles.text}>Stop safely</Text>
      </TouchableOpacity>}
      {exports.length > 0 && <>
        <Text style={[styles.text, local.title]}>Saved encrypted exports</Text>
        <Text style={styles.textSecondary}>Completed files stay available here after closing or updating the app. Keep their passphrases separately.</Text>
        {exports.map(file => <View key={file.name} style={styles.card}>
          <Text style={styles.text}>{file.name}</Text>
          <Text style={styles.textSecondary}>{file.bytes.toLocaleString()} bytes</Text>
          {button(`Save or share ${file.name}`, () => { void share(file.uri) })}
        </View>)}
      </>}
      <Text style={[styles.text, local.title]}>Saved imports and recovery</Text>
      {jobs.length === 0 && <Text style={styles.textSecondary}>Imported originals and recovery copies will appear here.</Text>}
      {jobs.map(job => <View key={job.id} style={styles.card}>
        <Text style={[styles.text, { fontWeight: '600' }]}>{job.fileName}</Text>
        <Text style={styles.textSecondary}>{new Date(job.createdAt).toLocaleString()} · {job.state}</Text>
        {job.summary && <>
          <Text style={styles.text}>{job.summary.chain} · {job.summary.totalRecords.toLocaleString()} records · {job.summary.pendingTransactions} pending transactions</Text>
          <Text selectable style={styles.textSecondary}>Identity: {job.summary.identityKey}</Text>
          <Text style={styles.textSecondary}>{Object.entries(job.summary.counts).map(([table, count]) => `${table}: ${count}`).join('\n')}</Text>
          {!matched(job) && <Text style={styles.text}>This file belongs to a different wallet identity or network. It can be restored as a separate copy.</Text>}
        </>}
        {job.error && <Text style={styles.text}>{job.error}</Text>}
        {button('Save original file', () => {
          if (job.format !== 'brc39') Alert.alert('This file may be unencrypted', 'Anyone with this file may read its wallet history and data. Save it only to a location you trust.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Save file', onPress: () => { void share(job.originalUri) } }])
          else void share(job.originalUri)
        })}
        {job.summary && button('Create encrypted copy of this import', () => {
          const passphrase = password
          void run(async signal => {
            const uri = await exportRetainedWalletImport(job.id, passphrase, report, signal)
            if (mounted.current) setExportUri(uri)
            report('Encrypted recovery copy ready. Use Save or share export to choose its destination.')
          })
        }, password.length < 12 || password !== confirmation)}
        {job.beforeDatabaseName && button('Export before-merge recovery point', () => {
          const passphrase = password
          void run(async signal => {
            const uri = await exportBeforeMergeRecoveryPoint(job.id, passphrase, report, signal)
            if (mounted.current) setExportUri(uri)
            report('Before-merge recovery point encrypted. Save the export, then import it to restore a separate copy or select it as your main device copy.')
          })
        }, password.length < 12 || password !== confirmation)}
        {['preparing', 'interrupted'].includes(job.state) ? button('Retry validation', () => {
          const passphrase = password
          void run(async signal => { await importWalletFile(job.originalUri, job.fileName, passphrase, report, signal); report('File verified. Original and earlier recovery attempts are retained.') })
        }) : <>
          {button('Restore a separate copy', () => { void run(async signal => { await restoreSeparateWalletCopy(job.id, report, signal); report('Separate device copy restored and verified. Your current wallet is unchanged.') }) }, ['merging', 'activating'].includes(job.state))}
          {button(job.state === 'merging' ? 'Resume merge' : 'Merge into current wallet', () => merge(job), !session || !matched(job) || !['ready', 'restored', 'merging', 'merged'].includes(job.state))}
          {button('Use as main device copy', () => activate(job), !matched(job) || job.state === 'merging' || (!!managers?.walletManager?.authenticated && !session))}
        </>}
      </View>)}
    </ScrollView>
  </SafeAreaView>
}
const local = StyleSheet.create({
  title: { fontSize: 20, fontWeight: '600', marginVertical: 12 },
  input: { borderWidth: 1, borderRadius: 8, padding: 12, marginVertical: 8 },
  button: { padding: 14, borderRadius: 8, marginVertical: 6 }
})
