import React, { useState, useEffect, useCallback, useRef } from 'react'
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Platform
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { router } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Clipboard from '@react-native-clipboard/clipboard'
import { toast } from 'react-toastify'
import { useTheme } from '@/context/theme/ThemeContext'
import { spacing, typography, radii } from '@/context/theme/tokens'
import { useWallet } from '@/context/WalletContext'

interface LogEntry {
  id: string
  taskName: string
  timestamp: string
  output: string
}

export default function MonitorLogsScreen() {
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const { runMonitorTask, getMonitorTaskNames, checkUtxoSpendability } = useWallet()

  const [taskNames, setTaskNames] = useState<string[]>([])
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [running, setRunning] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const scrollRef = useRef<ScrollView>(null)

  useEffect(() => {
    setTaskNames(getMonitorTaskNames())
  }, [getMonitorTaskNames])

  const runTask = useCallback(
    async (name: string) => {
      setRunning(name)
      try {
        const output = await runMonitorTask(name)
        const entry: LogEntry = {
          id: `${Date.now()}_${name}`,
          taskName: name,
          timestamp: new Date().toISOString(),
          output: output || '(no output)'
        }
        setLogs(prev => [...prev, entry])
        setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100)
      } catch (e: any) {
        const entry: LogEntry = {
          id: `${Date.now()}_${name}`,
          taskName: name,
          timestamp: new Date().toISOString(),
          output: `Error: ${e.message || 'unknown'}`
        }
        setLogs(prev => [...prev, entry])
      } finally {
        setRunning(null)
      }
    },
    [runMonitorTask]
  )

  const runUtxoCheck = useCallback(async () => {
    const name = 'CheckUTXOs'
    setRunning(name)
    try {
      const output = await checkUtxoSpendability()
      const entry: LogEntry = {
        id: `${Date.now()}_${name}`,
        taskName: name,
        timestamp: new Date().toISOString(),
        output: output || '(no output)'
      }
      setLogs(prev => [...prev, entry])
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100)
    } catch (e: any) {
      const entry: LogEntry = {
        id: `${Date.now()}_${name}`,
        taskName: name,
        timestamp: new Date().toISOString(),
        output: `Error: ${e.message || 'unknown'}`
      }
      setLogs(prev => [...prev, entry])
    } finally {
      setRunning(null)
    }
  }, [checkUtxoSpendability])

  const runAll = useCallback(async () => {
    for (const name of taskNames) {
      await runTask(name)
    }
  }, [taskNames, runTask])

  const copyEntry = useCallback((entry: LogEntry) => {
    Clipboard.setString(`[${entry.timestamp}] ${entry.taskName}\n${entry.output}`)
    setCopiedId(entry.id)
    setTimeout(() => setCopiedId(null), 1500)
  }, [])

  const copyAll = useCallback(() => {
    const text = logs
      .map(e => `[${e.timestamp}] ${e.taskName}\n${e.output}`)
      .join('\n\n')
    Clipboard.setString(text)
    toast.success('Copied all logs')
  }, [logs])

  const clearLogs = useCallback(() => {
    setLogs([])
  }, [])

  return (
    <View style={[styles.container, { backgroundColor: colors.backgroundSecondary, paddingTop: insets.top }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.separator }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn}>
          <Ionicons name="chevron-back" size={24} color={colors.accent} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.textPrimary }]}>Debugging</Text>
        <View style={styles.headerActions}>
          {logs.length > 0 && (
            <TouchableOpacity onPress={copyAll} style={styles.headerBtn}>
              <Ionicons name="copy-outline" size={20} color={colors.accent} />
            </TouchableOpacity>
          )}
          {logs.length > 0 && (
            <TouchableOpacity onPress={clearLogs} style={styles.headerBtn}>
              <Ionicons name="trash-outline" size={20} color={colors.textSecondary} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Task buttons */}
      <View style={[styles.taskBar, { borderBottomColor: colors.separator }]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.taskBarContent}>
          <TouchableOpacity
            onPress={runAll}
            disabled={!!running}
            style={[styles.taskPill, { backgroundColor: colors.accent, opacity: running ? 0.5 : 1 }]}
          >
            {running ? (
              <ActivityIndicator size="small" color={colors.background} />
            ) : (
              <Text style={[styles.taskPillText, { color: colors.background }]}>Run All</Text>
            )}
          </TouchableOpacity>
          {taskNames.map(name => (
            <TouchableOpacity
              key={name}
              onPress={() => runTask(name)}
              disabled={!!running}
              style={[
                styles.taskPill,
                {
                  backgroundColor: running === name ? colors.accent : colors.backgroundSecondary,
                  borderColor: colors.separator,
                  borderWidth: running === name ? 0 : StyleSheet.hairlineWidth,
                  opacity: running && running !== name ? 0.5 : 1
                }
              ]}
            >
              {running === name ? (
                <ActivityIndicator size="small" color={colors.background} />
              ) : (
                <Text
                  style={[styles.taskPillText, { color: running === name ? colors.background : colors.textPrimary }]}
                  numberOfLines={1}
                >
                  {name}
                </Text>
              )}
            </TouchableOpacity>
          ))}
          <TouchableOpacity
            onPress={runUtxoCheck}
            disabled={!!running}
            style={[
              styles.taskPill,
              {
                backgroundColor: running === 'CheckUTXOs' ? colors.accent : colors.backgroundSecondary,
                borderColor: colors.separator,
                borderWidth: running === 'CheckUTXOs' ? 0 : StyleSheet.hairlineWidth,
                opacity: running && running !== 'CheckUTXOs' ? 0.5 : 1
              }
            ]}
          >
            {running === 'CheckUTXOs' ? (
              <ActivityIndicator size="small" color={colors.background} />
            ) : (
              <Text
                style={[styles.taskPillText, { color: running === 'CheckUTXOs' ? colors.background : colors.textPrimary }]}
                numberOfLines={1}
              >
                CheckUTXOs
              </Text>
            )}
          </TouchableOpacity>
        </ScrollView>
      </View>

      {/* Log output */}
      <ScrollView
        ref={scrollRef}
        style={[styles.terminal, { backgroundColor: '#1a1a1a' }]}
        contentContainerStyle={styles.terminalContent}
      >
        {logs.length === 0 && (
          <Text style={styles.emptyText}>Tap a task above to run it and see output here.</Text>
        )}
        {logs.map(entry => {
          const isCopied = copiedId === entry.id
          return (
            <TouchableOpacity
              key={entry.id}
              onPress={() => copyEntry(entry)}
              activeOpacity={0.7}
              style={[styles.logEntry, { borderBottomColor: '#333' }]}
            >
              <View style={styles.logHeader}>
                <Text style={styles.logTaskName}>{entry.taskName}</Text>
                <Text style={styles.logTimestamp}>
                  {new Date(entry.timestamp).toLocaleTimeString()}
                </Text>
                <Ionicons
                  name={isCopied ? 'checkmark' : 'copy-outline'}
                  size={14}
                  color={isCopied ? '#30D158' : '#666'}
                  style={{ marginLeft: 6 }}
                />
              </View>
              <Text style={styles.logOutput} selectable>
                {entry.output}
              </Text>
            </TouchableOpacity>
          )
        })}
        <View style={{ height: insets.bottom + 20 }} />
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth
  },
  headerBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center'
  },
  headerTitle: {
    ...typography.headline,
    fontWeight: '600',
    flex: 1,
    textAlign: 'center'
  },
  headerActions: {
    flexDirection: 'row'
  },
  taskBar: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.sm
  },
  taskBarContent: {
    paddingHorizontal: spacing.md,
    gap: spacing.xs
  },
  taskPill: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: radii.sm,
    minWidth: 60,
    alignItems: 'center'
  },
  taskPillText: {
    ...typography.caption1,
    fontWeight: '600'
  },
  terminal: {
    flex: 1
  },
  terminalContent: {
    padding: spacing.md
  },
  emptyText: {
    color: '#666',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 13,
    textAlign: 'center',
    marginTop: spacing.xxl
  },
  logEntry: {
    marginBottom: spacing.md,
    paddingBottom: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth
  },
  logHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4
  },
  logTaskName: {
    color: '#FF9F0A',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 12,
    fontWeight: '700'
  },
  logTimestamp: {
    color: '#666',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 11,
    marginLeft: 'auto'
  },
  logOutput: {
    color: '#E0E0E0',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 12,
    lineHeight: 18
  }
})
