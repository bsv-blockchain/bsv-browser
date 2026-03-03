import React, { createContext, useContext, useState, ReactNode } from 'react'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

// Detect language with multiple fallback methods
let detectedLanguage = 'en'

try {
  // Try expo-localization first (most reliable for Expo apps)
  const Localization = require('expo-localization')
  const deviceLanguage = Localization.getLocales()?.[0]?.languageCode
  if (deviceLanguage) {
    detectedLanguage = deviceLanguage
    console.log('🌍 Device language detected via expo-localization:', deviceLanguage)
    console.log('🔤 Detected language code:', detectedLanguage)
    console.log('📱 Full locale info:', Localization.getLocales()?.[0])
  } else {
    throw new Error('expo-localization returned no language')
  }
} catch (localeError) {
  console.warn('⚠️ expo-localization not available, trying react-native-localize:', localeError.message)

  try {
    // Fallback to react-native-localize
    const { getLocales } = require('react-native-localize')
    const deviceLocales = getLocales()
    detectedLanguage = deviceLocales[0]?.languageCode || 'en'
    console.log('🌍 Device locales detected via react-native-localize:', deviceLocales)
    console.log('🔤 Detected language code:', detectedLanguage)
    console.log('📱 Full locale info:', deviceLocales[0])
  } catch (rnLocalizeError) {
    console.warn('⚠️ react-native-localize also not available:', rnLocalizeError.message)

    try {
      // Enhanced fallback to platform-specific detection
      const { Platform } = require('react-native')

      if (Platform.OS === 'ios') {
        console.log('🍎 iOS detected, trying enhanced locale detection...')
        const { NativeModules } = require('react-native')

        // Try multiple iOS methods
        let iosLocale = null

        // Method 1: SettingsManager AppleLocale
        if (NativeModules.SettingsManager?.settings?.AppleLocale) {
          iosLocale = NativeModules.SettingsManager.settings.AppleLocale
          console.log('🍎 iOS AppleLocale found:', iosLocale)
        }

        // Method 2: SettingsManager AppleLanguages array
        if (!iosLocale && NativeModules.SettingsManager?.settings?.AppleLanguages) {
          const languages = NativeModules.SettingsManager.settings.AppleLanguages
          iosLocale = languages[0]
          console.log('🍎 iOS AppleLanguages found:', languages, '-> using:', iosLocale)
        }

        // Method 3: I18nManager
        if (!iosLocale) {
          const { I18nManager } = require('react-native')
          if (I18nManager.localeIdentifier) {
            iosLocale = I18nManager.localeIdentifier
            console.log('🍎 iOS I18nManager localeIdentifier found:', iosLocale)
          }
        }

        if (iosLocale) {
          // Extract language code (handle both "es_ES" and "es-ES" formats)
          detectedLanguage = String(iosLocale).split(/[-_]/)[0]
          console.log('🔤 iOS extracted language code:', detectedLanguage)
        } else {
          console.log('🍎 No iOS locale found, using default: en')
        }
      } else if (Platform.OS === 'android') {
        console.log('🤖 Android detected, trying locale detection...')
        const { I18nManager } = require('react-native')
        if (I18nManager.localeIdentifier) {
          detectedLanguage = I18nManager.localeIdentifier.split(/[-_]/)[0]
          console.log('🤖 Android locale detected:', I18nManager.localeIdentifier, '-> extracted:', detectedLanguage)
        }
      } else {
        console.log('🌐 Web/other platform detected...')
        // Web fallback
        if (typeof navigator !== 'undefined' && navigator.language) {
          detectedLanguage = navigator.language.split(/[-_]/)[0]
          console.log('🌐 Web locale detected:', navigator.language, '-> extracted:', detectedLanguage)
        }
      }
    } catch (platformError) {
      console.warn('⚠️ Platform-specific locale detection failed:', platformError.message)
      detectedLanguage = 'en'
      console.log('🔧 Using default language: en')
    }
  }
}

