import React, { useState } from 'react'
import { View, Text, StyleSheet, TextInput, TouchableOpacity, Alert } from 'react-native'
import CustomSafeArea from '@/components/CustomSafeArea'
import { StatusBar } from 'expo-status-bar'
import { useTranslation } from 'react-i18next'
import { useTheme } from '@/context/theme/ThemeContext'
import { useThemeStyles } from '@/context/theme/useThemeStyles'

export default function SecurityScreen() {
  // Get theme colors and translation
  const { t } = useTranslation()
  const { colors, isDark } = useTheme()
  const themeStyles = useThemeStyles()

  // local state for demo only
  const [newPass, setNewPass] = useState('')
  const [retype, setRetype] = useState('')

  const changePassword = () => {
    if (newPass.length < 6) {
      Alert.alert(t('password_too_short'))
      return
    }
    if (newPass !== retype) {
      Alert.alert(t('passwords_do_not_match'))
      return
    }
    Alert.alert(t('success'), t('password_changed_mock'))
    setNewPass('')
    setRetype('')
  }

  const onViewKey = () => Alert.alert(t('recovery_key'), t('recovery_key_mock'))

  return (
    <CustomSafeArea style={[themeStyles.container, { backgroundColor: colors.background }]}>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <View style={{ padding: 16, flex: 1 }}>
        <Text style={[themeStyles.title, { color: colors.textPrimary, textAlign: 'left', alignSelf: 'flex-start' }]}>
          {t('security')}
        </Text>
        <Text style={[themeStyles.textSecondary, { marginBottom: 20, textAlign: 'left', alignSelf: 'flex-start' }]}>
          {t('manage_password_recovery')}
        </Text>

        {/* Change password card */}
        <View style={[styles.card, { borderColor: colors.inputBorder, backgroundColor: colors.paperBackground }]}>
          <Text style={[styles.cardTitle, { color: colors.textPrimary }]}>{t('change_password')}</Text>
          <Text style={[styles.cardCaption, { color: colors.textSecondary }]}>{t('change_password_prompt')}</Text>

          <TextInput
            style={[
              styles.input,
              { backgroundColor: colors.background, borderColor: colors.inputBorder, color: colors.textPrimary }
            ]}
            placeholder={t('new_password')}
            placeholderTextColor={colors.textSecondary}
            secureTextEntry
            value={newPass}
            onChangeText={setNewPass}
          />
          <TextInput
            style={[
              styles.input,
              { backgroundColor: colors.background, borderColor: colors.inputBorder, color: colors.textPrimary }
            ]}
            placeholder={t('retype_password')}
            placeholderTextColor={colors.textSecondary}
            secureTextEntry
            value={retype}
            onChangeText={setRetype}
          />
          <TouchableOpacity onPress={() => Alert.alert(t('forgot_password_flow'))}>
            <Text style={[styles.forgotText, { color: colors.secondary }]}>{t('forgot_password')}</Text>
          </TouchableOpacity>

          <TouchableOpacity style={[styles.btn, { backgroundColor: colors.primary }]} onPress={changePassword}>
            <Text style={{ color: colors.buttonText, fontWeight: '600' }}>{t('change')}</Text>
          </TouchableOpacity>
        </View>

        {/* Recovery key card */}
        <View style={[styles.card, { borderColor: colors.inputBorder, backgroundColor: colors.paperBackground }]}>
          <Text style={[styles.cardTitle, { color: colors.textPrimary }]}>{t('recovery_key')}</Text>
          <Text style={[styles.cardCaption, { color: colors.textSecondary }]}>{t('recovery_key_description')}</Text>
          <TouchableOpacity style={styles.linkBtn} onPress={onViewKey}>
            <Text style={{ color: colors.secondary }}>{t('view')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.btn, { backgroundColor: colors.primary }]}
            onPress={() => Alert.alert(t('change_recovery_key'))}
          >
            <Text style={{ color: colors.buttonText, fontWeight: '600' }}>{t('change')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </CustomSafeArea>
  )
}

const styles = StyleSheet.create({
  card: { padding: 16, borderWidth: 1, borderRadius: 8, marginBottom: 24 },
  cardTitle: { fontSize: 16, fontWeight: '600', marginBottom: 8 },
  cardCaption: { fontSize: 12, marginBottom: 12 },
  input: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 12,
    fontSize: 14
  },
  forgotText: { fontSize: 12, marginBottom: 12 },
  btn: { alignSelf: 'flex-end', paddingVertical: 8, paddingHorizontal: 16, borderRadius: 6 },
  linkBtn: { alignSelf: 'flex-start', marginBottom: 12 }
})