const resources = {
  en: {
    translation: {
      // Browser UI
      new_tab: 'New Tab',
      untitled: 'Untitled',
      share: 'Share',
      back_to_homepage: 'Back to Homepage',
      bookmarks: 'Bookmarks',
      add_bookmark: 'Add Bookmark',
      history: 'History',
      clear_all: 'Clear All',
      clear_all_tabs: 'Clear All Tabs',
      search_or_enter_website: 'Search or enter website',
      browser: 'Browser',
      bug_report: 'Bug Report',
      enable_web3: 'Enable Web3',
      tabs: 'Tabs',
      unlock_web3_features: 'Unlock Web3 features',

      // General actions
      cancel: 'Cancel',
      done: 'Done',
      deny: 'Deny',
      allow: 'Allow',
      save: 'Save',
      remove: 'Remove',
      delete: 'Delete',
      accept: 'Accept',
      search: 'Search',
      loading: 'Loading...',
      continue: 'Continue',
      go_back: 'Go Back',
      copied: 'Copied',
      copy_to_clipboard: 'Copy to Clipboard',
      details: 'Details',
      hide_details: 'Hide details',

      // Navigation
      identity: 'Identity',
      settings: 'Settings',
      wallet: 'Wallet',
      permissions: 'Permissions',
      trust_network: 'Trust Network',

      // Account
      logout: 'Logout',
      bsv_network: 'BSV Network',
      recovery_phrase: 'Mnemonic',
      you_have: 'you have',
      switching: 'Switching...',
      mainnet: 'Mainnet',
      testnet: 'Testnet',
      identity_key: 'Identity Key',
      legacy_payments: 'Legacy Payments',
      identity_payments: 'Identity Payments',
      transactions: 'Transactions',

      // Transactions screen
      no_transactions: 'No transactions yet',
      tx_status_confirmed: 'Confirmed',
      tx_status_accepted: 'Accepted',
      tx_status_broadcasting: 'Broadcasting',
      tx_status_not_sent: 'Not Sent',
      tx_status_unsigned: 'Unsigned',
      tx_status_nonfinal: 'Non-final',
      tx_status_failed: 'Failed',
      tx_copied: 'Transaction copied',
      tx_not_available: 'Raw transaction not available',
      tx_copy_failed: 'Failed to copy transaction',
      tx_abort_success: 'Transaction aborted',
      tx_abort_failed: 'Failed to abort transaction',

      // Identity / Payments screen
      message_box_server: 'Message Box Server',
      message_box_required: 'Required to send and receive identity-based payments.',
      message_box_tap_to_configure: 'Tap to configure your Message Box server',
      send_payment: 'Send Payment',
      recipient: 'Recipient',
      amount_bsv: 'Amount (BSV)',
      incoming_payments: 'Incoming Payments',
      no_pending_payments: 'No pending payments',
      valid_identity_key: 'Valid identity key entered',
      searching: 'Searching...',
      unknown: 'Unknown',
      from_prefix: 'From:',
      message_box_saved: 'Message Box server saved',
      message_box_removed: 'Message Box server removed',
      enter_valid_url: 'Please enter a valid URL',
      search_name_or_key: 'Search by name or identity key...',

      // Trust screen
      trust_updated: 'Trust network updated',
      failed_to_save: 'Failed to save',
      confirm_delete: 'Confirm Delete',
      confirm_delete_body: 'Are you sure you want to delete this certifier?',
      order_certifiers_hint: 'Order certifiers by priority. Apps will display higher-ranked certifiers first.',
      certifiers: 'Certifiers',
      no_certifiers: 'No certifiers yet.',
      add_provider: 'Add Provider',
      unsaved_changes: 'You have unsaved changes',
      duplicate_key_error: 'An entity with this public key is already in the list!',
      get_provider_details: 'Get Provider Details',
      validate_details: 'Validate Details',
      show_advanced: 'Show Advanced',
      hide_advanced: 'Hide Advanced',
      description_length_error: 'Description must be between 5 and 50 characters',
      enter_domain_hint: 'Enter provider domain',
      enter_details_hint: 'Enter provider details',

      // Legacy payments screen
      generating_address: 'Generating address...',
      available_balance: 'Available Balance',
      not_checked: 'Not checked',
      check_balance: 'Check Balance',
      import_funds: 'Import Funds',
      unable_to_generate_address: 'Unable to generate address',
      send_bsv: 'Send BSV',
      recipient_address: 'Recipient Address',
      enter_bsv_address: 'Enter BSV address',
      legacy_info: 'Address-based BSV payments to and from external wallets. A unique address is generated each day for privacy.',

      // Mnemonic / wallet setup screen
      wallet_data: 'Wallet Data',
      create_new_wallet: 'Create New Wallet',
      generate_recovery_phrase_caption: 'Generate a new recovery phrase',
      import_existing_wallet: 'Import Existing Wallet',
      paste_recovery_phrase: 'Paste your recovery phrase',
      save_recovery_phrase_heading: 'Save Your Recovery Phrase',
      save_recovery_phrase_btn: 'Save Recovery Phrase',
      recovery_phrase_write_down: 'Write down these 12 words in order and store them in a safe place.',
      acknowledgment_text: 'I have saved my recovery phrase and understand that losing it will result in total and permanent loss of all associated funds, tokens, and certificates.',
      enter_recovery_words: 'Enter your recovery words separated by spaces...',
      restore_wallet_description: 'Enter your recovery phrase to restore your wallet',
      import_wallet: 'Import Wallet',

      // Permission sheet
      reject: 'Reject',
      authorize: 'Authorize',
      renewal: 'Renewal',
      spending_section: 'Spending',
      protocols_section: 'Protocols',
      baskets_section: 'Baskets',
      certificates_section: 'Certificates',
      requested_fields: 'Requested fields',

      // Amount input
      send_max: 'Send Max',
      entire_wallet_balance: 'Entire wallet balance',
      export_data: 'Export Data',
    }
  },
  zh: {
    translation: {
      new_tab: '新标签',
      untitled: '无标题',
      share: '分享',
      back_to_homepage: '返回主页',
      bookmarks: '书签',
      add_bookmark: '添加书签',
      history: '历史记录',
      clear_all: '全部清除',
      clear_all_tabs: '清除所有标签',
      search_or_enter_website: '搜索或输入网站',
      browser: '浏览器',
      bug_report: '错误报告',
      enable_web3: '启用 Web3',
      tabs: '标签',
      unlock_web3_features: '解锁 Web3 功能',

      cancel: '取消',
      done: '完成',
      deny: '拒绝',
      allow: '允许',
      save: '保存',
      remove: '移除',
      delete: '删除',
      accept: '接受',
      search: '搜索',
      loading: '加载中...',
      continue: '继续',
      go_back: '返回',
      copied: '已复制',
      copy_to_clipboard: '复制到剪贴板',
      details: '详情',
      hide_details: '隐藏详情',

      identity: '身份',
      settings: '设置',
      wallet: '钱包',
      permissions: '权限',
      trust_network: '信任网络',

      logout: '退出',
      bsv_network: 'BSV 网络',
      recovery_phrase: '助记词',
      you_have: '您有',
      switching: '切换中...',
      mainnet: '主网',
      testnet: '测试网',
      identity_key: '身份密钥',
      legacy_payments: '传统支付',
      identity_payments: '身份支付',
      transactions: '交易',

      no_transactions: '暂无交易',
      tx_status_confirmed: '已确认',
      tx_status_accepted: '已接受',
      tx_status_broadcasting: '广播中',
      tx_status_not_sent: '未发送',
      tx_status_unsigned: '未签名',
      tx_status_nonfinal: '未完成',
      tx_status_failed: '失败',
      tx_copied: '交易已复制',
      tx_not_available: '原始交易不可用',
      tx_copy_failed: '复制交易失败',
      tx_abort_success: '交易已中止',
      tx_abort_failed: '中止交易失败',

      message_box_server: '消息箱服务器',
      message_box_required: '发送和接收基于身份的付款所必需的。',
      message_box_tap_to_configure: '点击配置您的消息箱服务器',
      send_payment: '发送付款',
      recipient: '收款人',
      amount_bsv: '金额 (BSV)',
      incoming_payments: '收款',
      no_pending_payments: '没有待处理的付款',
      valid_identity_key: '已输入有效的身份密钥',
      searching: '搜索中...',
      unknown: '未知',
      from_prefix: '来自：',
      message_box_saved: '消息箱服务器已保存',
      message_box_removed: '消息箱服务器已删除',
      enter_valid_url: '请输入有效的网址',
      search_name_or_key: '按名称或身份密钥搜索...',

      trust_updated: '信任网络已更新',
      failed_to_save: '保存失败',
      confirm_delete: '确认删除',
      confirm_delete_body: '您确定要删除这个认证机构吗？',
      order_certifiers_hint: '按优先级排列认证机构。应用程序将优先显示排名较高的认证机构。',
      certifiers: '认证机构',
      no_certifiers: '暂无认证机构。',
      add_provider: '添加提供者',
      unsaved_changes: '您有未保存的更改',
      duplicate_key_error: '具有此公钥的实体已在列表中！',
      get_provider_details: '获取提供者详情',
      validate_details: '验证详情',
      show_advanced: '显示高级设置',
      hide_advanced: '隐藏高级设置',
      description_length_error: '描述必须在5到50个字符之间',
      enter_domain_hint: '输入提供者域名',
      enter_details_hint: '输入提供者详情',

      generating_address: '生成地址中...',
      available_balance: '可用余额',
      not_checked: '未检查',
      check_balance: '检查余额',
      import_funds: '导入资金',
      unable_to_generate_address: '无法生成地址',
      send_bsv: '发送 BSV',
      recipient_address: '收款地址',
      enter_bsv_address: '输入 BSV 地址',
      legacy_info: '传统支付允许您使用P2PKH地址从传统BSV钱包导入资金。',

      wallet_data: '钱包数据',
      create_new_wallet: '创建新钱包',
      generate_recovery_phrase_caption: '生成新的助记词',
      import_existing_wallet: '导入现有钱包',
      paste_recovery_phrase: '粘贴您的助记词',
      save_recovery_phrase_heading: '保存您的助记词',
      save_recovery_phrase_btn: '保存助记词',
      recovery_phrase_write_down: '按顺序写下这12个单词并将其存放在安全的地方。',
      acknowledgment_text: '我已经记录了我的助记词，并了解失去它意味着失去对我的钱包的访问权限。',
      enter_recovery_words: '输入以空格分隔的助记词...',
      restore_wallet_description: '输入助记词以恢复您的钱包',
      import_wallet: '导入钱包',

      reject: '拒绝',
      authorize: '授权',
      renewal: '续订',
      spending_section: '消费',
      protocols_section: '协议',
      baskets_section: '篮子',
      certificates_section: '证书',
      requested_fields: '请求的字段',

      send_max: '发送最大值',
      entire_wallet_balance: '全部钱包余额',
      export_data: '导出数据',
    }
  },
  hi: {
    translation: {
      new_tab: 'नया टैब',
      untitled: 'अनामांकित',
      share: 'साझा करें',
      back_to_homepage: 'मुख्य पृष्ठ पर वापस जाएं',
      bookmarks: 'बुकमार्क',
      add_bookmark: 'बुकमार्क जोड़ें',
      history: 'इतिहास',
      clear_all: 'सभी साफ करें',
      clear_all_tabs: 'सभी टैब साफ करें',
      search_or_enter_website: 'खोजें या वेबसाइट दर्ज करें',
      browser: 'ब्राउज़र',
      bug_report: 'बग रिपोर्ट',
      enable_web3: 'Web3 सक्षम करें',
      tabs: 'टैब',
      unlock_web3_features: 'Web3 सुविधाएं अनलॉक करें',

      cancel: 'रद्द करें',
      done: 'हो गया',
      deny: 'अस्वीकार करें',
      allow: 'अनुमति दें',
      save: 'सहेजें',
      remove: 'हटाएं',
      delete: 'हटाएं',
      accept: 'स्वीकार करें',
      search: 'खोजें',
      loading: 'लोड हो रहा है...',
      continue: 'जारी रखें',
      go_back: 'वापस जाएं',
      copied: 'कॉपी किया गया',
      copy_to_clipboard: 'क्लिपबोर्ड में कॉपी करें',
      details: 'विवरण',
      hide_details: 'विवरण छुपाएं',

      identity: 'पहचान',
      settings: 'सेटिंग्स',
      wallet: 'वॉलेट',
      permissions: 'अनुमतियां',
      trust_network: 'विश्वास नेटवर्क',

      logout: 'लॉग आउट करें',
      bsv_network: 'BSV नेटवर्क',
      recovery_phrase: 'मेमोनिक',
      you_have: 'आपके पास है',
      switching: 'बदल रहा है...',
      mainnet: 'मेननेट',
      testnet: 'टेस्टनेट',
      identity_key: 'पहचान कुंजी',
      legacy_payments: 'लीगेसी भुगतान',
      identity_payments: 'पहचान भुगतान',
      transactions: 'लेनदेन',

      no_transactions: 'अभी तक कोई लेनदेन नहीं',
      tx_status_confirmed: 'पुष्ट',
      tx_status_accepted: 'स्वीकृत',
      tx_status_broadcasting: 'प्रसारण हो रहा है',
      tx_status_not_sent: 'नहीं भेजा गया',
      tx_status_unsigned: 'अहस्ताक्षरित',
      tx_status_nonfinal: 'अंतिम नहीं',
      tx_status_failed: 'विफल',
      tx_copied: 'लेनदेन कॉपी किया गया',
      tx_not_available: 'कच्चा लेनदेन उपलब्ध नहीं है',
      tx_copy_failed: 'लेनदेन कॉपी करने में विफल',
      tx_abort_success: 'लेनदेन रद्द किया गया',
      tx_abort_failed: 'लेनदेन रद्द करने में विफल',

      message_box_server: 'मैसेज बॉक्स सर्वर',
      message_box_required: 'पहचान-आधारित भुगतान भेजने और प्राप्त करने के लिए आवश्यक है।',
      message_box_tap_to_configure: 'अपना मैसेज बॉक्स सर्वर कॉन्फ़िगर करने के लिए टैप करें',
      send_payment: 'भुगतान भेजें',
      recipient: 'प्राप्तकर्ता',
      amount_bsv: 'राशि (BSV)',
      incoming_payments: 'आने वाले भुगतान',
      no_pending_payments: 'कोई लंबित भुगतान नहीं',
      valid_identity_key: 'वैध पहचान कुंजी दर्ज की गई',
      searching: 'खोज रहा है...',
      unknown: 'अज्ञात',
      from_prefix: 'से:',
      message_box_saved: 'मैसेज बॉक्स सर्वर सहेजा गया',
      message_box_removed: 'मैसेज बॉक्स सर्वर हटाया गया',
      enter_valid_url: 'कृपया एक वैध URL दर्ज करें',
      search_name_or_key: 'नाम या पहचान कुंजी द्वारा खोजें...',

      trust_updated: 'विश्वास नेटवर्क अपडेट किया गया',
      failed_to_save: 'सहेजने में विफल',
      confirm_delete: 'हटाने की पुष्टि करें',
      confirm_delete_body: 'क्या आप वाकई इस सर्टिफायर को हटाना चाहते हैं?',
      order_certifiers_hint: 'सर्टिफायरों को प्राथमिकता के अनुसार क्रमबद्ध करें। ऐप्स उच्च-रैंक वाले सर्टिफायरों को पहले दिखाएंगे।',
      certifiers: 'सर्टिफायर',
      no_certifiers: 'अभी तक कोई सर्टिफायर नहीं।',
      add_provider: 'प्रदाता जोड़ें',
      unsaved_changes: 'आपके पास असहेजे परिवर्तन हैं',
      duplicate_key_error: 'इस सार्वजनिक कुंजी वाली संस्था पहले से सूची में है!',
      get_provider_details: 'प्रदाता विवरण प्राप्त करें',
      validate_details: 'विवरण सत्यापित करें',
      show_advanced: 'उन्नत दिखाएं',
      hide_advanced: 'उन्नत छुपाएं',
      description_length_error: 'विवरण 5 से 50 अक्षरों के बीच होना चाहिए',
      enter_domain_hint: 'प्रदाता डोमेन दर्ज करें',
      enter_details_hint: 'प्रदाता विवरण दर्ज करें',

      generating_address: 'पता उत्पन्न हो रहा है...',
      available_balance: 'उपलब्ध शेष राशि',
      not_checked: 'जांच नहीं की गई',
      check_balance: 'शेष राशि जांचें',
      import_funds: 'धनराशि आयात करें',
      unable_to_generate_address: 'पता उत्पन्न करने में असमर्थ',
      send_bsv: 'BSV भेजें',
      recipient_address: 'प्राप्तकर्ता का पता',
      enter_bsv_address: 'BSV पता दर्ज करें',
      legacy_info: 'लीगेसी भुगतान आपको P2PKH पते का उपयोग करके पुराने BSV वॉलेट से धनराशि आयात करने की अनुमति देता है।',

      wallet_data: 'वॉलेट डेटा',
      create_new_wallet: 'नया वॉलेट बनाएं',
      generate_recovery_phrase_caption: 'एक नया रिकवरी वाक्यांश उत्पन्न करें',
      import_existing_wallet: 'मौजूदा वॉलेट आयात करें',
      paste_recovery_phrase: 'अपना रिकवरी वाक्यांश पेस्ट करें',
      save_recovery_phrase_heading: 'अपना रिकवरी वाक्यांश सहेजें',
      save_recovery_phrase_btn: 'रिकवरी वाक्यांश सहेजें',
      recovery_phrase_write_down: 'इन 12 शब्दों को क्रम में लिखें और उन्हें सुरक्षित स्थान पर रखें।',
      acknowledgment_text: 'मैंने अपना रिकवरी वाक्यांश लिख लिया है और समझता/समझती हूं कि इसे खोने का मतलब मेरे वॉलेट तक पहुंच खोना है।',
      enter_recovery_words: 'अपने रिकवरी शब्द स्पेस से अलग करके दर्ज करें...',
      restore_wallet_description: 'अपना वॉलेट पुनर्स्थापित करने के लिए रिकवरी वाक्यांश दर्ज करें',
      import_wallet: 'वॉलेट आयात करें',

      reject: 'अस्वीकार करें',
      authorize: 'अधिकृत करें',
      renewal: 'नवीनीकरण',
      spending_section: 'खर्च',
      protocols_section: 'प्रोटोकॉल',
      baskets_section: 'बास्केट',
      certificates_section: 'प्रमाणपत्र',
      requested_fields: 'अनुरोधित फ़ील्ड',

      send_max: 'अधिकतम भेजें',
      entire_wallet_balance: 'पूरी वॉलेट शेष राशि',
      export_data: 'डेटा निर्यात करें',
    }
  },
  es: {
    translation: {
      new_tab: 'Nueva pestaña',
      untitled: 'Sin título',
      share: 'Compartir',
      back_to_homepage: 'Volver a la página de inicio',
      bookmarks: 'Marcadores',
      add_bookmark: 'Agregar marcador',
      history: 'Historial',
      clear_all: 'Borrar todo',
      clear_all_tabs: 'Cerrar todas las pestañas',
      search_or_enter_website: 'Buscar o ingresar sitio web',
      browser: 'Navegador',
      bug_report: 'Reporte de error',
      enable_web3: 'Habilitar Web3',
      tabs: 'Pestañas',
      unlock_web3_features: 'Desbloquear funciones de Web3',

      cancel: 'Cancelar',
      done: 'Listo',
      deny: 'Denegar',
      allow: 'Permitir',
      save: 'Guardar',
      remove: 'Eliminar',
      delete: 'Eliminar',
      accept: 'Aceptar',
      search: 'Buscar',
      loading: 'Cargando...',
      continue: 'Continuar',
      go_back: 'Volver',
      copied: 'Copiado',
      copy_to_clipboard: 'Copiar al portapapeles',
      details: 'Detalles',
      hide_details: 'Ocultar detalles',

      identity: 'Identidad',
      settings: 'Configuración',
      wallet: 'Billetera',
      permissions: 'Permisos',
      trust_network: 'Red de Confianza',

      logout: 'Cerrar sesión',
      bsv_network: 'Red BSV',
      recovery_phrase: 'Frase de recuperación',
      you_have: 'tienes',
      switching: 'Cambiando...',
      mainnet: 'Red principal',
      testnet: 'Red de prueba',
      identity_key: 'Clave de identidad',
      legacy_payments: 'Pagos heredados',
      identity_payments: 'Pagos de Identidad',
      transactions: 'Transacciones',

      no_transactions: 'No hay transacciones aún',
      tx_status_confirmed: 'Confirmado',
      tx_status_accepted: 'Aceptado',
      tx_status_broadcasting: 'Difundiendo',
      tx_status_not_sent: 'No enviado',
      tx_status_unsigned: 'Sin firmar',
      tx_status_nonfinal: 'No final',
      tx_status_failed: 'Fallido',
      tx_copied: 'Transacción copiada',
      tx_not_available: 'Transacción sin procesar no disponible',
      tx_copy_failed: 'Error al copiar la transacción',
      tx_abort_success: 'Transacción abortada',
      tx_abort_failed: 'Error al abortar la transacción',

      message_box_server: 'Servidor de Buzón de Mensajes',
      message_box_required: 'Necesario para enviar y recibir pagos basados en identidad.',
      message_box_tap_to_configure: 'Toca para configurar tu servidor de Buzón de Mensajes',
      send_payment: 'Enviar pago',
      recipient: 'Destinatario',
      amount_bsv: 'Monto (BSV)',
      incoming_payments: 'Pagos entrantes',
      no_pending_payments: 'No hay pagos pendientes',
      valid_identity_key: 'Clave de identidad válida ingresada',
      searching: 'Buscando...',
      unknown: 'Desconocido',
      from_prefix: 'De:',
      message_box_saved: 'Servidor de buzón guardado',
      message_box_removed: 'Servidor de buzón eliminado',
      enter_valid_url: 'Por favor ingresa una URL válida',
      search_name_or_key: 'Buscar por nombre o clave de identidad...',

      trust_updated: 'Red de confianza actualizada',
      failed_to_save: 'Error al guardar',
      confirm_delete: 'Confirmar eliminación',
      confirm_delete_body: '¿Estás seguro de que deseas eliminar este certificador?',
      order_certifiers_hint: 'Ordena los certificadores por prioridad. Las aplicaciones mostrarán primero los certificadores con mayor rango.',
      certifiers: 'Certificadores',
      no_certifiers: 'Aún no hay certificadores.',
      add_provider: 'Agregar proveedor',
      unsaved_changes: 'Tienes cambios sin guardar',
      duplicate_key_error: '¡Una entidad con esta clave pública ya está en la lista!',
      get_provider_details: 'Obtener detalles del proveedor',
      validate_details: 'Validar detalles',
      show_advanced: 'Mostrar avanzado',
      hide_advanced: 'Ocultar avanzado',
      description_length_error: 'La descripción debe tener entre 5 y 50 caracteres',
      enter_domain_hint: 'Ingresa el dominio del proveedor',
      enter_details_hint: 'Ingresa los detalles del proveedor',

      generating_address: 'Generando dirección...',
      available_balance: 'Saldo disponible',
      not_checked: 'No verificado',
      check_balance: 'Verificar saldo',
      import_funds: 'Importar fondos',
      unable_to_generate_address: 'No se puede generar la dirección',
      send_bsv: 'Enviar BSV',
      recipient_address: 'Dirección del destinatario',
      enter_bsv_address: 'Ingresa dirección BSV',
      legacy_info: 'Los pagos heredados te permiten importar fondos de una billetera BSV heredada usando una dirección P2PKH.',

      wallet_data: 'Datos de billetera',
      create_new_wallet: 'Crear nueva billetera',
      generate_recovery_phrase_caption: 'Generar una nueva frase de recuperación',
      import_existing_wallet: 'Importar billetera existente',
      paste_recovery_phrase: 'Pega tu frase de recuperación',
      save_recovery_phrase_heading: 'Guarda tu frase de recuperación',
      save_recovery_phrase_btn: 'Guardar frase de recuperación',
      recovery_phrase_write_down: 'Escribe estas 12 palabras en orden y guárdalas en un lugar seguro.',
      acknowledgment_text: 'He anotado mi frase de recuperación y entiendo que perderla significa perder el acceso a mi billetera.',
      enter_recovery_words: 'Ingresa tus palabras de recuperación separadas por espacios...',
      restore_wallet_description: 'Ingresa tu frase de recuperación para restaurar tu billetera',
      import_wallet: 'Importar billetera',

      reject: 'Rechazar',
      authorize: 'Autorizar',
      renewal: 'Renovación',
      spending_section: 'Gasto',
      protocols_section: 'Protocolos',
      baskets_section: 'Cestas',
      certificates_section: 'Certificados',
      requested_fields: 'Campos solicitados',

      send_max: 'Enviar máximo',
      entire_wallet_balance: 'Todo el saldo de la billetera',
      export_data: 'Exportar datos',
    }
  },
  fr: {
    translation: {
      new_tab: 'Nouvel onglet',
      untitled: 'Sans titre',
      share: 'Partager',
      back_to_homepage: "Retour à l'accueil",
      bookmarks: 'Favoris',
      add_bookmark: 'Ajouter aux favoris',
      history: 'Historique',
      clear_all: 'Tout effacer',
      clear_all_tabs: 'Fermer tous les onglets',
      search_or_enter_website: 'Rechercher ou entrer un site web',
      browser: 'Navigateur',
      bug_report: 'Rapport de bogue',
      enable_web3: 'Activer Web3',
      tabs: 'Onglets',
      unlock_web3_features: 'Débloquer les fonctionnalités Web3',

      cancel: 'Annuler',
      done: 'Terminé',
      deny: 'Refuser',
      allow: 'Autoriser',
      save: 'Enregistrer',
      remove: 'Supprimer',
      delete: 'Supprimer',
      accept: 'Accepter',
      search: 'Rechercher',
      loading: 'Chargement...',
      continue: 'Continuer',
      go_back: 'Retour',
      copied: 'Copié',
      copy_to_clipboard: 'Copier dans le presse-papiers',
      details: 'Détails',
      hide_details: 'Masquer les détails',

      identity: 'Identité',
      settings: 'Paramètres',
      wallet: 'Portefeuille',
      permissions: 'Autorisations',
      trust_network: 'Réseau de confiance',

      logout: 'Déconnexion',
      bsv_network: 'Réseau BSV',
      recovery_phrase: 'Mnémonique',
      you_have: 'vous avez',
      switching: 'Changement...',
      mainnet: 'Réseau principal',
      testnet: 'Réseau de test',
      identity_key: "Clé d'identité",
      legacy_payments: 'Paiements hérités',
      identity_payments: "Paiements d'identité",
      transactions: 'Transactions',

      no_transactions: 'Aucune transaction pour le moment',
      tx_status_confirmed: 'Confirmé',
      tx_status_accepted: 'Accepté',
      tx_status_broadcasting: 'Diffusion',
      tx_status_not_sent: 'Non envoyé',
      tx_status_unsigned: 'Non signé',
      tx_status_nonfinal: 'Non final',
      tx_status_failed: 'Échoué',
      tx_copied: 'Transaction copiée',
      tx_not_available: 'Transaction brute non disponible',
      tx_copy_failed: 'Échec de la copie de la transaction',
      tx_abort_success: 'Transaction annulée',
      tx_abort_failed: "Échec de l'annulation de la transaction",

      message_box_server: 'Serveur de boîte aux lettres',
      message_box_required: "Requis pour envoyer et recevoir des paiements basés sur l'identité.",
      message_box_tap_to_configure: 'Appuyez pour configurer votre serveur de boîte aux lettres',
      send_payment: 'Envoyer un paiement',
      recipient: 'Destinataire',
      amount_bsv: 'Montant (BSV)',
      incoming_payments: 'Paiements entrants',
      no_pending_payments: 'Aucun paiement en attente',
      valid_identity_key: "Clé d'identité valide saisie",
      searching: 'Recherche en cours...',
      unknown: 'Inconnu',
      from_prefix: 'De :',
      message_box_saved: 'Serveur de boîte aux lettres enregistré',
      message_box_removed: 'Serveur de boîte aux lettres supprimé',
      enter_valid_url: 'Veuillez saisir une URL valide',
      search_name_or_key: "Rechercher par nom ou clé d'identité...",

      trust_updated: 'Réseau de confiance mis à jour',
      failed_to_save: "Échec de l'enregistrement",
      confirm_delete: 'Confirmer la suppression',
      confirm_delete_body: 'Êtes-vous sûr de vouloir supprimer ce certificateur ?',
      order_certifiers_hint: 'Classez les certificateurs par priorité. Les applications afficheront en premier les certificateurs les mieux classés.',
      certifiers: 'Certificateurs',
      no_certifiers: 'Aucun certificateur pour le moment.',
      add_provider: 'Ajouter un fournisseur',
      unsaved_changes: 'Vous avez des modifications non enregistrées',
      duplicate_key_error: 'Une entité avec cette clé publique est déjà dans la liste !',
      get_provider_details: 'Obtenir les détails du fournisseur',
      validate_details: 'Valider les détails',
      show_advanced: 'Afficher avancé',
      hide_advanced: 'Masquer avancé',
      description_length_error: 'La description doit comporter entre 5 et 50 caractères',
      enter_domain_hint: 'Saisissez le domaine du fournisseur',
      enter_details_hint: 'Saisissez les détails du fournisseur',

      generating_address: "Génération de l'adresse...",
      available_balance: 'Solde disponible',
      not_checked: 'Non vérifié',
      check_balance: 'Vérifier le solde',
      import_funds: 'Importer des fonds',
      unable_to_generate_address: "Impossible de générer l'adresse",
      send_bsv: 'Envoyer BSV',
      recipient_address: 'Adresse du destinataire',
      enter_bsv_address: "Saisir l'adresse BSV",
      legacy_info: "Les paiements hérités vous permettent d'importer des fonds depuis un portefeuille BSV hérité en utilisant une adresse P2PKH.",

      wallet_data: 'Données du portefeuille',
      create_new_wallet: 'Créer un nouveau portefeuille',
      generate_recovery_phrase_caption: 'Générer une nouvelle phrase de récupération',
      import_existing_wallet: 'Importer un portefeuille existant',
      paste_recovery_phrase: 'Collez votre phrase de récupération',
      save_recovery_phrase_heading: 'Sauvegardez votre phrase de récupération',
      save_recovery_phrase_btn: 'Enregistrer la phrase de récupération',
      recovery_phrase_write_down: "Notez ces 12 mots dans l'ordre et conservez-les en lieu sûr.",
      acknowledgment_text: "J'ai noté ma phrase de récupération et je comprends que la perdre signifie perdre l'accès à mon portefeuille.",
      enter_recovery_words: 'Entrez vos mots de récupération séparés par des espaces...',
      restore_wallet_description: 'Entrez votre phrase de récupération pour restaurer votre portefeuille',
      import_wallet: 'Importer le portefeuille',

      reject: 'Rejeter',
      authorize: 'Autoriser',
      renewal: 'Renouvellement',
      spending_section: 'Dépenses',
      protocols_section: 'Protocoles',
      baskets_section: 'Paniers',
      certificates_section: 'Certificats',
      requested_fields: 'Champs demandés',

      send_max: 'Envoyer le maximum',
      entire_wallet_balance: 'Solde total du portefeuille',
      export_data: 'Exporter les données',
    }
  },
  ar: {
    translation: {
      new_tab: 'علامة تبويب جديدة',
      untitled: 'بدون عنوان',
      share: 'مشاركة',
      back_to_homepage: 'العودة إلى الصفحة الرئيسية',
      bookmarks: 'الإشارات المرجعية',
      add_bookmark: 'إضافة إشارة مرجعية',
      history: 'السجل',
      clear_all: 'مسح الكل',
      clear_all_tabs: 'مسح كل علامات التبويب',
      search_or_enter_website: 'البحث أو إدخال موقع الويب',
      browser: 'المتصفح',
      bug_report: 'تقرير خطأ',
      enable_web3: 'تفعيل Web3',
      tabs: 'علامات التبويب',
      unlock_web3_features: 'فتح ميزات Web3',

      cancel: 'إلغاء',
      done: 'تم',
      deny: 'رفض',
      allow: 'السماح',
      save: 'حفظ',
      remove: 'إزالة',
      delete: 'حذف',
      accept: 'قبول',
      search: 'بحث',
      loading: '...جار التحميل',
      continue: 'استمرار',
      go_back: 'العودة',
      copied: 'تم النسخ',
      copy_to_clipboard: 'نسخ إلى الحافظة',
      details: 'التفاصيل',
      hide_details: 'إخفاء التفاصيل',

      identity: 'الهوية',
      settings: 'الإعدادات',
      wallet: 'المحفظة',
      permissions: 'الأذونات',
      trust_network: 'شبكة الثقة',

      logout: 'تسجيل الخروج',
      bsv_network: 'شبكة BSV',
      recovery_phrase: 'عبارة تذكيرية',
      you_have: 'لديك',
      switching: '...جار التحويل',
      mainnet: 'الشبكة الرئيسية',
      testnet: 'شبكة الاختبار',
      identity_key: 'مفتاح الهوية',
      legacy_payments: 'المدفوعات القديمة',
      identity_payments: 'مدفوعات الهوية',
      transactions: 'المعاملات',

      no_transactions: 'لا توجد معاملات بعد',
      tx_status_confirmed: 'مؤكد',
      tx_status_accepted: 'مقبول',
      tx_status_broadcasting: 'جار الإذاعة',
      tx_status_not_sent: 'لم يتم الإرسال',
      tx_status_unsigned: 'غير موقع',
      tx_status_nonfinal: 'غير نهائي',
      tx_status_failed: 'فشل',
      tx_copied: 'تم نسخ المعاملة',
      tx_not_available: 'المعاملة الأولية غير متوفرة',
      tx_copy_failed: 'فشل نسخ المعاملة',
      tx_abort_success: 'تم إلغاء المعاملة',
      tx_abort_failed: 'فشل إلغاء المعاملة',

      message_box_server: 'خادم صندوق الرسائل',
      message_box_required: 'مطلوب لإرسال واستقبال المدفوعات القائمة على الهوية.',
      message_box_tap_to_configure: 'انقر لتكوين خادم صندوق الرسائل الخاص بك',
      send_payment: 'إرسال دفعة',
      recipient: 'المستلم',
      amount_bsv: 'المبلغ (BSV)',
      incoming_payments: 'المدفوعات الواردة',
      no_pending_payments: 'لا توجد مدفوعات معلقة',
      valid_identity_key: 'تم إدخال مفتاح هوية صالح',
      searching: '...جار البحث',
      unknown: 'غير معروف',
      from_prefix: ':من',
      message_box_saved: 'تم حفظ خادم صندوق الرسائل',
      message_box_removed: 'تم إزالة خادم صندوق الرسائل',
      enter_valid_url: 'يرجى إدخال عنوان URL صالح',
      search_name_or_key: 'البحث بالاسم أو مفتاح الهوية...',

      trust_updated: 'تم تحديث شبكة الثقة',
      failed_to_save: 'فشل الحفظ',
      confirm_delete: 'تأكيد الحذف',
      confirm_delete_body: 'هل أنت متأكد أنك تريد حذف هذا المُصادق؟',
      order_certifiers_hint: 'رتب المُصادقين حسب الأولوية. ستعرض التطبيقات المُصادقين ذوي الترتيب الأعلى أولاً.',
      certifiers: 'المُصادقون',
      no_certifiers: 'لا توجد مُصادقون بعد.',
      add_provider: 'إضافة مزود',
      unsaved_changes: 'لديك تغييرات غير محفوظة',
      duplicate_key_error: 'الكيان الذي يحمل هذا المفتاح العام موجود بالفعل في القائمة!',
      get_provider_details: 'الحصول على تفاصيل المزود',
      validate_details: 'التحقق من التفاصيل',
      show_advanced: 'إظهار الخيارات المتقدمة',
      hide_advanced: 'إخفاء الخيارات المتقدمة',
      description_length_error: 'يجب أن يكون الوصف بين 5 و50 حرفًا',
      enter_domain_hint: 'أدخل نطاق المزود',
      enter_details_hint: 'أدخل تفاصيل المزود',

      generating_address: '...جار إنشاء العنوان',
      available_balance: 'الرصيد المتاح',
      not_checked: 'لم يتم التحقق',
      check_balance: 'التحقق من الرصيد',
      import_funds: 'استيراد الأموال',
      unable_to_generate_address: 'تعذر إنشاء العنوان',
      send_bsv: 'إرسال BSV',
      recipient_address: 'عنوان المستلم',
      enter_bsv_address: 'أدخل عنوان BSV',
      legacy_info: 'تتيح لك المدفوعات القديمة استيراد الأموال من محفظة BSV قديمة باستخدام عنوان P2PKH.',

      wallet_data: 'بيانات المحفظة',
      create_new_wallet: 'إنشاء محفظة جديدة',
      generate_recovery_phrase_caption: 'إنشاء عبارة استرداد جديدة',
      import_existing_wallet: 'استيراد محفظة موجودة',
      paste_recovery_phrase: 'الصق عبارة الاسترداد الخاصة بك',
      save_recovery_phrase_heading: 'احفظ عبارة الاسترداد الخاصة بك',
      save_recovery_phrase_btn: 'حفظ عبارة الاسترداد',
      recovery_phrase_write_down: 'اكتب هذه الكلمات الـ12 بالترتيب واحتفظ بها في مكان آمن.',
      acknowledgment_text: 'لقد دوّنت عبارة الاسترداد الخاصة بي وأفهم أن فقدانها يعني فقدان الوصول إلى محفظتي.',
      enter_recovery_words: 'أدخل كلمات الاسترداد مفصولة بمسافات...',
      restore_wallet_description: 'أدخل عبارة الاسترداد لاستعادة محفظتك',
      import_wallet: 'استيراد المحفظة',

      reject: 'رفض',
      authorize: 'تفويض',
      renewal: 'تجديد',
      spending_section: 'الإنفاق',
      protocols_section: 'البروتوكولات',
      baskets_section: 'السلال',
      certificates_section: 'الشهادات',
      requested_fields: 'الحقول المطلوبة',

      send_max: 'إرسال الحد الأقصى',
      entire_wallet_balance: 'رصيد المحفظة بالكامل',
      export_data: 'تصدير البيانات',
    }
  },
  pt: {
    translation: {
      new_tab: 'Nova aba',
      untitled: 'Sem título',
      share: 'Compartilhar',
      back_to_homepage: 'Voltar à página inicial',
      bookmarks: 'Favoritos',
      add_bookmark: 'Adicionar favorito',
      history: 'Histórico',
      clear_all: 'Limpar tudo',
      clear_all_tabs: 'Fechar todas as abas',
      search_or_enter_website: 'Pesquisar ou digitar site',
      browser: 'Navegador',
      bug_report: 'Relatório de bug',
      enable_web3: 'Ativar Web3',
      tabs: 'Abas',
      unlock_web3_features: 'Desbloquear recursos Web3',

      cancel: 'Cancelar',
      done: 'Concluído',
      deny: 'Negar',
      allow: 'Permitir',
      save: 'Salvar',
      remove: 'Remover',
      delete: 'Excluir',
      accept: 'Aceitar',
      search: 'Pesquisar',
      loading: 'Carregando...',
      continue: 'Continuar',
      go_back: 'Voltar',
      copied: 'Copiado',
      copy_to_clipboard: 'Copiar para área de transferência',
      details: 'Detalhes',
      hide_details: 'Ocultar detalhes',

      identity: 'Identidade',
      settings: 'Configurações',
      wallet: 'Carteira',
      permissions: 'Permissões',
      trust_network: 'Rede de Confiança',

      logout: 'Sair',
      bsv_network: 'Rede BSV',
      recovery_phrase: 'Mnemônico',
      you_have: 'você tem',
      switching: 'Alterando...',
      mainnet: 'Rede principal',
      testnet: 'Rede de teste',
      identity_key: 'Chave de identidade',
      legacy_payments: 'Pagamentos legados',
      identity_payments: 'Pagamentos de Identidade',
      transactions: 'Transações',

      no_transactions: 'Nenhuma transação ainda',
      tx_status_confirmed: 'Confirmado',
      tx_status_accepted: 'Aceito',
      tx_status_broadcasting: 'Transmitindo',
      tx_status_not_sent: 'Não enviado',
      tx_status_unsigned: 'Não assinado',
      tx_status_nonfinal: 'Não final',
      tx_status_failed: 'Falhou',
      tx_copied: 'Transação copiada',
      tx_not_available: 'Transação bruta não disponível',
      tx_copy_failed: 'Falha ao copiar transação',
      tx_abort_success: 'Transação abortada',
      tx_abort_failed: 'Falha ao abortar transação',

      message_box_server: 'Servidor de Caixa de Mensagens',
      message_box_required: 'Necessário para enviar e receber pagamentos baseados em identidade.',
      message_box_tap_to_configure: 'Toque para configurar seu servidor de Caixa de Mensagens',
      send_payment: 'Enviar pagamento',
      recipient: 'Destinatário',
      amount_bsv: 'Valor (BSV)',
      incoming_payments: 'Pagamentos recebidos',
      no_pending_payments: 'Nenhum pagamento pendente',
      valid_identity_key: 'Chave de identidade válida inserida',
      searching: 'Pesquisando...',
      unknown: 'Desconhecido',
      from_prefix: 'De:',
      message_box_saved: 'Servidor de caixa de mensagens salvo',
      message_box_removed: 'Servidor de caixa de mensagens removido',
      enter_valid_url: 'Por favor, insira uma URL válida',
      search_name_or_key: 'Pesquisar por nome ou chave de identidade...',

      trust_updated: 'Rede de confiança atualizada',
      failed_to_save: 'Falha ao salvar',
      confirm_delete: 'Confirmar exclusão',
      confirm_delete_body: 'Tem certeza de que deseja excluir este certificador?',
      order_certifiers_hint: 'Ordene os certificadores por prioridade. Os aplicativos exibirão os certificadores de maior ranking primeiro.',
      certifiers: 'Certificadores',
      no_certifiers: 'Nenhum certificador ainda.',
      add_provider: 'Adicionar provedor',
      unsaved_changes: 'Você tem alterações não salvas',
      duplicate_key_error: 'Uma entidade com esta chave pública já está na lista!',
      get_provider_details: 'Obter detalhes do provedor',
      validate_details: 'Validar detalhes',
      show_advanced: 'Mostrar avançado',
      hide_advanced: 'Ocultar avançado',
      description_length_error: 'A descrição deve ter entre 5 e 50 caracteres',
      enter_domain_hint: 'Digite o domínio do provedor',
      enter_details_hint: 'Digite os detalhes do provedor',

      generating_address: 'Gerando endereço...',
      available_balance: 'Saldo disponível',
      not_checked: 'Não verificado',
      check_balance: 'Verificar saldo',
      import_funds: 'Importar fundos',
      unable_to_generate_address: 'Não é possível gerar o endereço',
      send_bsv: 'Enviar BSV',
      recipient_address: 'Endereço do destinatário',
      enter_bsv_address: 'Digite o endereço BSV',
      legacy_info: 'Os pagamentos legados permitem que você importe fundos de uma carteira BSV legada usando um endereço P2PKH.',

      wallet_data: 'Dados da carteira',
      create_new_wallet: 'Criar nova carteira',
      generate_recovery_phrase_caption: 'Gerar uma nova frase de recuperação',
      import_existing_wallet: 'Importar carteira existente',
      paste_recovery_phrase: 'Cole sua frase de recuperação',
      save_recovery_phrase_heading: 'Salve sua frase de recuperação',
      save_recovery_phrase_btn: 'Salvar frase de recuperação',
      recovery_phrase_write_down: 'Anote essas 12 palavras em ordem e guarde-as em um lugar seguro.',
      acknowledgment_text: 'Anotei minha frase de recuperação e entendo que perdê-la significa perder o acesso à minha carteira.',
      enter_recovery_words: 'Digite suas palavras de recuperação separadas por espaços...',
      restore_wallet_description: 'Digite sua frase de recuperação para restaurar sua carteira',
      import_wallet: 'Importar carteira',

      reject: 'Rejeitar',
      authorize: 'Autorizar',
      renewal: 'Renovação',
      spending_section: 'Gastos',
      protocols_section: 'Protocolos',
      baskets_section: 'Cestas',
      certificates_section: 'Certificados',
      requested_fields: 'Campos solicitados',

      send_max: 'Enviar máximo',
      entire_wallet_balance: 'Saldo total da carteira',
      export_data: 'Exportar dados',
    }
  },
  bn: {
    translation: {
      new_tab: 'নতুন ট্যাব',
      untitled: 'শিরোনামহীন',
      share: 'শেয়ার করুন',
      back_to_homepage: 'হোমপেজে ফিরুন',
      bookmarks: 'বুকমার্ক',
      add_bookmark: 'বুকমার্ক যোগ করুন',
      history: 'ইতিহাস',
      clear_all: 'সব মুছুন',
      clear_all_tabs: 'সব ট্যাব মুছুন',
      search_or_enter_website: 'খুঁজুন বা ওয়েবসাইট লিখুন',
      browser: 'ব্রাউজার',
      bug_report: 'বাগ রিপোর্ট',
      enable_web3: 'Web3 সক্রিয় করুন',
      tabs: 'ট্যাব',
      unlock_web3_features: 'Web3 বৈশিষ্ট্য আনলক করুন',

      cancel: 'বাতিল',
      done: 'সম্পন্ন',
      deny: 'প্রত্যাখ্যান',
      allow: 'অনুমতি দিন',
      save: 'সংরক্ষণ করুন',
      remove: 'সরান',
      delete: 'মুছুন',
      accept: 'গ্রহণ করুন',
      search: 'খুঁজুন',
      loading: 'লোড হচ্ছে...',
      continue: 'চালিয়ে যান',
      go_back: 'ফিরে যান',
      copied: 'কপি করা হয়েছে',
      copy_to_clipboard: 'ক্লিপবোর্ডে কপি করুন',
      details: 'বিবরণ',
      hide_details: 'বিবরণ লুকান',

      identity: 'পরিচয়',
      settings: 'সেটিংস',
      wallet: 'ওয়ালেট',
      permissions: 'অনুমতি',
      trust_network: 'বিশ্বাস নেটওয়ার্ক',

      logout: 'লগ আউট',
      bsv_network: 'BSV নেটওয়ার্ক',
      recovery_phrase: 'মেমোনিক',
      you_have: 'আপনার আছে',
      switching: 'পরিবর্তন হচ্ছে...',
      mainnet: 'মেইননেট',
      testnet: 'টেস্টনেট',
      identity_key: 'পরিচয় কী',
      legacy_payments: 'লিগেসি পেমেন্ট',
      identity_payments: 'পরিচয় পেমেন্ট',
      transactions: 'লেনদেন',

      no_transactions: 'এখনো কোনো লেনদেন নেই',
      tx_status_confirmed: 'নিশ্চিত',
      tx_status_accepted: 'গৃহীত',
      tx_status_broadcasting: 'ব্রডকাস্টিং',
      tx_status_not_sent: 'পাঠানো হয়নি',
      tx_status_unsigned: 'স্বাক্ষরবিহীন',
      tx_status_nonfinal: 'অচূড়ান্ত',
      tx_status_failed: 'ব্যর্থ',
      tx_copied: 'লেনদেন কপি করা হয়েছে',
      tx_not_available: 'কাঁচা লেনদেন পাওয়া যাচ্ছে না',
      tx_copy_failed: 'লেনদেন কপি করতে ব্যর্থ',
      tx_abort_success: 'লেনদেন বাতিল করা হয়েছে',
      tx_abort_failed: 'লেনদেন বাতিল করতে ব্যর্থ',

      message_box_server: 'মেসেজ বক্স সার্ভার',
      message_box_required: 'পরিচয়-ভিত্তিক পেমেন্ট পাঠাতে ও গ্রহণ করতে প্রয়োজনীয়।',
      message_box_tap_to_configure: 'আপনার মেসেজ বক্স সার্ভার কনফিগার করতে ট্যাপ করুন',
      send_payment: 'পেমেন্ট পাঠান',
      recipient: 'প্রাপক',
      amount_bsv: 'পরিমাণ (BSV)',
      incoming_payments: 'আসন্ন পেমেন্ট',
      no_pending_payments: 'কোনো মুলতুবি পেমেন্ট নেই',
      valid_identity_key: 'বৈধ পরিচয় কী প্রবেশ করা হয়েছে',
      searching: 'খুঁজছি...',
      unknown: 'অজানা',
      from_prefix: 'থেকে:',
      message_box_saved: 'মেসেজ বক্স সার্ভার সংরক্ষিত হয়েছে',
      message_box_removed: 'মেসেজ বক্স সার্ভার সরানো হয়েছে',
      enter_valid_url: 'একটি বৈধ URL প্রবেশ করুন',
      search_name_or_key: 'নাম বা পরিচয় কী দিয়ে খুঁজুন...',

      trust_updated: 'বিশ্বাস নেটওয়ার্ক আপডেট হয়েছে',
      failed_to_save: 'সংরক্ষণ করতে ব্যর্থ',
      confirm_delete: 'মুছে ফেলার নিশ্চয়তা দিন',
      confirm_delete_body: 'আপনি কি সত্যিই এই সার্টিফায়ারটি মুছতে চান?',
      order_certifiers_hint: 'সার্টিফায়ারগুলো অগ্রাধিকার অনুযায়ী সাজান। অ্যাপগুলো উচ্চ-র্যাঙ্কের সার্টিফায়ারগুলো প্রথমে দেখাবে।',
      certifiers: 'সার্টিফায়ার',
      no_certifiers: 'এখনো কোনো সার্টিফায়ার নেই।',
      add_provider: 'প্রদানকারী যোগ করুন',
      unsaved_changes: 'আপনার অসংরক্ষিত পরিবর্তন আছে',
      duplicate_key_error: 'এই পাবলিক কী সহ একটি সত্তা ইতিমধ্যে তালিকায় আছে!',
      get_provider_details: 'প্রদানকারীর বিবরণ পান',
      validate_details: 'বিবরণ যাচাই করুন',
      show_advanced: 'উন্নত দেখান',
      hide_advanced: 'উন্নত লুকান',
      description_length_error: 'বিবরণ ৫ থেকে ৫০ অক্ষরের মধ্যে হতে হবে',
      enter_domain_hint: 'প্রদানকারীর ডোমেন প্রবেশ করুন',
      enter_details_hint: 'প্রদানকারীর বিবরণ প্রবেশ করুন',

      generating_address: 'ঠিকানা তৈরি হচ্ছে...',
      available_balance: 'উপলব্ধ ব্যালেন্স',
      not_checked: 'যাচাই করা হয়নি',
      check_balance: 'ব্যালেন্স যাচাই করুন',
      import_funds: 'তহবিল আমদানি করুন',
      unable_to_generate_address: 'ঠিকানা তৈরি করা যাচ্ছে না',
      send_bsv: 'BSV পাঠান',
      recipient_address: 'প্রাপকের ঠিকানা',
      enter_bsv_address: 'BSV ঠিকানা প্রবেশ করুন',
      legacy_info: 'লিগেসি পেমেন্ট আপনাকে P2PKH ঠিকানা ব্যবহার করে পুরানো BSV ওয়ালেট থেকে তহবিল আমদানি করতে দেয়।',

      wallet_data: 'ওয়ালেট ডেটা',
      create_new_wallet: 'নতুন ওয়ালেট তৈরি করুন',
      generate_recovery_phrase_caption: 'একটি নতুন রিকভারি বাক্যাংশ তৈরি করুন',
      import_existing_wallet: 'বিদ্যমান ওয়ালেট আমদানি করুন',
      paste_recovery_phrase: 'আপনার রিকভারি বাক্যাংশ পেস্ট করুন',
      save_recovery_phrase_heading: 'আপনার রিকভারি বাক্যাংশ সংরক্ষণ করুন',
      save_recovery_phrase_btn: 'রিকভারি বাক্যাংশ সংরক্ষণ করুন',
      recovery_phrase_write_down: 'এই ১২টি শব্দ ক্রমানুসারে লিখুন এবং একটি নিরাপদ স্থানে সংরক্ষণ করুন।',
      acknowledgment_text: 'আমি আমার রিকভারি বাক্যাংশ লিখে নিয়েছি এবং বুঝি যে এটি হারিয়ে ফেললে আমার ওয়ালেটে প্রবেশাধিকার হারাবো।',
      enter_recovery_words: 'আপনার রিকভারি শব্দগুলো স্পেস দিয়ে আলাদা করে লিখুন...',
      restore_wallet_description: 'আপনার ওয়ালেট পুনরুদ্ধার করতে রিকভারি বাক্যাংশ প্রবেশ করুন',
      import_wallet: 'ওয়ালেট আমদানি করুন',

      reject: 'প্রত্যাখ্যান করুন',
      authorize: 'অনুমোদন করুন',
      renewal: 'নবায়ন',
      spending_section: 'ব্যয়',
      protocols_section: 'প্রোটোকল',
      baskets_section: 'বাস্কেট',
      certificates_section: 'সার্টিফিকেট',
      requested_fields: 'অনুরোধকৃত ক্ষেত্র',

      send_max: 'সর্বোচ্চ পাঠান',
      entire_wallet_balance: 'সম্পূর্ণ ওয়ালেট ব্যালেন্স',
      export_data: 'ডেটা রপ্তানি করুন',
    }
  },
  ru: {
    translation: {
      new_tab: 'Новая вкладка',
      untitled: 'Без названия',
      share: 'Поделиться',
      back_to_homepage: 'На главную страницу',
      bookmarks: 'Закладки',
      add_bookmark: 'Добавить закладку',
      history: 'История',
      clear_all: 'Очистить все',
      clear_all_tabs: 'Закрыть все вкладки',
      search_or_enter_website: 'Поиск или введите сайт',
      browser: 'Браузер',
      bug_report: 'Отчёт об ошибке',
      enable_web3: 'Включить Web3',
      tabs: 'Вкладки',
      unlock_web3_features: 'Разблокировать функции Web3',

      cancel: 'Отмена',
      done: 'Готово',
      deny: 'Отклонить',
      allow: 'Разрешить',
      save: 'Сохранить',
      remove: 'Удалить',
      delete: 'Удалить',
      accept: 'Принять',
      search: 'Поиск',
      loading: 'Загрузка...',
      continue: 'Продолжить',
      go_back: 'Назад',
      copied: 'Скопировано',
      copy_to_clipboard: 'Скопировать в буфер обмена',
      details: 'Подробности',
      hide_details: 'Скрыть подробности',

      identity: 'Идентичность',
      settings: 'Настройки',
      wallet: 'Кошелёк',
      permissions: 'Разрешения',
      trust_network: 'Сеть доверия',

      logout: 'Выход',
      bsv_network: 'Сеть BSV',
      recovery_phrase: 'Мнемоника',
      you_have: 'у вас',
      switching: 'Переключение...',
      mainnet: 'Основная сеть',
      testnet: 'Тестовая сеть',
      identity_key: 'Ключ идентификатора',
      legacy_payments: 'Устаревшие платежи',
      identity_payments: 'Платежи по идентификатору',
      transactions: 'Транзакции',

      no_transactions: 'Транзакций пока нет',
      tx_status_confirmed: 'Подтверждено',
      tx_status_accepted: 'Принято',
      tx_status_broadcasting: 'Трансляция',
      tx_status_not_sent: 'Не отправлено',
      tx_status_unsigned: 'Не подписано',
      tx_status_nonfinal: 'Не завершено',
      tx_status_failed: 'Ошибка',
      tx_copied: 'Транзакция скопирована',
      tx_not_available: 'Необработанная транзакция недоступна',
      tx_copy_failed: 'Не удалось скопировать транзакцию',
      tx_abort_success: 'Транзакция отменена',
      tx_abort_failed: 'Не удалось отменить транзакцию',

      message_box_server: 'Сервер почтового ящика',
      message_box_required: 'Требуется для отправки и получения платежей на основе идентификатора.',
      message_box_tap_to_configure: 'Нажмите, чтобы настроить сервер почтового ящика',
      send_payment: 'Отправить платёж',
      recipient: 'Получатель',
      amount_bsv: 'Сумма (BSV)',
      incoming_payments: 'Входящие платежи',
      no_pending_payments: 'Нет ожидающих платежей',
      valid_identity_key: 'Введён действительный ключ идентификатора',
      searching: 'Поиск...',
      unknown: 'Неизвестно',
      from_prefix: 'От:',
      message_box_saved: 'Сервер почтового ящика сохранён',
      message_box_removed: 'Сервер почтового ящика удалён',
      enter_valid_url: 'Введите действительный URL',
      search_name_or_key: 'Поиск по имени или ключу идентификатора...',

      trust_updated: 'Сеть доверия обновлена',
      failed_to_save: 'Не удалось сохранить',
      confirm_delete: 'Подтвердить удаление',
      confirm_delete_body: 'Вы уверены, что хотите удалить этого сертификатора?',
      order_certifiers_hint: 'Упорядочите сертификаторов по приоритету. Приложения будут отображать сертификаторов с более высоким рейтингом первыми.',
      certifiers: 'Сертификаторы',
      no_certifiers: 'Сертификаторов пока нет.',
      add_provider: 'Добавить провайдера',
      unsaved_changes: 'У вас есть несохранённые изменения',
      duplicate_key_error: 'Объект с этим открытым ключом уже есть в списке!',
      get_provider_details: 'Получить сведения о провайдере',
      validate_details: 'Проверить данные',
      show_advanced: 'Показать расширенные',
      hide_advanced: 'Скрыть расширенные',
      description_length_error: 'Описание должно содержать от 5 до 50 символов',
      enter_domain_hint: 'Введите домен провайдера',
      enter_details_hint: 'Введите данные провайдера',

      generating_address: 'Генерация адреса...',
      available_balance: 'Доступный баланс',
      not_checked: 'Не проверено',
      check_balance: 'Проверить баланс',
      import_funds: 'Импортировать средства',
      unable_to_generate_address: 'Невозможно создать адрес',
      send_bsv: 'Отправить BSV',
      recipient_address: 'Адрес получателя',
      enter_bsv_address: 'Введите адрес BSV',
      legacy_info: 'Устаревшие платежи позволяют импортировать средства из старого кошелька BSV с использованием адреса P2PKH.',

      wallet_data: 'Данные кошелька',
      create_new_wallet: 'Создать новый кошелёк',
      generate_recovery_phrase_caption: 'Создать новую мнемоническую фразу',
      import_existing_wallet: 'Импортировать существующий кошелёк',
      paste_recovery_phrase: 'Вставьте мнемоническую фразу',
      save_recovery_phrase_heading: 'Сохраните мнемоническую фразу',
      save_recovery_phrase_btn: 'Сохранить мнемоническую фразу',
      recovery_phrase_write_down: 'Запишите эти 12 слов по порядку и храните их в надёжном месте.',
      acknowledgment_text: 'Я записал(а) мнемоническую фразу и понимаю, что её утеря означает потерю доступа к кошельку.',
      enter_recovery_words: 'Введите слова мнемоники через пробел...',
      restore_wallet_description: 'Введите мнемоническую фразу для восстановления кошелька',
      import_wallet: 'Импортировать кошелёк',

      reject: 'Отклонить',
      authorize: 'Авторизовать',
      renewal: 'Продление',
      spending_section: 'Расходы',
      protocols_section: 'Протоколы',
      baskets_section: 'Корзины',
      certificates_section: 'Сертификаты',
      requested_fields: 'Запрошенные поля',

      send_max: 'Отправить максимум',
      entire_wallet_balance: 'Весь баланс кошелька',
      export_data: 'Экспортировать данные',
    }
  },
  id: {
    translation: {
      new_tab: 'Tab Baru',
      untitled: 'Tanpa judul',
      share: 'Bagikan',
      back_to_homepage: 'Kembali ke Beranda',
      bookmarks: 'Bookmark',
      add_bookmark: 'Tambah Bookmark',
      history: 'Riwayat',
      clear_all: 'Hapus Semua',
      clear_all_tabs: 'Tutup Semua Tab',
      search_or_enter_website: 'Cari atau masukkan website',
      browser: 'Browser',
      bug_report: 'Laporan Bug',
      enable_web3: 'Aktifkan Web3',
      tabs: 'Tab',
      unlock_web3_features: 'Buka fitur Web3',

      cancel: 'Batal',
      done: 'Selesai',
      deny: 'Tolak',
      allow: 'Izinkan',
      save: 'Simpan',
      remove: 'Hapus',
      delete: 'Hapus',
      accept: 'Terima',
      search: 'Cari',
      loading: 'Memuat...',
      continue: 'Lanjutkan',
      go_back: 'Kembali',
      copied: 'Tersalin',
      copy_to_clipboard: 'Salin ke Clipboard',
      details: 'Detail',
      hide_details: 'Sembunyikan detail',

      identity: 'Identitas',
      settings: 'Pengaturan',
      wallet: 'Dompet',
      permissions: 'Izin',
      trust_network: 'Jaringan Kepercayaan',

      logout: 'Keluar',
      bsv_network: 'Jaringan BSV',
      recovery_phrase: 'Mnemonik',
      you_have: 'Anda memiliki',
      switching: 'Mengalihkan...',
      mainnet: 'Mainnet',
      testnet: 'Testnet',
      identity_key: 'Kunci Identitas',
      legacy_payments: 'Pembayaran Lama',
      identity_payments: 'Pembayaran Identitas',
      transactions: 'Transaksi',

      no_transactions: 'Belum ada transaksi',
      tx_status_confirmed: 'Dikonfirmasi',
      tx_status_accepted: 'Diterima',
      tx_status_broadcasting: 'Menyiarkan',
      tx_status_not_sent: 'Tidak Dikirim',
      tx_status_unsigned: 'Belum Ditandatangani',
      tx_status_nonfinal: 'Belum Final',
      tx_status_failed: 'Gagal',
      tx_copied: 'Transaksi disalin',
      tx_not_available: 'Transaksi mentah tidak tersedia',
      tx_copy_failed: 'Gagal menyalin transaksi',
      tx_abort_success: 'Transaksi dibatalkan',
      tx_abort_failed: 'Gagal membatalkan transaksi',

      message_box_server: 'Server Kotak Pesan',
      message_box_required: 'Diperlukan untuk mengirim dan menerima pembayaran berbasis identitas.',
      message_box_tap_to_configure: 'Ketuk untuk mengonfigurasi server Kotak Pesan Anda',
      send_payment: 'Kirim Pembayaran',
      recipient: 'Penerima',
      amount_bsv: 'Jumlah (BSV)',
      incoming_payments: 'Pembayaran Masuk',
      no_pending_payments: 'Tidak ada pembayaran tertunda',
      valid_identity_key: 'Kunci identitas valid dimasukkan',
      searching: 'Mencari...',
      unknown: 'Tidak Diketahui',
      from_prefix: 'Dari:',
      message_box_saved: 'Server kotak pesan disimpan',
      message_box_removed: 'Server kotak pesan dihapus',
      enter_valid_url: 'Masukkan URL yang valid',
      search_name_or_key: 'Cari berdasarkan nama atau kunci identitas...',

      trust_updated: 'Jaringan kepercayaan diperbarui',
      failed_to_save: 'Gagal menyimpan',
      confirm_delete: 'Konfirmasi Hapus',
      confirm_delete_body: 'Apakah Anda yakin ingin menghapus sertifikator ini?',
      order_certifiers_hint: 'Urutkan sertifikator berdasarkan prioritas. Aplikasi akan menampilkan sertifikator berperingkat lebih tinggi terlebih dahulu.',
      certifiers: 'Sertifikator',
      no_certifiers: 'Belum ada sertifikator.',
      add_provider: 'Tambah Penyedia',
      unsaved_changes: 'Anda memiliki perubahan yang belum disimpan',
      duplicate_key_error: 'Entitas dengan kunci publik ini sudah ada di daftar!',
      get_provider_details: 'Dapatkan Detail Penyedia',
      validate_details: 'Validasi Detail',
      show_advanced: 'Tampilkan Lanjutan',
      hide_advanced: 'Sembunyikan Lanjutan',
      description_length_error: 'Deskripsi harus antara 5 dan 50 karakter',
      enter_domain_hint: 'Masukkan domain penyedia',
      enter_details_hint: 'Masukkan detail penyedia',

      generating_address: 'Membuat alamat...',
      available_balance: 'Saldo Tersedia',
      not_checked: 'Belum diperiksa',
      check_balance: 'Periksa Saldo',
      import_funds: 'Impor Dana',
      unable_to_generate_address: 'Tidak dapat membuat alamat',
      send_bsv: 'Kirim BSV',
      recipient_address: 'Alamat Penerima',
      enter_bsv_address: 'Masukkan alamat BSV',
      legacy_info: 'Pembayaran lama memungkinkan Anda mengimpor dana dari dompet BSV lama menggunakan alamat P2PKH.',

      wallet_data: 'Data Dompet',
      create_new_wallet: 'Buat Dompet Baru',
      generate_recovery_phrase_caption: 'Buat frasa pemulihan baru',
      import_existing_wallet: 'Impor Dompet yang Ada',
      paste_recovery_phrase: 'Tempel frasa pemulihan Anda',
      save_recovery_phrase_heading: 'Simpan Frasa Pemulihan Anda',
      save_recovery_phrase_btn: 'Simpan Frasa Pemulihan',
      recovery_phrase_write_down: 'Tulis 12 kata ini secara berurutan dan simpan di tempat yang aman.',
      acknowledgment_text: 'Saya telah menuliskan frasa pemulihan saya dan memahami bahwa kehilangannya berarti kehilangan akses ke dompet saya.',
      enter_recovery_words: 'Masukkan kata-kata pemulihan Anda dipisahkan dengan spasi...',
      restore_wallet_description: 'Masukkan frasa pemulihan untuk memulihkan dompet Anda',
      import_wallet: 'Impor Dompet',

      reject: 'Tolak',
      authorize: 'Otorisasi',
      renewal: 'Pembaruan',
      spending_section: 'Pengeluaran',
      protocols_section: 'Protokol',
      baskets_section: 'Keranjang',
      certificates_section: 'Sertifikat',
      requested_fields: 'Kolom yang diminta',

      send_max: 'Kirim Maksimal',
      entire_wallet_balance: 'Seluruh saldo dompet',
      export_data: 'Ekspor Data',
    }
  }
}

// Define supported languages
const supportedLanguages = ['en', 'es', 'zh', 'hi', 'fr', 'ar', 'pt', 'bn', 'ru', 'id']

// Validate and ensure we use a supported language
if (!supportedLanguages.includes(detectedLanguage)) {
  console.warn(`⚠️ Detected language "${detectedLanguage}" is not supported. Falling back to English.`)
  detectedLanguage = 'en'
}

console.log('🌍 Final language to use:', detectedLanguage)
console.log('📋 Supported languages:', supportedLanguages)

i18n
  .use(initReactI18next)
  .init({
    resources,
    lng: detectedLanguage, // Use the validated detected language
    fallbackLng: 'en',
    interpolation: {
      escapeValue: false
    }
  })
  .then(() => {
    console.log('✅ i18n initialized successfully')
    console.log('🌐 Current language set to:', i18n.language)
    console.log('📋 Available languages:', Object.keys(resources))
    console.log('🎯 Fallback language:', i18n.options.fallbackLng)

    // Test basic translation functionality
    const testKey = 'new_tab'
    const translation = i18n.t(testKey)
    console.log(`🧪 Test translation for "${testKey}":`, translation)

    if (translation === testKey) {
      console.warn('⚠️ Translation not working - returned key instead of translated text')
    } else {
      console.log('✅ Basic translation test passed')
    }
  })
  .catch(error => {
    console.error('❌ i18n initialization failed:', error)
  })

interface LanguageContextType {
  currentLanguage: string
  setCurrentLanguage: (language: string) => void
}

const LanguageContext = createContext<LanguageContextType>({
  currentLanguage: 'en',
  setCurrentLanguage: () => { }
})

interface LanguageProviderProps {
  children: ReactNode
}

export const LanguageProvider: React.FC<LanguageProviderProps> = ({ children }) => {
  const [currentLanguage, setCurrentLanguage] = useState(i18n.language)

  console.log('🔄 LanguageProvider initialized with language:', currentLanguage)

  const handleLanguageChange = (language: string) => {
    console.log('🔄 Language changing from', currentLanguage, 'to', language)
    setCurrentLanguage(language)
    i18n
      .changeLanguage(language)
      .then(() => {
        console.log('✅ Language successfully changed to:', i18n.language)
      })
      .catch(error => {
        console.error('❌ Failed to change language:', error)
      })
  }

  return (
    <LanguageContext.Provider value={{ currentLanguage, setCurrentLanguage: handleLanguageChange }}>
      {children}
    </LanguageContext.Provider>
  )
}

export const useLanguage = (): LanguageContextType => useContext(LanguageContext)

export type TranslationKey = keyof typeof resources.en.translation

export default i18n
