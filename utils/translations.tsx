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
      // Navigation
      search_placeholder: 'Search or enter site name',
      search_bookmarks: 'Search bookmarks…',
      search_results: 'Search Results',
      new_tab: 'New Tab',
      back: 'Back',
      forward: 'Forward',
      refresh: 'Refresh',
      share: 'Share',

      // Bookmarks
      bookmark: 'Bookmark',
      bookmarks: 'Bookmarks',
      add_bookmark: 'Add Bookmark',
      remove_bookmark: 'Remove Bookmark',
      delete_bookmark: 'Delete Bookmark',
      recent_bookmarks: 'Recent Bookmarks',
      no_bookmarks: 'No bookmarks yet',

      // History
      history: 'History',
      clear: 'Clear',

      clear_all: 'Clear All',

      // General UI
      untitled: 'Untitled',
      website_notification: 'Website Notification',

      // Apps & Homepage
      recent: 'Recent',
      recommended: 'Recommended',
      customize_homepage: 'Customize Homepage',
      customize_homepage_description: 'Show or hide sections on your homepage',
      show_bookmarks: 'Show Bookmarks',
      show_recent_apps: 'Show Recent Apps',
      show_recommended_apps: 'Show Recommended Apps',
      hide_app: 'Hide App',

      // Actions
      cancel: 'Cancel',
      done: 'Done',
      reset: 'Reset',
      ok: 'OK',
      yes: 'Yes',
      no: 'No',
      ask: 'Ask',
      deny: 'Deny',
      later: 'Later',

      // Navigation actions
      switch_to_mobile_view: 'Switch to Mobile View',
      switch_to_desktop_view: 'Switch to Desktop View',
      add_to_device_homescreen: 'Add to Device Homescreen',
      back_to_homepage: 'Back to Homepage',
      notifications: 'Notifications',
      permissions: 'Permissions',

      // Browser actions
      clear_browsing_history: 'Clear browsing history?',
      action_cannot_be_undone: 'This action cannot be undone.',

      // Wallet
      balance: 'Balance',
      send: 'Send',
      receive: 'Receive',
      wallet: 'Wallet',
      identity: 'Identity',

      // Identity
      manage_digital_identity: 'Manage your digital identity and credentials.',
      identity_key: 'Identity Key:',
      privileged_identity_key: 'Privileged Identity Key:',
      reveal_key: 'Reveal Key',
      wallet_manager_not_available: 'Wallet manager not available',
      failed_to_reveal_key: 'Failed to reveal key',
      privileged_reason: 'Reveal your privileged identity key alongside your everyday one.',

      // Settings
      settings: 'Settings',
      theme: 'Theme',
      currency_format: 'Currency Format',
      language: 'Language',
      appearance: 'Appearance',
      choose_theme_mode: 'Choose your preferred theme mode',
      light: 'Light',
      dark: 'Dark',
      system_default: 'System Default',
      account: 'Account',
      logout: 'Logout',
      wallet_configuration: 'Wallet Configuration',
      wallet_storage_url: 'Wallet Storage URL',
      logout_to_change_urls: 'You need to logout to change these URLs.',

      // Security
      security: 'Security',
      manage_password_recovery: 'Manage your password and recovery key.',
      change_password: 'Change Password',
      change_password_prompt: 'You will be prompted to enter your old password to confirm the change.',
      new_password: 'New password',
      retype_password: 'Retype password',
      forgot_password: 'Forgot Password?',
      forgot_password_flow: 'Forgot password flow',
      change: 'Change',
      recovery_key: 'Recovery Key',
      recovery_key_description: 'You will need your recovery key if you forget your password or lose your phone.',
      view: 'View',
      change_recovery_key: 'Change recovery key (mock)',
      password_too_short: 'Password too short',
      passwords_do_not_match: 'Passwords do not match',
      success: 'Success',
      password_changed_mock: 'Password changed (mock)',
      recovery_key_mock: '•••••••••••••• (mock)',

      // Notifications
      notification_permission: 'Notification Permission',
      allow_notifications: 'Allow notifications from this site?',
      allow: 'Allow',
      block: 'Block',
      allow_notifications_question: 'Allow notifications?',
      wants_to_send_notifications: 'wants to send you notifications',
      can_send_notifications_about: 'This site can send you notifications about:',
      breaking_news_updates: '• Breaking news and updates',
      messages_activity: '• Messages and activity',
      reminders_alerts: '• Reminders and alerts',
      change_in_settings: 'You can change this in Settings at any time.',
      requesting: 'Requesting...',

      // Errors
      error_loading_page: 'Error loading page',
      no_internet: 'No internet connection',
      invalid_url: 'Invalid URL',
      something_went_wrong: 'Something went wrong',
      error: 'Error',
      configuration_error: 'Configuration Error',
      could_not_fetch_wallet_config: 'Could not fetch wallet configuration:',
      failed_to_save_config: 'Failed to save configuration. Please try again.',

      // Configuration
      configuration: 'Configuration',
      save: 'Save',
      wallet_auth_backend: 'Wallet Authentication Backend (WAB)',
      wab_description: 'Provides 2 of 3 backup and recovery functionality for your root key.',
      wab_url: 'WAB URL',
      enter_wab_url: 'Enter WAB URL',
      refresh_info: 'Refresh Info',
      phone_verification_service: 'Service which will be used to verify your phone number',
      bsv_network: 'BSV Network',
      wallet_storage_provider: 'Wallet Storage Provider',
      storage_description: 'Used for your transactions and metadata storage.',
      storage_url: 'Storage URL',
      enter_storage_url: 'Enter Storage URL',
      quick_pick: 'Quick Pick',
      manual_config: 'Manual',
      loading_wallet_providers: 'Loading wallet providers...',
      select_wallet_provider_description: 'Select a wallet provider from the list below:',
      retry: 'Retry',

      // States
      loading: 'Loading...',
      no_results: 'No results found',
      empty: 'Empty',

      // Units
      satoshis: 'satoshis',
      sats: 'sats',

      // Trust
      trust_network: 'Trust Network',
      trusted_origins: 'Trusted Origins',
      manage_trust_relationships: 'Manage your trust relationships and certifier network.',
      search_trusted_origins: 'Search trusted origins…',
      no_trusted_origins: 'No trusted origins yet.',
      trusted: 'Trusted',

      // Auth - Password
      enter_password: 'Enter Password',
      enter_password_subtitle: 'Please enter your password to access your wallet',
      enter_password_continue: 'Please enter your password to continue',
      password: 'Password',
      password_min_chars: 'Password must be at least 6 characters',
      continue: 'Continue',
      forgot_password_link: 'Forgot password?',
      auth_failed_maybe_password: 'Authentication failed, maybe password is incorrect?',
      auth_failed_try_again: 'Authentication failed. Please try again.',

      // Auth - Phone
      enter_phone_number: 'Enter your phone number',
      send_verification_code: "We'll send you a verification code",
      phone_number: 'Phone number',
      select_country: 'Select Country',
      terms_privacy_agree: 'By continuing, you agree to our Terms of Service and Privacy Policy',

      continue_without_login: 'Continue without login',

      // Auth - OTP
      verification_code: 'Verification Code',
      enter_6_digit_code: 'Enter the 6-digit code sent to',
      didnt_receive_code: "Didn't receive the code?",
      resend_code: 'Resend Code',
      resend_in: 'Resend in',
      change_phone_number: 'Change Phone Number',
      verification_failed: 'Verification Failed',
      code_incorrect_try_again: 'The code you entered is incorrect. Please try again.',
      code_sent: 'Code Sent',
      new_verification_code_sent: 'A new verification code has been sent to your phone.',
      failed_to_resend: 'Failed to resend verification code. Please try again.',
      failed_resend_code: 'Failed to resend verification code. Please try again.',

      // Login/Welcome Screen
      metanet: 'BSV Browser',
      browser_with_identity_payments: 'With identity and payments built in',
      get_started: 'Get Started',
      terms_privacy_agreement: 'By continuing, you agree to our Terms of Service and Privacy Policy',

      configure_providers: 'Configure Providers',

      // Web3 Benefits Modal
      web3_benefits_title: 'Are you sure?',
      web3_benefits_description: 'The benefits of web3 are as follows:',
      web3_benefit_never_login: 'Never login again',
      web3_benefit_never_login_desc: 'One identity for every Web3 app. No more passwords or sign-ups.',
      web3_benefit_instant: 'Instant everything',
      web3_benefit_instant_desc: 'Payments, access, verification - all happen in seconds.',
      web3_benefit_own_data: 'You own your data',
      web3_benefit_own_data_desc: 'No companies tracking you or selling your information.',
      web3_benefit_works_everywhere: 'Works everywhere',
      web3_benefit_works_everywhere_desc: 'Access thousands of Web3 apps with the same identity.',
      web3_benefit_future_proof: 'Future-proof',
      web3_benefit_future_proof_desc: 'Be early to the next generation of the internet.',
      web3_benefits_get_identity: '🚀 Get My Web3 Identity (30s)',
      web3_benefits_maybe_later: 'Maybe later'
    }
  },
  zh: {
    translation: {
      // Navigation
      search_placeholder: '搜索或输入网站名称',
      search_bookmarks: '搜索书签…',
      search_results: '搜索结果',
      new_tab: '新标签页',
      back: '后退',
      forward: '前进',
      refresh: '刷新',
      share: '分享',

      // Bookmarks
      bookmark: '书签',
      bookmarks: '书签',
      add_bookmark: '添加书签',
      remove_bookmark: '移除书签',
      delete_bookmark: '删除书签',
      recent_bookmarks: '最近书签',
      no_bookmarks: '暂无书签',

      // History
      history: '历史记录',
      clear: '清除',

      clear_all: '全部清除',

      // General UI
      untitled: '无标题',
      website_notification: '网站通知',

      // Apps & Homepage
      recent: '最近',
      recommended: '推荐',
      customize_homepage: '自定义主页',
      customize_homepage_description: '显示或隐藏主页上的部分',
      show_bookmarks: '显示书签',
      show_recent_apps: '显示最近应用',
      show_recommended_apps: '显示推荐应用',
      hide_app: '隐藏应用',

      // Actions
      cancel: '取消',
      done: '完成',
      reset: '重置',
      ok: '确定',
      yes: '是',
      no: '否',
      ask: '询问',
      deny: '拒绝',
      later: '稍后',

      // Navigation actions
      switch_to_mobile_view: '切换到移动视图',
      switch_to_desktop_view: '切换到桌面视图',
      add_to_device_homescreen: '添加到设备主屏幕',
      back_to_homepage: '返回主页',
      notifications: '通知',
      permissions: '权限',

      // Browser actions
      clear_browsing_history: '清除浏览历史记录？',
      action_cannot_be_undone: '此操作无法撤销。',

      // Wallet
      balance: '余额',
      send: '发送',
      receive: '接收',
      wallet: '钱包',
      identity: '身份',

      // Identity
      manage_digital_identity: '管理您的数字身份和凭证。',
      identity_key: '身份密钥：',
      privileged_identity_key: '特权身份密钥：',
      reveal_key: '显示密钥',
      wallet_manager_not_available: '钱包管理器不可用',
      failed_to_reveal_key: '显示密钥失败',
      privileged_reason: '显示您的特权身份密钥和日常密钥。',

      // Settings
      settings: '设置',
      theme: '主题',
      currency_format: '货币格式',
      language: '语言',
      appearance: '外观',
      choose_theme_mode: '选择您喜欢的主题模式',
      light: '浅色',
      dark: '深色',
      system_default: '系统默认',
      account: '账户',
      logout: '退出登录',
      wallet_configuration: '钱包配置',
      wallet_storage_url: '钱包存储URL',
      logout_to_change_urls: '您需要退出登录以更改这些URL。',

      // Security
      security: '安全',
      manage_password_recovery: '管理您的密码和恢复密钥。',
      change_password: '更改密码',
      change_password_prompt: '您将被提示输入旧密码以确认更改。',
      new_password: '新密码',
      retype_password: '重新输入密码',
      forgot_password: '忘记密码？',
      forgot_password_flow: '忘记密码流程',
      change: '更改',
      recovery_key: '恢复密钥',
      recovery_key_description: '如果您忘记密码或丢失手机，您将需要恢复密钥。',
      view: '查看',
      change_recovery_key: '更改恢复密钥（模拟）',
      password_too_short: '密码太短',
      passwords_do_not_match: '密码不匹配',
      success: '成功',
      password_changed_mock: '密码已更改（模拟）',
      recovery_key_mock: '•••••••••••••• （模拟）',

      // Notifications
      notification_permission: '通知权限',
      allow_notifications: '允许此网站发送通知？',
      allow: '允许',
      block: '阻止',
      allow_notifications_question: '允许通知？',
      wants_to_send_notifications: '想要向您发送通知',
      can_send_notifications_about: '此网站可以向您发送以下通知：',
      breaking_news_updates: '• 突发新闻和更新',
      messages_activity: '• 消息和活动',
      reminders_alerts: '• 提醒和警报',
      change_in_settings: '您可以随时在设置中更改此选项。',
      requesting: '请求中...',

      // Errors
      error_loading_page: '页面加载错误',
      no_internet: '无网络连接',
      invalid_url: '无效网址',
      something_went_wrong: '出现错误',
      error: '错误',
      configuration_error: '配置错误',
      could_not_fetch_wallet_config: '无法获取钱包配置：',
      failed_to_save_config: '保存配置失败。请重试。',

      // Configuration
      configuration: '配置',
      save: '保存',
      wallet_auth_backend: '钱包身份验证后端 (WAB)',
      wab_description: '为您的根密钥提供2/3备份和恢复功能。',
      wab_url: 'WAB URL',
      enter_wab_url: '输入 WAB URL',
      refresh_info: '刷新信息',
      phone_verification_service: '将用于验证您电话号码的服务',
      bsv_network: 'BSV 网络',
      wallet_storage_provider: '钱包存储提供商',
      storage_description: '用于您的交易和元数据存储。',
      storage_url: '存储 URL',
      enter_storage_url: '输入存储 URL',

      // States
      loading: '加载中...',
      no_results: '未找到结果',
      empty: '空',

      // Units
      satoshis: 'satoshis',
      sats: 'sats',

      // Trust
      trust_network: '信任网络',
      trusted_origins: '可信来源',
      manage_trust_relationships: '管理您的信任关系和认证网络。',
      search_trusted_origins: '搜索可信来源…',
      no_trusted_origins: '暂无可信来源。',
      trusted: '可信',

      // Auth - Password
      enter_password: '输入密码',
      enter_password_subtitle: '请输入您的密码以访问您的钱包',
      enter_password_continue: '请输入您的密码以继续',
      password: '密码',
      password_min_chars: '密码必须至少6个字符',
      continue: '继续',
      forgot_password_link: '忘记密码？',
      auth_failed_maybe_password: '验证失败，可能密码不正确？',
      auth_failed_try_again: '验证失败。请重试。',

      // Auth - Phone
      enter_phone_number: '输入您的电话号码',
      send_verification_code: '我们将向您发送验证码',
      phone_number: '电话号码',
      select_country: '选择国家',
      terms_privacy_agree: '继续即表示您同意我们的服务条款和隐私政策',

      continue_without_login: '不登录继续',

      // Auth - OTP
      verification_code: '验证码',
      enter_6_digit_code: '输入发送到以下号码的6位数字代码',
      didnt_receive_code: "没有收到验证码？",
      resend_code: '重新发送验证码',
      resend_in: '重新发送时间',
      change_phone_number: '更改电话号码',
      verification_failed: '验证失败',
      code_incorrect_try_again: '您输入的验证码不正确。请重试。',
      code_sent: '验证码已发送',
      new_verification_code_sent: '新的验证码已发送到您的手机。',
      failed_to_resend: '重新发送验证码失败。请重试。',
      failed_resend_code: '重新发送验证码失败。请重试。',

      // Login/Welcome Screen
      metanet: 'BSV Browser',
      browser_with_identity_payments: '内置身份和支付功能的浏览器',
      get_started: '开始使用',
      terms_privacy_agreement: '继续即表示您同意我们的服务条款和隐私政策',

      configure_providers: '配置提供商',

      // Web3 Benefits Modal
      web3_benefits_title: '您确定吗？',
      web3_benefits_description: 'Web3的好处如下：',
      web3_benefit_never_login: '永远不再登录',
      web3_benefit_never_login_desc: '为每个Web3应用程序提供一个身份。不再需要密码或注册。',
      web3_benefit_instant: '即时一切',
      web3_benefit_instant_desc: '支付、访问、验证 - 所有操作都在几秒钟内完成。',
      web3_benefit_own_data: '您拥有自己的数据',
      web3_benefit_own_data_desc: '没有公司跟踪您或出售您的信息。',
      web3_benefit_works_everywhere: '随处可用',
      web3_benefit_works_everywhere_desc: '使用相同身份访问数千个Web3应用程序。',
      web3_benefit_future_proof: '面向未来',
      web3_benefit_future_proof_desc: '成为下一代互联网的早期用户。',
      web3_benefits_get_identity: '🚀 获取我的Web3身份（30秒）',
      web3_benefits_maybe_later: '稍后再说'
    }
  },
  hi: {
    translation: {
      // Navigation
      search_placeholder: 'खोजें या साइट का नाम दर्ज करें',
      search_bookmarks: 'बुकमार्क खोजें…',
      search_results: 'खोज परिणाम',
      new_tab: 'नया टैब',
      back: 'पीछे',
      forward: 'आगे',
      refresh: 'ताज़ा करें',
      share: 'साझा करें',

      // Bookmarks
      bookmark: 'बुकमार्क',
      bookmarks: 'बुकमार्क',
      add_bookmark: 'बुकमार्क जोड़ें',
      remove_bookmark: 'बुकमार्क हटाएं',
      delete_bookmark: 'बुकमार्क मिटाएं',
      recent_bookmarks: 'हाल के बुकमार्क',
      no_bookmarks: 'अभी तक कोई बुकमार्क नहीं',

      // History
      history: 'इतिहास',
      clear: 'साफ़ करें',

      clear_all: 'सभी साफ़ करें',

      // General UI
      untitled: 'बिना शीर्षक',
      website_notification: 'वेबसाइट सूचना',

      // Apps & Homepage
      recent: 'हाल ही में',
      recommended: 'अनुशंसित',
      customize_homepage: 'होमपेज को अनुकूलित करें',
      customize_homepage_description: 'अपने होमपेज पर सेक्शन दिखाएं या छुपाएं',
      show_bookmarks: 'बुकमार्क दिखाएं',
      show_recent_apps: 'हाल के ऐप्स दिखाएं',
      show_recommended_apps: 'अनुशंसित ऐप्स दिखाएं',
      hide_app: 'ऐप छुपाएं',

      // Actions
      cancel: 'रद्द करें',
      done: 'हो गया',
      reset: 'रीसेट करें',
      ok: 'ठीक है',
      yes: 'हाँ',
      no: 'नहीं',
      ask: 'पूछें',
      deny: 'अस्वीकार',
      later: 'बाद में',

      // Navigation actions
      switch_to_mobile_view: 'मोबाइल दृश्य पर स्विच करें',
      switch_to_desktop_view: 'डेस्कटॉप दृश्य पर स्विच करें',
      add_to_device_homescreen: 'डिवाइस होमस्क्रीन पर जोड़ें',
      back_to_homepage: 'होमपेज पर वापस',
      notifications: 'सूचनाएं',
      permissions: 'अनुमतियाँ',

      // Browser actions
      clear_browsing_history: 'ब्राउज़िंग इतिहास साफ़ करें?',
      action_cannot_be_undone: 'यह क्रिया पूर्ववत नहीं की जा सकती।',

      // Wallet
      balance: 'शेष राशि',
      send: 'भेजें',
      receive: 'प्राप्त करें',
      wallet: 'वॉलेट',
      identity: 'पहचान',

      // Identity
      manage_digital_identity: 'अपनी डिजिटल पहचान और प्रमाण पत्र प्रबंधित करें।',
      identity_key: 'पहचान कुंजी:',
      privileged_identity_key: 'विशेषाधिकार प्राप्त पहचान कुंजी:',
      reveal_key: 'कुंजी प्रकट करें',
      wallet_manager_not_available: 'वॉलेट प्रबंधक उपलब्ध नहीं',
      failed_to_reveal_key: 'कुंजी प्रकट करने में विफल',
      privileged_reason: 'अपनी रोजमर्रा की कुंजी के साथ अपनी विशेषाधिकार प्राप्त पहचान कुंजी प्रकट करें।',

      // Settings
      settings: 'सेटिंग्स',
      theme: 'थीम',
      currency_format: 'मुद्रा प्रारूप',
      language: 'भाषा',
      appearance: 'दृश्य',
      choose_theme_mode: 'अपने पसंदीदा थीम मोड का चयन करें',
      light: 'हल्का',
      dark: 'गहरा',
      system_default: 'सिस्टम डिफ़ॉल्ट',
      account: 'खाता',
      logout: 'लॉगआउट',
      wallet_configuration: 'वॉलेट कॉन्फ़िगरेशन',
      wallet_storage_url: 'वॉलेट स्टोरेज URL',
      logout_to_change_urls: 'इन URLs को बदलने के लिए आपको लॉगआउट करना होगा।',

      // Security
      security: 'सुरक्षा',
      manage_password_recovery: 'अपने पासवर्ड और पुनर्प्राप्ति कुंजी का प्रबंधन करें।',
      change_password: 'पासवर्ड बदलें',
      change_password_prompt: 'आपको परिवर्तन की पुष्टि करने के लिए अपना पुराना पासवर्ड दर्ज करने के लिए कहा जाएगा।',
      new_password: 'नया पासवर्ड',
      retype_password: 'पासवर्ड फिर से टाइप करें',
      forgot_password: 'पासवर्ड भूल गए?',
      forgot_password_flow: 'पासवर्ड भूल गए प्रक्रिया',
      change: 'बदलें',
      recovery_key: 'पुनर्प्राप्ति कुंजी',
      recovery_key_description:
        'यदि आप अपना पासवर्ड भूल जाते हैं या अपना फोन खो देते हैं, तो आपको पुनर्प्राप्ति कुंजी की आवश्यकता होगी।',
      view: 'देखें',
      change_recovery_key: 'पुनर्प्राप्ति कुंजी बदलें (नकली)',
      password_too_short: 'पासवर्ड बहुत छोटा है',
      passwords_do_not_match: 'पासवर्ड मेल नहीं खाते',
      success: 'सफलता',
      password_changed_mock: 'पासवर्ड बदल गया (नकली)',
      recovery_key_mock: '•••••••••••••• (नकली)',

      // Notifications
      notification_permission: 'सूचना अनुमति',
      allow_notifications: 'क्या इस साइट से सूचनाएँ अनुमति दें?',
      allow: 'अनुमति दें',
      block: 'ब्लॉक करें',
      allow_notifications_question: 'क्या सूचनाएँ अनुमति दें?',
      wants_to_send_notifications: 'आपको सूचनाएँ भेजना चाहता है',
      can_send_notifications_about: 'यह साइट आपको निम्नलिखित के बारे में सूचनाएँ भेज सकती है:',
      breaking_news_updates: '• ब्रेकिंग न्यूज और अपडेट',
      messages_activity: '• संदेश और गतिविधि',
      reminders_alerts: '• अनुस्मारक और अलर्ट',
      change_in_settings: 'आप कभी भी सेटिंग्स में इसे बदल सकते हैं।',
      requesting: 'अनुरोध कर रहा है...',

      // Errors
      error_loading_page: 'पृष्ठ लोड करने में त्रुटि',
      no_internet: 'इंटरनेट कनेक्शन नहीं',
      invalid_url: 'अमान्य URL',
      something_went_wrong: 'कुछ गलत हुआ',
      error: 'त्रुटि',
      configuration_error: 'कॉन्फ़िगरेशन त्रुटि',
      could_not_fetch_wallet_config: 'वॉलेट कॉन्फ़िगरेशन प्राप्त करने में असफल:',
      failed_to_save_config: 'कॉन्फ़िगरेशन सहेजने में विफल। कृपया फिर से प्रयास करें।',

      // Configuration
      configuration: 'कॉन्फ़िगरेशन',
      save: 'सहेजें',
      wallet_auth_backend: 'वॉलेट प्रमाणीकरण बैकएंड (WAB)',
      wab_description: 'आपकी रूट कुंजी के लिए 2/3 बैकअप और पुनर्प्राप्ति कार्यक्षमता प्रदान करता है।',
      wab_url: 'WAB URL',
      enter_wab_url: 'WAB URL दर्ज करें',
      refresh_info: 'जानकारी ताज़ा करें',
      phone_verification_service: 'सेवा जिसका उपयोग आपके फोन नंबर की पुष्टि के लिए किया जाएगा',
      bsv_network: 'BSV नेटवर्क',
      wallet_storage_provider: 'वॉलेट स्टोरेज प्रदाता',
      storage_description: 'आपके लेनदेन और मेटाडेटा स्टोरेज के लिए उपयोग किया जाता है।',
      storage_url: 'स्टोरेज URL',
      enter_storage_url: 'स्टोरेज URL दर्ज करें',

      // States
      loading: 'लोड हो रहा है...',
      no_results: 'कोई परिणाम नहीं मिला',
      empty: 'खाली',

      // Units
      satoshis: 'सातोशी',
      sats: 'सैट्स',

      // Trust
      trust_network: 'विश्वास नेटवर्क',
      trusted_origins: 'विश्वसनीय स्रोत',
      manage_trust_relationships: 'अपने विश्वास संबंधों और प्रमाणक नेटवर्क का प्रबंधन करें।',
      search_trusted_origins: 'विश्वसनीय स्रोत खोजें…',
      no_trusted_origins: 'अभी तक कोई विश्वसनीय स्रोत नहीं।',
      trusted: 'विश्वसनीय',

      // Auth - Password
      enter_password: 'पासवर्ड दर्ज करें',
      enter_password_subtitle: 'अपने वॉलेट तक पहुंचने के लिए कृपया अपना पासवर्ड दर्ज करें',
      enter_password_continue: 'कृपया जारी रखने के लिए अपना पासवर्ड दर्ज करें',
      password: 'पासवर्ड',
      password_min_chars: 'पासवर्ड कम से कम 6 अक्षर का होना चाहिए',
      continue: 'जारी रखें',
      forgot_password_link: 'पासवर्ड भूल गए?',
      auth_failed_maybe_password: 'प्रमाणीकरण विफल, शायद पासवर्ड गलत है?',
      auth_failed_try_again: 'प्रमाणीकरण विफल। कृपया पुनः प्रयास करें।',

      // Auth - OTP
      enter_verification_code: 'सत्यापन कोड दर्ज करें',
      enter_6_digit_code: 'अपने फोन पर भेजा गया 6-अंकीय कोड दर्ज करें',
      verify: 'सत्यापित करें',
      resend_code: 'कोड पुनः भेजें',
      invalid_code: 'अमान्य कोड',

      // Auth - Phone
      enter_phone_number: 'फोन नंबर दर्ज करें',
      phone_number_required: 'जारी रखने के लिए फोन नंबर आवश्यक है',
      phone_number: 'फोन नंबर',
      send_verification_code: 'सत्यापन कोड भेजें',
      invalid_phone_number: 'अमान्य फोन नंबर',

      select_country: 'देश चुनें',
      terms_privacy_agree: 'जारी रखकर, आप हमारी सेवा की शर्तों और गोपनीयता नीति से सहमत हैं',
      continue_without_login: 'बिना लॉगिन के जारी रखें',

      // Login/Welcome Screen
      metanet: 'BSV Browser',
      browser_with_identity_payments: 'पहचान और भुगतान सुविधा के साथ ब्राउज़र',
      get_started: 'शुरू करें',
      terms_privacy_agreement: 'जारी रखकर, आप हमारी सेवा की शर्तों और गोपनीयता नीति से सहमत हैं',

      configure_providers: 'प्रदाता कॉन्फ़िगर करें',

      // Web3 Benefits Modal
      web3_benefits_title: 'क्या आप वाकई चाहते हैं?',
      web3_benefits_description: 'Web3 के फायदे निम्नलिखित हैं:',
      web3_benefit_never_login: 'फिर कभी लॉगिन न करें',
      web3_benefit_never_login_desc: 'हर Web3 ऐप के लिए एक पहचान। कोई और पासवर्ड या साइन-अप नहीं।',
      web3_benefit_instant: 'सब कुछ तुरंत',
      web3_benefit_instant_desc: 'भुगतान, पहुंच, सत्यापन - सब कुछ सेकंड में होता है।',
      web3_benefit_own_data: 'आपका डेटा आपका है',
      web3_benefit_own_data_desc: 'कोई कंपनी आपको ट्रैक नहीं करती या आपकी जानकारी बेचती नहीं।',
      web3_benefit_works_everywhere: 'हर जगह काम करता है',
      web3_benefit_works_everywhere_desc: 'एक ही पहचान के साथ हजारों Web3 ऐप्स तक पहुंच।',
      web3_benefit_future_proof: 'भविष्य के लिए तैयार',
      web3_benefit_future_proof_desc: 'इंटरनेट की अगली पीढ़ी के लिए जल्दी तैयार हो जाएं।',
      web3_benefits_get_identity: '🚀 मेरी Web3 पहचान प्राप्त करें (30 सेकंड)',
      web3_benefits_maybe_later: 'बाद में शायद'
    }
  },
  es: {
    translation: {
      // Navigation
      search_placeholder: 'Buscar o ingresar nombre del sitio',
      search_bookmarks: 'Buscar marcadores…',
      search_results: 'Resultados de Búsqueda',
      new_tab: 'Nueva Pestaña',
      back: 'Atrás',
      forward: 'Adelante',
      refresh: 'Actualizar',
      share: 'Compartir',

      // Bookmarks
      bookmark: 'Marcador',
      bookmarks: 'Marcadores',
      add_bookmark: 'Agregar Marcador',
      remove_bookmark: 'Eliminar Marcador',
      delete_bookmark: 'Eliminar Marcador',
      recent_bookmarks: 'Marcadores Recientes',
      no_bookmarks: 'No hay marcadores aún',

      // History
      history: 'Historial',
      clear: 'Limpiar',

      clear_all: 'Limpiar Todo',

      // General UI
      untitled: 'Sin título',
      website_notification: 'Notificación del sitio web',

      // Apps & Homepage
      recent: 'Reciente',
      recommended: 'Recomendado',
      customize_homepage: 'Personalizar Página Inicial',
      customize_homepage_description: 'Mostrar u ocultar secciones en tu página inicial',
      show_bookmarks: 'Mostrar Marcadores',
      show_recent_apps: 'Mostrar Apps Recientes',
      show_recommended_apps: 'Mostrar Apps Recomendados',
      hide_app: 'Ocultar App',

      // Actions
      cancel: 'Cancelar',
      done: 'Hecho',
      reset: 'Restablecer',
      ok: 'OK',
      yes: 'Sí',
      no: 'No',
      ask: 'Preguntar',
      deny: 'Denegar',
      later: 'Más tarde',

      // Navigation actions
      switch_to_mobile_view: 'Cambiar a Visualización Móvil',
      switch_to_desktop_view: 'Cambiar a Visualización Desktop',
      add_to_device_homescreen: 'Agregar a Pantalla de Inicio',
      back_to_homepage: 'Volver al Inicio',
      notifications: 'Notificaciones',
      permissions: 'Permisos',

      // Browser actions
      clear_browsing_history: '¿Limpiar historial de navegación?',
      action_cannot_be_undone: 'Esta acción no se puede deshacer.',

      // Wallet
      balance: 'Saldo',
      send: 'Enviar',
      receive: 'Recibir',
      wallet: 'Billetera',
      identity: 'Identidad',

      // Settings
      settings: 'Configuración',
      theme: 'Tema',
      currency_format: 'Formato de Moneda',
      language: 'Idioma',
      appearance: 'Apariencia',
      choose_theme_mode: 'Elige tu modo de tema preferido',
      light: 'Claro',
      dark: 'Oscuro',
      system_default: 'Predeterminado del sistema',
      account: 'Cuenta',
      logout: 'Cerrar sesión',

      // Notifications
      notification_permission: 'Permiso de Notificación',
      allow_notifications: '¿Permitir notificaciones de este sitio?',
      allow: 'Permitir',
      block: 'Bloquear',

      // Errors
      error_loading_page: 'Error al cargar página',
      no_internet: 'Sin conexión a internet',
      invalid_url: 'URL inválida',
      something_went_wrong: 'Algo salió mal',

      // States
      loading: 'Cargando...',
      no_results: 'Nenhum resultado encontrado',
      empty: 'Vacío',

      // Units
      satoshis: 'satoshis',
      sats: 'sats',

      // Trust
      trust_network: 'Red de Confianza',

      // Security
      security: 'Seguridad',
      manage_password_recovery: 'Gestiona tu contraseña y clave de recuperación.',
      change_password: 'Cambiar Contraseña',
      change_password_prompt: 'Se te pedirá que ingreses tu contraseña anterior para confirmar el cambio.',
      new_password: 'Nueva contraseña',
      retype_password: 'Vuelve a escribir la contraseña',
      forgot_password: '¿Olvidaste tu Contraseña?',
      forgot_password_flow: 'Flujo de contraseña olvidada',
      change: 'Cambiar',
      recovery_key: 'Clave de Recuperación',
      recovery_key_description: 'Necesitarás tu clave de recuperación si olvidas tu contraseña o pierdes tu teléfono.',
      view: 'Ver',
      change_recovery_key: 'Cambiar clave de recuperación (simulado)',
      password_too_short: 'Contraseña muy corta',
      passwords_do_not_match: 'Las contraseñas no coinciden',
      success: 'Éxito',
      password_changed_mock: 'Contraseña cambiada (simulado)',
      recovery_key_mock: '•••••••••••••• (simulado)',

      // Auth - Password
      enter_password: 'Ingresa tu Contraseña',
      enter_password_subtitle: 'Por favor ingresa tu contraseña para acceder a tu billetera',
      enter_password_continue: 'Por favor ingresa tu contraseña para continuar',
      password: 'Contraseña',
      password_min_chars: 'La contraseña debe tener al menos 6 caracteres',
      continue: 'Continuar',
      forgot_password_link: '¿Olvidaste tu contraseña?',
      auth_failed_maybe_password: 'La autenticación falló, ¿quizás la contraseña es incorrecta?',
      auth_failed_try_again: 'La autenticación falló. Por favor, inténtalo de nuevo.',

      // Auth - Phone
      enter_phone_number: 'Ingresa tu número de teléfono',
      send_verification_code: 'Te enviaremos un código de verificación',
      phone_number: 'Número de teléfono',
      select_country: 'Seleccionar País',
      terms_privacy_agree: 'Al continuar, aceptas nuestros Términos de Servicio y Política de Privacidad',
      continue_without_login: 'Continuar sin iniciar sesión',

      // Login/Welcome Screen
      metanet: 'BSV Browser',
      browser_with_identity_payments: 'Navegador con identidad y pagos integrados',
      get_started: 'Comenzar',
      terms_privacy_agreement: 'Al continuar, aceptas nuestros Términos de Servicio y Política de Privacidad',

      configure_providers: 'Configurar Proveedores',

      // Web3 Benefits Modal
      web3_benefits_title: '¿Estás seguro?',
      web3_benefits_description: 'Los beneficios de web3 son los siguientes:',
      web3_benefit_never_login: 'Nunca más iniciar sesión',
      web3_benefit_never_login_desc: 'Una identidad para cada aplicación Web3. No más contraseñas o registros.',
      web3_benefit_instant: 'Todo instantáneo',
      web3_benefit_instant_desc: 'Pagos, acceso, verificación - todo sucede en segundos.',
      web3_benefit_own_data: 'Tus datos son tuyos',
      web3_benefit_own_data_desc: 'Ninguna empresa te rastrea o vende tu información.',
      web3_benefit_works_everywhere: 'Funciona en todas partes',
      web3_benefit_works_everywhere_desc: 'Accede a miles de aplicaciones Web3 con la misma identidad.',
      web3_benefit_future_proof: 'A prueba de futuro',
      web3_benefit_future_proof_desc: 'Sé temprano en la próxima generación de internet.',
      web3_benefits_get_identity: '🚀 Obtener Mi Identidad Web3 (30s)',
      web3_benefits_maybe_later: 'Tal vez más tarde'
    }
  },
  fr: {
    translation: {
      // Navigation
      search_placeholder: 'Rechercher ou saisir le nom du site',
      search_bookmarks: 'Rechercher dans les signets…',
      search_results: 'Résultats de Recherche',
      new_tab: 'Nouvel Onglet',
      back: 'Retour',
      forward: 'Suivant',
      refresh: 'Actualiser',
      share: 'Partager',

      // Bookmarks
      bookmark: 'Signet',
      bookmarks: 'Signets',
      add_bookmark: 'Ajouter un Signet',
      remove_bookmark: 'Supprimer le Signet',
      delete_bookmark: 'Effacer le Signet',
      recent_bookmarks: 'Signets Récents',
      no_bookmarks: 'Aucun signet pour le moment',

      // History
      history: 'Historique',
      clear: 'Effacer',

      clear_all: 'Tout Effacer',

      // General UI
      untitled: 'Sans titre',
      website_notification: 'Notification du site web',

      // Apps & Homepage
      recent: 'Récent',
      recommended: 'Recommandé',
      customize_homepage: "Personnaliser la Page d'Accueil",
      customize_homepage_description: "Afficher ou masquer les sections sur votre page d'accueil",
      show_bookmarks: 'Afficher les Signets',
      show_recent_apps: 'Afficher les Apps Récentes',
      show_recommended_apps: 'Afficher les Apps Recommandées',
      hide_app: "Masquer l'App",

      // Actions
      cancel: 'Annuler',
      done: 'Terminé',
      reset: 'Réinitialiser',
      ok: 'OK',
      yes: 'Oui',
      no: 'Non',
      ask: 'Demander',
      deny: 'Refuser',
      later: 'Plus tard',

      // Navigation actions
      switch_to_mobile_view: 'Passer à la Vue Mobile',
      switch_to_desktop_view: 'Passer à la Vue de Bureau',
      add_to_device_homescreen: "Ajouter à l'Écran d'Accueil",
      back_to_homepage: "Retour à la Page d'Accueil",
      notifications: 'Notifications',
      permissions: 'Autorisations',

      // Browser actions
      clear_browsing_history: "Effacer l'historique de navigation ?",
      action_cannot_be_undone: 'Cette action ne peut pas être annulée.',

      // Wallet
      balance: 'Solde',
      send: 'Envoyer',
      receive: 'Recevoir',
      wallet: 'Portefeuille',
      identity: 'Identité',

      // Settings
      settings: 'Paramètres',
      theme: 'Thème',
      currency_format: 'Format de Devise',
      language: 'Langue',
      appearance: 'Apparence',
      choose_theme_mode: 'Choisissez votre mode de thème préféré',
      light: 'Clair',
      dark: 'Sombre',
      system_default: 'Par défaut du système',
      account: 'Compte',
      logout: 'Déconnexion',

      // Notifications
      notification_permission: 'Autorisation de Notification',
      allow_notifications: 'Autoriser les notifications de ce site ?',
      allow: 'Autoriser',
      block: 'Bloquer',

      // Errors
      error_loading_page: 'Erreur de chargement de la page',
      no_internet: 'Pas de connexion internet',
      invalid_url: 'URL invalide',
      something_went_wrong: "Une erreur s'est produite",

      // States
      loading: 'Chargement...',
      no_results: 'Aucun résultat trouvé',
      empty: 'Vide',

      // Units
      satoshis: 'satoshis',
      sats: 'sats',

      // Trust
      trust_network: 'Réseau de Confiance',
      trusted_origins: 'Origines de Confiance',
      manage_trust_relationships: 'Gérez vos relations de confiance et votre réseau de certificateurs.',
      search_trusted_origins: 'Rechercher les origines de confiance…',
      no_trusted_origins: 'Aucune origine de confiance pour le moment.',
      trusted: 'Approuvé',

      // Security
      security: 'Sécurité',
      manage_password_recovery: 'Gérez votre mot de passe et votre clé de récupération.',
      change_password: 'Changer le Mot de Passe',
      change_password_prompt: 'Il vous sera demandé de saisir votre ancien mot de passe pour confirmer le changement.',
      new_password: 'Nouveau mot de passe',
      retype_password: 'Retapez le mot de passe',
      forgot_password: 'Mot de Passe Oublié ?',
      forgot_password_flow: 'Flux de mot de passe oublié',
      change: 'Changer',
      recovery_key: 'Clé de Récupération',
      recovery_key_description:
        'Vous aurez besoin de votre clé de récupération si vous oubliez votre mot de passe ou perdez votre téléphone.',
      view: 'Voir',
      change_recovery_key: 'Changer la clé de récupération (simulé)',
      password_too_short: 'Mot de passe trop court',
      passwords_do_not_match: 'Les mots de passe ne correspondent pas',
      success: 'Succès',
      password_changed_mock: 'Mot de passe changé (simulé)',
      recovery_key_mock: '•••••••••••••• (simulé)',

      // Auth - Password
      enter_password: 'Entrer le Mot de Passe',
      enter_password_subtitle: 'Veuillez entrer votre mot de passe pour accéder à votre portefeuille',
      enter_password_continue: 'Veuillez entrer votre mot de passe pour continuer',
      password: 'Mot de Passe',
      password_min_chars: 'Le mot de passe doit contenir au moins 6 caractères',
      continue: 'Continuer',
      forgot_password_link: 'Mot de passe oublié ?',
      auth_failed_maybe_password: "Échec de l'authentification, le mot de passe est peut-être incorrect ?",
      auth_failed_try_again: "Échec de l'authentification. Veuillez réessayer.",

      // Auth - OTP
      enter_verification_code: 'Entrer le Code de Vérification',
      enter_6_digit_code: 'Entrez le code à 6 chiffres envoyé à votre téléphone',
      verify: 'Vérifier',
      resend_code: 'Renvoyer le code',
      invalid_code: 'Code invalide',

      // Auth - Phone
      enter_phone_number: 'Entrer le Numéro de Téléphone',
      phone_number_required: 'Un numéro de téléphone est requis pour continuer',
      phone_number: 'Numéro de Téléphone',
      send_verification_code: 'Envoyer le Code de Vérification',
      invalid_phone_number: 'Numéro de téléphone invalide',
      select_country: 'Sélectionner le Pays',
      terms_privacy_agree:
        'En continuant, vous acceptez nos Conditions de Service et notre Politique de Confidentialité',
      continue_without_login: 'Continuer sans se connecter',

      // Login/Welcome Screen
      metanet: 'BSV Browser',
      browser_with_identity_payments: 'Navigateur avec identité et paiements intégrés',
      get_started: 'Commencer',

      terms_privacy_agreement:
        'En continuant, vous acceptez nos Conditions de Service et notre Politique de Confidentialité',
      configure_providers: 'Configurer les Fournisseurs',

      // Web3 Benefits Modal
      web3_benefits_title: 'Êtes-vous sûr ?',
      web3_benefits_description: 'Les avantages du web3 sont les suivants :',
      web3_benefit_never_login: 'Plus jamais de connexion',
      web3_benefit_never_login_desc:
        "Une identité pour chaque application Web3. Plus de mots de passe ou d'inscriptions.",
      web3_benefit_instant: 'Tout instantané',
      web3_benefit_instant_desc: 'Paiements, accès, vérification - tout se passe en quelques secondes.',
      web3_benefit_own_data: 'Vos données vous appartiennent',
      web3_benefit_own_data_desc: 'Aucune entreprise ne vous suit ou ne vend vos informations.',
      web3_benefit_works_everywhere: 'Fonctionne partout',
      web3_benefit_works_everywhere_desc: "Accédez à des milliers d'applications Web3 avec la même identité.",
      web3_benefit_future_proof: "À l'épreuve du futur",
      web3_benefit_future_proof_desc: "Soyez en avance sur la prochaine génération d'internet.",
      web3_benefits_get_identity: '🚀 Obtenir Mon Identité Web3 (30s)',
      web3_benefits_maybe_later: 'Peut-être plus tard'
    }
  },
  ar: {
    translation: {
      // Navigation
      search_placeholder: 'ابحث أو أدخل اسم الموقع',
      search_bookmarks: 'البحث في الإشارات المرجعية…',
      search_results: 'نتائج البحث',
      new_tab: 'علامة تبويب جديدة',
      back: 'رجوع',
      forward: 'التالي',
      refresh: 'تحديث',
      share: 'مشاركة',

      // Bookmarks
      bookmark: 'إشارة مرجعية',
      bookmarks: 'الإشارات المرجعية',
      add_bookmark: 'إضافة إشارة مرجعية',
      remove_bookmark: 'إزالة الإشارة المرجعية',
      delete_bookmark: 'حذف الإشارة المرجعية',
      recent_bookmarks: 'الإشارات المرجعية الحديثة',
      no_bookmarks: 'لا توجد إشارات مرجعية بعد',

      // History
      history: 'التاريخ',
      clear: 'مسح',

      clear_all: 'مسح الكل',

      // General UI
      untitled: 'بدون عنوان',
      website_notification: 'إشعار الموقع',

      // Apps & Homepage
      recent: 'حديث',
      recommended: 'موصى به',
      customize_homepage: 'تخصيص الصفحة الرئيسية',
      customize_homepage_description: 'إظهار أو إخفاء الأقسام في صفحتك الرئيسية',
      show_bookmarks: 'إظهار الإشارات المرجعية',
      show_recent_apps: 'إظهار التطبيقات الحديثة',
      show_recommended_apps: 'إظهار التطبيقات الموصى بها',
      hide_app: 'إخفاء التطبيق',

      // Actions
      cancel: 'إلغاء',
      done: 'تم',
      reset: 'إعادة تعيين',
      ok: 'موافق',
      yes: 'نعم',
      no: 'لا',
      ask: 'اسأل',
      deny: 'رفض',
      later: 'لاحقاً',

      // Navigation actions
      switch_to_mobile_view: 'التبديل إلى العرض المحمول',
      switch_to_desktop_view: 'التبديل إلى عرض سطح المكتب',
      add_to_device_homescreen: 'إضافة إلى الشاشة الرئيسية للجهاز',
      back_to_homepage: 'العودة إلى الصفحة الرئيسية',
      notifications: 'الإشعارات',
      permissions: 'الأذونات',

      // Browser actions
      clear_browsing_history: 'مسح تاريخ التصفح؟',
      action_cannot_be_undone: 'لا يمكن التراجع عن هذا الإجراء.',

      // Wallet
      balance: 'الرصيد',
      send: 'إرسال',
      receive: 'استقبال',
      wallet: 'محفظة',
      identity: 'الهوية',

      // Settings
      settings: 'الإعدادات',
      theme: 'المظهر',
      currency_format: 'تنسيق العملة',
      language: 'اللغة',

      // Notifications
      notification_permission: 'إذن الإشعارات',
      allow_notifications: 'السماح بالإشعارات من هذا الموقع؟',
      allow: 'السماح',
      block: 'حظر',

      // Errors
      error_loading_page: 'خطأ في تحميل الصفحة',
      no_internet: 'لا يوجد اتصال بالإنترنت',
      invalid_url: 'رابط غير صحيح',
      something_went_wrong: 'حدث خطأ ما',

      // States
      loading: 'جاري التحميل...',
      no_results: 'لم يتم العثور على نتائج',
      empty: 'فارغ',

      // Units
      satoshis: 'ساتوشي',
      sats: 'ساتس',

      // Trust
      trust_network: 'شبكة الثقة',
      trusted_origins: 'المصادر الموثوقة',
      manage_trust_relationships: 'إدارة علاقات الثقة وشبكة المصدقين الخاصة بك.',
      search_trusted_origins: 'البحث في المصادر الموثوقة…',
      no_trusted_origins: 'لا توجد مصادر موثوقة بعد.',
      trusted: 'موثوق',

      // Security
      security: 'الأمان',
      manage_password_recovery: 'إدارة كلمة المرور ومفتاح الاسترداد.',
      change_password: 'تغيير كلمة المرور',
      change_password_prompt: 'سيُطلب منك إدخال كلمة المرور القديمة لتأكيد التغيير.',
      new_password: 'كلمة مرور جديدة',
      retype_password: 'أعد كتابة كلمة المرور',
      forgot_password: 'نسيت كلمة المرور؟',
      forgot_password_flow: 'تدفق كلمة المرور المنسية',
      change: 'تغيير',
      recovery_key: 'مفتاح الاسترداد',
      recovery_key_description: 'ستحتاج إلى مفتاح الاسترداد إذا نسيت كلمة المرور أو فقدت هاتفك.',
      view: 'عرض',
      change_recovery_key: 'تغيير مفتاح الاسترداد (وهمي)',
      password_too_short: 'كلمة المرور قصيرة جداً',
      passwords_do_not_match: 'كلمات المرور غير متطابقة',
      success: 'نجح',
      password_changed_mock: 'تم تغيير كلمة المرور (وهمي)',
      recovery_key_mock: '•••••••••••••• (وهمي)',

      // Auth - Password
      enter_password: 'أدخل كلمة المرور',
      enter_password_subtitle: 'يرجى إدخال كلمة المرور للوصول إلى محفظتك',
      enter_password_continue: 'يرجى إدخال كلمة المرور للمتابعة',
      password: 'كلمة المرور',
      password_min_chars: 'يجب أن تحتوي كلمة المرور على 6 أحرف على الأقل',
      continue: 'متابعة',
      forgot_password_link: 'نسيت كلمة المرور؟',
      auth_failed_maybe_password: 'فشل في المصادقة، ربما كلمة المرور غير صحيحة؟',
      auth_failed_try_again: 'فشل في المصادقة. يرجى المحاولة مرة أخرى.',

      // Auth - OTP
      enter_verification_code: 'أدخل رمز التحقق',
      enter_6_digit_code: 'أدخل الرمز المكون من 6 أرقام المرسل إلى هاتفك',
      verify: 'تحقق',
      resend_code: 'إعادة إرسال الرمز',
      invalid_code: 'رمز غير صالح',

      // Auth - Phone
      enter_phone_number: 'أدخل رقم الهاتف',
      phone_number_required: 'رقم الهاتف مطلوب للمتابعة',
      phone_number: 'رقم الهاتف',
      send_verification_code: 'إرسال رمز التحقق',
      invalid_phone_number: 'رقم هاتف غير صالح',

      select_country: 'اختر البلد',
      terms_privacy_agree: 'من خلال المتابعة، فإنك توافق على شروط الخدمة وسياسة الخصوصية الخاصة بنا',
      continue_without_login: 'المتابعة بدون تسجيل الدخول',

      // Login/Welcome Screen
      metanet: 'BSV Browser',
      browser_with_identity_payments: 'متصفح مع الهوية والمدفوعات المدمجة',
      get_started: 'ابدأ',
      terms_privacy_agreement: 'من خلال المتابعة، فإنك توافق على شروط الخدمة وسياسة الخصوصية الخاصة بنا',

      configure_providers: 'تكوين موفري الخدمة',

      // Web3 Benefits Modal
      web3_benefits_title: 'هل أنت متأكد؟',
      web3_benefits_description: 'فوائد الويب3 هي كما يلي:',
      web3_benefit_never_login: 'عدم الحاجة للتسجيل مرة أخرى',
      web3_benefit_never_login_desc: 'هوية واحدة لكل تطبيق ويب3. لا مزيد من كلمات المرور أو التسجيل.',
      web3_benefit_instant: 'كل شيء فوري',
      web3_benefit_instant_desc: 'المدفوعات والوصول والتحقق - كل شيء يحدث في ثوانٍ.',
      web3_benefit_own_data: 'بياناتك ملكك',
      web3_benefit_own_data_desc: 'لا توجد شركات تتبعك أو تبيع معلوماتك.',
      web3_benefit_works_everywhere: 'يعمل في كل مكان',
      web3_benefit_works_everywhere_desc: 'الوصول إلى آلاف تطبيقات الويب3 بنفس الهوية.',
      web3_benefit_future_proof: 'جاهز للمستقبل',
      web3_benefit_future_proof_desc: 'كن مبكرًا في الجيل القادم من الإنترنت.',
      web3_benefits_get_identity: '🚀 احصل على هويتي الويب3 (30 ثانية)',
      web3_benefits_maybe_later: 'ربما لاحقاً'
    }
  },
  pt: {
    translation: {
      // Navigation
      search_placeholder: 'Pesquisar ou digitar nome do site',
      search_bookmarks: 'Pesquisar favoritos…',
      search_results: 'Resultados da Pesquisa',
      new_tab: 'Nova Aba',
      back: 'Voltar',
      forward: 'Avançar',
      refresh: 'Atualizar',
      share: 'Compartilhar',

      // Bookmarks
      bookmark: 'Favorito',
      bookmarks: 'Favoritos',
      add_bookmark: 'Adicionar Favorito',
      remove_bookmark: 'Remover Favorito',
      delete_bookmark: 'Excluir Favorito',
      recent_bookmarks: 'Favoritos Recentes',
      no_bookmarks: 'Nenhum favorito ainda',

      // History
      history: 'Histórico',
      clear: 'Limpar',

      clear_all: 'Limpar Tudo',

      // General UI
      untitled: 'Sem título',
      website_notification: 'Notificação do site',

      // Apps & Homepage
      recent: 'Recente',
      recommended: 'Recomendado',
      customize_homepage: 'Personalizar Página Inicial',
      customize_homepage_description: 'Mostrar ou ocultar seções na sua página inicial',
      show_bookmarks: 'Mostrar Favoritos',
      show_recent_apps: 'Mostrar Apps Recentes',
      show_recommended_apps: 'Mostrar Apps Recomendados',
      hide_app: 'Ocultar App',

      // Actions
      cancel: 'Cancelar',
      done: 'Concluído',
      reset: 'Redefinir',
      ok: 'OK',
      yes: 'Sim',
      no: 'Não',
      ask: 'Perguntar',
      deny: 'Negar',
      later: 'Mais tarde',

      // Navigation actions
      switch_to_mobile_view: 'Alternar para Visualização Móvel',
      switch_to_desktop_view: 'Alternar para Visualização Desktop',
      add_to_device_homescreen: 'Adicionar à Tela Inicial do Dispositivo',
      back_to_homepage: 'Voltar à Página Inicial',
      notifications: 'Notificações',
      permissions: 'Permissões',

      // Browser actions
      clear_browsing_history: 'Limpar histórico de navegação?',
      action_cannot_be_undone: 'Esta ação não pode ser desfeita.',

      // Wallet
      balance: 'Saldo',
      send: 'Enviar',
      receive: 'Receber',
      wallet: 'Carteira',
      identity: 'Identidade',

      // Settings
      settings: 'Configurações',
      theme: 'Tema',
      currency_format: 'Formato de Moeda',
      language: 'Idioma',
      appearance: 'Aparência',
      choose_theme_mode: 'Escolha seu modo de tema preferido',
      light: 'Claro',
      dark: 'Escuro',
      system_default: 'Padrão do sistema',
      account: 'Conta',
      logout: 'Sair',

      // Notifications
      notification_permission: 'Permissão de Notificação',
      allow_notifications: 'Permitir notificações deste site?',
      allow: 'Permitir',
      block: 'Bloquear',

      // Errors
      error_loading_page: 'Erro ao carregar página',
      no_internet: 'Sem conexão com a internet',
      invalid_url: 'URL inválida',
      something_went_wrong: 'Algo deu errado',

      // States
      loading: 'Carregando...',
      no_results: 'Nenhum resultado encontrado',
      empty: 'Vazio',

      // Units
      satoshis: 'satoshis',
      sats: 'sats',

      // Trust
      trust_network: 'Rede de Confiança',
      trusted_origins: 'Origens Confiáveis',
      manage_trust_relationships: 'Gerencie suas relações de confiança e rede de certificadores.',
      search_trusted_origins: 'Pesquisar origens confiáveis…',
      no_trusted_origins: 'Nenhuma origem confiável ainda.',
      trusted: 'Confiável',

      // Security
      security: 'Segurança',
      manage_password_recovery: 'Gerencie sua senha e chave de recuperação.',
      change_password: 'Alterar Senha',
      change_password_prompt: 'Você será solicitado a inserir sua senha antiga para confirmar a alteração.',
      new_password: 'Nova senha',
      retype_password: 'Digite novamente a senha',
      forgot_password: 'Esqueceu a Senha?',
      forgot_password_flow: 'Fluxo de senha esquecida',
      change: 'Alterar',
      recovery_key: 'Chave de Recuperação',
      recovery_key_description:
        'Você precisará de sua chave de recuperação se esquecer sua senha ou perder seu telefone.',
      view: 'Visualizar',
      change_recovery_key: 'Alterar chave de recuperação (simulado)',
      password_too_short: 'Senha muito curta',
      passwords_do_not_match: 'As senhas não coincidem',
      success: 'Sucesso',
      password_changed_mock: 'Senha alterada (simulado)',
      recovery_key_mock: '•••••••••••••• (simulado)',

      // Auth - Password
      enter_password: 'Digite a Senha',
      enter_password_subtitle: 'Por favor, digite sua senha para acessar sua carteira',
      enter_password_continue: 'Por favor, digite sua senha para continuar',
      password: 'Senha',
      password_min_chars: 'A senha deve ter pelo menos 6 caracteres',
      continue: 'Continuar',
      forgot_password_link: 'Esqueceu a senha?',
      auth_failed_maybe_password: 'Falha na autenticação, talvez a senha esteja incorreta?',
      auth_failed_try_again: 'Falha na autenticação. Por favor, tente novamente.',

      // Auth - OTP
      enter_verification_code: 'Digite o Código de Verificação',
      enter_6_digit_code: 'Digite o código de 6 dígitos enviado para seu telefone',
      verify: 'Verificar',
      resend_code: 'Reenviar código',
      invalid_code: 'Código inválido',

      // Auth - Phone
      enter_phone_number: 'Digite o Número do Telefone',
      phone_number_required: 'Um número de telefone é necessário para continuar',
      phone_number: 'Número do Telefone',
      send_verification_code: 'Enviar Código de Verificação',
      invalid_phone_number: 'Número de telefone inválido',

      select_country: 'Selecionar País',
      terms_privacy_agree: 'Ao continuar, você concorda com nossos Termos de Serviço e Política de Privacidade',
      continue_without_login: 'Continuar sem fazer login',

      // Login/Welcome Screen
      metanet: 'BSV Browser',
      browser_with_identity_payments: 'Navegador com identidade e pagamentos integrados',
      get_started: 'Começar',
      terms_privacy_agreement: 'Ao continuar, você concorda com nossos Termos de Serviço e Política de Privacidade',

      configure_providers: 'Configurar Provedores',

      // Web3 Benefits Modal
      web3_benefits_title: 'Tem certeza?',
      web3_benefits_description: 'Os benefícios do web3 são os seguintes:',
      web3_benefit_never_login: 'Nunca mais fazer login',
      web3_benefit_never_login_desc: 'Uma identidade para cada aplicativo Web3. Não mais senhas ou cadastros.',
      web3_benefit_instant: 'Tudo instantâneo',
      web3_benefit_instant_desc: 'Pagamentos, acesso, verificação - tudo acontece em segundos.',
      web3_benefit_own_data: 'Seus dados são seus',
      web3_benefit_own_data_desc: 'Nenhuma empresa te rastreia ou vende suas informações.',
      web3_benefit_works_everywhere: 'Funciona em qualquer lugar',
      web3_benefit_works_everywhere_desc: 'Acesse milhares de aplicativos Web3 com a mesma identidade.',
      web3_benefit_future_proof: 'À prova de futuro',
      web3_benefit_future_proof_desc: 'Seja pioneiro na próxima geração da internet.',
      web3_benefits_get_identity: '🚀 Obter Minha Identidade Web3 (30s)',
      web3_benefits_maybe_later: 'Talvez mais tarde'
    }
  },
  bn: {
    translation: {
      // Navigation
      search_placeholder: 'অনুসন্ধান করুন বা সাইটের নাম লিখুন',
      search_bookmarks: 'বুকমার্ক অনুসন্ধান করুন…',
      search_results: 'অনুসন্ধানের ফলাফল',
      new_tab: 'নতুন ট্যাব',
      back: 'পেছনে',
      forward: 'সামনে',
      refresh: 'রিফ্রেশ',
      share: 'শেয়ার',

      // Bookmarks
      bookmark: 'বুকমার্ক',
      bookmarks: 'বুকমার্কসমূহ',
      add_bookmark: 'বুকমার্ক যোগ করুন',
      remove_bookmark: 'বুকমার্ক সরান',
      delete_bookmark: 'বুকমার্ক মুছুন',
      recent_bookmarks: 'সাম্প্রতিক বুকমার্ক',
      no_bookmarks: 'এখনও কোন বুকমার্ক নেই',

      // History
      history: 'ইতিহাস',
      clear: 'পরিষ্কার',

      clear_all: 'সব পরিষ্কার',

      // General UI
      untitled: 'শিরোনামহীন',
      website_notification: 'ওয়েবসাইট বিজ্ঞপ্তি',

      // Apps & Homepage
      recent: 'সাম্প্রতিক',
      recommended: 'প্রস্তাবিত',
      customize_homepage: 'হোমপেজ কাস্টমাইজ করুন',
      customize_homepage_description: 'আপনার হোমপেজে বিভাগ দেখান বা লুকান',
      show_bookmarks: 'বুকমার্ক দেখান',
      show_recent_apps: 'সাম্প্রতিক অ্যাপস দেখান',
      show_recommended_apps: 'প্রস্তাবিত অ্যাপস দেখান',
      hide_app: 'অ্যাপ লুকান',

      // Actions
      cancel: 'বাতিল',
      done: 'সম্পন্ন',
      reset: 'রিসেট',
      ok: 'ঠিক আছে',
      yes: 'হ্যাঁ',
      no: 'না',
      ask: 'জিজ্ঞাসা করুন',
      deny: 'অস্বীকার করুন',
      later: 'পরে',

      // Navigation actions
      switch_to_mobile_view: 'মোবাইল ভিউতে পরিবর্তন করুন',
      switch_to_desktop_view: 'ডেস্কটপ ভিউতে পরিবর্তন করুন',
      add_to_device_homescreen: 'ডিভাইস হোমস্ক্রিনে যোগ করুন',
      back_to_homepage: 'হোমপেজে ফিরে যান',
      notifications: 'বিজ্ঞপ্তি',
      permissions: 'অনুমতি',

      // Browser actions
      clear_browsing_history: 'ব্রাউজিং ইতিহাস মুছবেন?',
      action_cannot_be_undone: 'এই কাজটি পূর্বাবস্থায় ফেরানো যাবে না।',

      // Wallet
      balance: 'ব্যালেন্স',
      send: 'পাঠান',
      receive: 'গ্রহণ করুন',
      wallet: 'ওয়ালেট',
      identity: 'পরিচয়',

      // Settings
      settings: 'সেটিংস',
      theme: 'থিম',
      currency_format: 'মুদ্রার ফরম্যাট',
      language: 'ভাষা',

      // Notifications
      notification_permission: 'নোটিফিকেশন অনুমতি',
      allow_notifications: 'এই সাইট থেকে নোটিফিকেশনের অনুমতি দিন?',
      allow: 'অনুমতি দিন',
      block: 'ব্লক করুন',

      // Errors
      error_loading_page: 'পেজ লোড করতে ত্রুটি',
      no_internet: 'ইন্টারনেট সংযোগ নেই',
      invalid_url: 'অবৈধ URL',
      something_went_wrong: 'কিছু ভুল হয়েছে',

      // States
      loading: 'লোড হচ্ছে...',
      no_results: 'কোন ফলাফল পাওয়া যায়নি',
      empty: 'খালি',

      // Units
      satoshis: 'সাতোশি',
      sats: 'স্যাটস',

      // Trust
      trust_network: 'বিশ্বস্ত নেটওয়ার্ক',
      trusted_origins: 'বিশ্বস্ত উৎস',
      manage_trust_relationships: 'আপনার বিশ্বস্ততার সম্পর্ক এবং সার্টিফাইয়ার নেটওয়ার্ক পরিচালনা করুন।',
      search_trusted_origins: 'বিশ্বস্ত উৎস অনুসন্ধান করুন…',
      no_trusted_origins: 'এখনও কোন বিশ্বস্ত উৎস নেই।',
      trusted: 'বিশ্বস্ত',

      // Security
      security: 'নিরাপত্তা',
      manage_password_recovery: 'আপনার পাসওয়ার্ড এবং পুনরুদ্ধার কী পরিচালনা করুন।',
      change_password: 'পাসওয়ার্ড পরিবর্তন করুন',
      change_password_prompt: 'পরিবর্তন নিশ্চিত করতে আপনাকে আপনার পুরানো পাসওয়ার্ড প্রবেশ করতে অনুরোধ করা হবে।',
      new_password: 'নতুন পাসওয়ার্ড',
      retype_password: 'পাসওয়ার্ড পুনরায় টাইপ করুন',
      forgot_password: 'পাসওয়ার্ড ভুলে গেছেন?',
      forgot_password_flow: 'পাসওয়ার্ড ভুলে যাওয়ার প্রক্রিয়া',
      change: 'পরিবর্তন',
      recovery_key: 'পুনরুদ্ধার কী',
      recovery_key_description:
        'আপনি যদি আপনার পাসওয়ার্ড ভুলে যান বা আপনার ফোন হারিয়ে ফেলেন তাহলে আপনার পুনরুদ্ধার কী প্রয়োজন হবে।',
      view: 'দেখুন',
      change_recovery_key: 'পুনরুদ্ধার কী পরিবর্তন করুন (নকল)',
      password_too_short: 'পাসওয়ার্ড খুব ছোট',
      passwords_do_not_match: 'পাসওয়ার্ড মিলছে না',
      success: 'সফল',
      password_changed_mock: 'পাসওয়ার্ড পরিবর্তিত (নকল)',
      recovery_key_mock: '•••••••••••••• (নকল)',

      // Auth - Password
      enter_password: 'পাসওয়ার্ড লিখুন',
      enter_password_subtitle: 'আপনার ওয়ালেট অ্যাক্সেস করতে অনুগ্রহ করে আপনার পাসওয়ার্ড লিখুন',
      enter_password_continue: 'অনুগ্রহ করে চালিয়ে যেতে আপনার পাসওয়ার্ড লিখুন',
      password: 'পাসওয়ার্ড',
      password_min_chars: 'পাসওয়ার্ড কমপক্ষে 6টি অক্ষর হতে হবে',
      continue: 'চালিয়ে যান',
      forgot_password_link: 'পাসওয়ার্ড ভুলে গেছেন?',
      auth_failed_maybe_password: 'প্রমাণীকরণ ব্যর্থ, সম্ভবত পাসওয়ার্ড ভুল?',
      auth_failed_try_again: 'প্রমাণীকরণ ব্যর্থ। আবার চেষ্টা করুন।',

      // Auth - OTP
      enter_verification_code: 'যাচাইকরণ কোড লিখুন',
      enter_6_digit_code: 'আপনার ফোনে পাঠানো 6-সংখ্যার কোড লিখুন',
      verify: 'যাচাই করুন',
      resend_code: 'কোড পুনরায় পাঠান',
      invalid_code: 'অবৈধ কোড',

      // Auth - Phone
      enter_phone_number: 'ফোন নম্বর লিখুন',
      phone_number_required: 'চালিয়ে যেতে একটি ফোন নম্বর প্রয়োজন',
      phone_number: 'ফোন নম্বর',
      send_verification_code: 'যাচাইকরণ কোড পাঠান',
      invalid_phone_number: 'অবৈধ ফোন নম্বর',

      select_country: 'দেশ নির্বাচন করুন',
      terms_privacy_agree: 'চালিয়ে যেতে, আপনি আমাদের সেবার শর্তাবলী এবং গোপনীয়তা নীতিতে সম্মত হচ্ছেন',
      continue_without_login: 'লগইন ছাড়া চালিয়ে যান',

      // Login/Welcome Screen
      metanet: 'BSV Browser',
      browser_with_identity_payments: 'পরিচয় এবং পেমেন্ট সুবিধা সহ ব্রাউজার',
      get_started: 'শুরু করুন',
      terms_privacy_agreement: 'চালিয়ে যেতে, আপনি আমাদের সেবার শর্তাবলী এবং গোপনীয়তা নীতিতে সম্মত হচ্ছেন',

      configure_providers: 'প্রদানকারী কনফিগার করুন',

      // Web3 Benefits Modal
      web3_benefits_title: 'আপনি কি নিশ্চিত?',
      web3_benefits_description: 'Web3 এর সুবিধাগুলি নিম্নরূপ:',
      web3_benefit_never_login: 'আর কখনো লগইন করবেন না',
      web3_benefit_never_login_desc: 'প্রতিটি Web3 অ্যাপের জন্য একটি পরিচয়। আর কোনো পাসওয়ার্ড বা সাইন আপ নেই।',
      web3_benefit_instant: 'সবকিছু তাৎক্ষণিক',
      web3_benefit_instant_desc: 'পেমেন্ট, অ্যাক্সেস, যাচাইকরণ - সবকিছু সেকেন্ডে ঘটে।',
      web3_benefit_own_data: 'আপনার ডেটা আপনার',
      web3_benefit_own_data_desc: 'কোনো কোম্পানি আপনাকে ট্র্যাক করে না বা আপনার তথ্য বিক্রি করে না।',
      web3_benefit_works_everywhere: 'সবখানে কাজ করে',
      web3_benefit_works_everywhere_desc: 'একই পরিচয়ের সাথে হাজার হাজার Web3 অ্যাপে অ্যাক্সেস করুন।',
      web3_benefit_future_proof: 'ভবিষ্যত-প্রমাণিত',
      web3_benefit_future_proof_desc: 'ইন্টারনেটের পরবর্তী প্রজন্মে তাড়াতাড়ি থাকুন।',
      web3_benefits_get_identity: '🚀 আমার Web3 পরিচয় প্রাপ্ত করুন (30 সেকেন্ড)',
      web3_benefits_maybe_later: 'হয়তো পরে'
    }
  },
  ru: {
    translation: {
      // Navigation
      search_placeholder: 'Поиск или ввод названия сайта',
      search_bookmarks: 'Поиск закладок…',
      search_results: 'Результаты Поиска',
      new_tab: 'Новая Вкладка',
      back: 'Назад',
      forward: 'Вперед',
      refresh: 'Обновить',
      share: 'Поделиться',

      // Bookmarks
      bookmark: 'Закладка',
      bookmarks: 'Закладки',
      add_bookmark: 'Добавить Закладку',
      remove_bookmark: 'Удалить Закладку',
      delete_bookmark: 'Удалить Закладку',
      recent_bookmarks: 'Недавние Закладки',
      no_bookmarks: 'Пока нет закладок',

      // History
      history: 'История',
      clear: 'Очистить',

      clear_all: 'Очистить Всё',

      // General UI
      untitled: 'Без названия',
      website_notification: 'Уведомление сайта',

      // Apps & Homepage
      recent: 'Недавние',
      recommended: 'Рекомендуемые',
      customize_homepage: 'Настроить Главную Страницу',
      customize_homepage_description: 'Показать или скрыть разделы на главной странице',
      show_bookmarks: 'Показать Закладки',
      show_recent_apps: 'Показать Недавние Приложения',
      show_recommended_apps: 'Показать Рекомендуемые Приложения',
      hide_app: 'Скрыть Приложение',

      // Actions
      cancel: 'Отмена',
      done: 'Готово',
      reset: 'Сбросить',
      ok: 'OK',
      yes: 'Да',
      no: 'Нет',
      ask: 'Спросить',
      deny: 'Отказать',
      later: 'Позже',

      // Navigation actions
      switch_to_mobile_view: 'Переключить на Мобильный Вид',
      switch_to_desktop_view: 'Переключить на Вид Рабочего Стола',
      add_to_device_homescreen: 'Добавить на Главный Экран Устройства',
      back_to_homepage: 'Вернуться на Главную Страницу',
      notifications: 'Уведомления',
      permissions: 'Разрешения',

      // Browser actions
      clear_browsing_history: 'Очистить историю браузера?',
      action_cannot_be_undone: 'Это действие нельзя отменить.',

      // Wallet
      balance: 'Баланс',
      send: 'Отправить',
      receive: 'Получить',
      wallet: 'Кошелек',
      identity: 'Личность',

      // Settings
      settings: 'Настройки',
      theme: 'Тема',
      currency_format: 'Формат Валюты',
      language: 'Язык',

      // Notifications
      notification_permission: 'Разрешение на Уведомления',
      allow_notifications: 'Разрешить уведомления с этого сайта?',
      allow: 'Разрешить',
      block: 'Заблокировать',

      // Errors
      error_loading_page: 'Ошибка загрузки страницы',
      no_internet: 'Нет подключения к интернету',
      invalid_url: 'Неверный URL',
      something_went_wrong: 'Что-то пошло не так',

      // States
      loading: 'Загрузка...',
      no_results: 'Результаты не найдены',
      empty: 'Пусто',

      // Units
      satoshis: 'сатоши',
      sats: 'сатс',

      // Trust
      trust_network: 'Сеть Доверия',
      trusted_origins: 'Доверенные Источники',
      manage_trust_relationships: 'Управляйте своими доверительными отношениями и сетью сертификаторов.',
      search_trusted_origins: 'Поиск доверенных источников…',
      no_trusted_origins: 'Пока нет доверенных источников.',
      trusted: 'Доверенный',

      // Security
      security: 'Безопасность',
      manage_password_recovery: 'Управляйте своим паролем и ключом восстановления.',
      change_password: 'Изменить Пароль',
      change_password_prompt: 'Вам будет предложено ввести старый пароль для подтверждения изменения.',
      new_password: 'Новый пароль',
      retype_password: 'Повторите пароль',
      forgot_password: 'Забыли Пароль?',
      forgot_password_flow: 'Поток восстановления пароля',
      change: 'Изменить',
      recovery_key: 'Ключ Восстановления',
      recovery_key_description: 'Вам понадобится ключ восстановления, если вы забудете пароль или потеряете телефон.',
      view: 'Просмотр',
      change_recovery_key: 'Изменить ключ восстановления (макет)',
      password_too_short: 'Пароль слишком короткий',
      passwords_do_not_match: 'Пароли не совпадают',
      success: 'Успех',
      password_changed_mock: 'Пароль изменен (макет)',
      recovery_key_mock: '•••••••••••••• (макет)',

      // Auth - Password
      enter_password: 'Введите Пароль',
      enter_password_subtitle: 'Пожалуйста, введите свой пароль для доступа к кошельку',
      enter_password_continue: 'Пожалуйста, введите свой пароль для продолжения',
      password: 'Пароль',
      password_min_chars: 'Пароль должен содержать минимум 6 символов',
      continue: 'Продолжить',
      forgot_password_link: 'Забыли пароль?',
      auth_failed_maybe_password: 'Ошибка аутентификации, возможно, неверный пароль?',
      auth_failed_try_again: 'Ошибка аутентификации. Попробуйте снова.',

      // Auth - OTP
      enter_verification_code: 'Введите Код Подтверждения',
      enter_6_digit_code: 'Введите 6-значный код, отправленный на ваш телефон',
      verify: 'Подтвердить',
      resend_code: 'Отправить код повторно',
      invalid_code: 'Неверный код',

      // Auth - Phone
      enter_phone_number: 'Введите Номер Телефона',
      phone_number_required: 'Для продолжения необходим номер телефона',
      phone_number: 'Номер Телефона',
      send_verification_code: 'Отправить Код Подтверждения',
      invalid_phone_number: 'Неверный номер телефона',

      select_country: 'Выберите Страну',
      terms_privacy_agree: 'Продолжая, вы соглашаетесь с нашими Условиями обслуживания и Политикой конфиденциальности',
      continue_without_login: 'Продолжить без входа',

      // Login/Welcome Screen
      metanet: 'BSV Browser',
      browser_with_identity_payments: 'Браузер со встроенной идентификацией и платежами',
      get_started: 'Начать',

      terms_privacy_agreement:
        'Продолжая, вы соглашаетесь с нашими Условиями обслуживания и Политикой конфиденциальности',
      configure_providers: 'Настроить Провайдеров',

      // Web3 Benefits Modal
      web3_benefits_title: 'Вы уверены?',
      web3_benefits_description: 'Преимущества web3 следующие:',
      web3_benefit_never_login: 'Никогда больше не входить в систему',
      web3_benefit_never_login_desc:
        'Одна идентичность для каждого Web3 приложения. Больше никаких паролей или регистраций.',
      web3_benefit_instant: 'Все мгновенно',
      web3_benefit_instant_desc: 'Платежи, доступ, проверка - все происходит за секунды.',
      web3_benefit_own_data: 'Ваши данные принадлежат вам',
      web3_benefit_own_data_desc: 'Никакие компании не отслеживают вас или не продают вашу информацию.',
      web3_benefit_works_everywhere: 'Работает везде',
      web3_benefit_works_everywhere_desc: 'Доступ к тысячам Web3 приложений с одной идентичностью.',
      web3_benefit_future_proof: 'Готовность к будущему',
      web3_benefit_future_proof_desc: 'Будьте на раннем этапе следующего поколения интернета.',
      web3_benefits_get_identity: '🚀 Получить Мою Web3 Идентичность (30с)',
      web3_benefits_maybe_later: 'Может быть позже'
    }
  },
  id: {
    translation: {
      // Navigation
      search_placeholder: 'Cari atau masukkan nama situs',
      search_bookmarks: 'Cari bookmark…',
      search_results: 'Hasil Pencarian',
      new_tab: 'Tab Baru',
      back: 'Kembali',
      forward: 'Maju',
      refresh: 'Segarkan',
      share: 'Bagikan',

      // Bookmarks
      bookmark: 'Bookmark',
      bookmarks: 'Bookmark',
      add_bookmark: 'Tambah Bookmark',
      remove_bookmark: 'Hapus Bookmark',
      delete_bookmark: 'Hapus Bookmark',
      recent_bookmarks: 'Bookmark Terbaru',
      no_bookmarks: 'Belum ada bookmark',

      // History
      history: 'Riwayat',
      clear: 'Bersihkan',

      clear_all: 'Bersihkan Semua',

      // General UI
      untitled: 'Tanpa judul',
      website_notification: 'Notifikasi situs web',

      // Apps & Homepage
      recent: 'Terbaru',
      recommended: 'Direkomendasikan',
      customize_homepage: 'Sesuaikan Beranda',
      customize_homepage_description: 'Tampilkan atau sembunyikan bagian di beranda Anda',
      show_bookmarks: 'Tampilkan Bookmark',
      show_recent_apps: 'Tampilkan Aplikasi Terbaru',
      show_recommended_apps: 'Tampilkan Aplikasi yang Direkomendasikan',
      hide_app: 'Sembunyikan Aplikasi',

      // Actions
      cancel: 'Batal',
      done: 'Selesai',
      reset: 'Atur Ulang',
      ok: 'OK',
      yes: 'Ya',
      no: 'Tidak',
      ask: 'Tanya',
      deny: 'Tolak',
      later: 'Nanti',

      // Navigation actions
      switch_to_mobile_view: 'Beralih ke Tampilan Mobile',
      switch_to_desktop_view: 'Beralih ke Tampilan Desktop',
      add_to_device_homescreen: 'Tambahkan ke Layar Utama Perangkat',
      back_to_homepage: 'Kembali ke Beranda',
      notifications: 'Notifikasi',
      permissions: 'Izin',

      // Browser actions
      clear_browsing_history: 'Hapus riwayat penjelajahan?',
      action_cannot_be_undone: 'Tindakan ini tidak dapat dibatalkan.',

      // Wallet
      balance: 'Saldo',
      send: 'Kirim',
      receive: 'Terima',
      wallet: 'Dompet',
      identity: 'Identitas',

      // Settings
      settings: 'Pengaturan',
      theme: 'Tema',
      currency_format: 'Format Mata Uang',
      language: 'Bahasa',
      appearance: 'Tampilan',
      choose_theme_mode: 'Pilih mode tema yang Anda sukai',
      light: 'Terang',
      dark: 'Gelap',
      system_default: 'Bawaan sistem',
      account: 'Akun',
      logout: 'Keluar',

      // Notifications
      notification_permission: 'Izin Notifikasi',
      allow_notifications: 'Izinkan notifikasi dari situs ini?',
      allow: 'Izinkan',
      block: 'Blokir',

      // Errors
      error_loading_page: 'Error memuat halaman',
      no_internet: 'Tidak ada koneksi internet',
      invalid_url: 'URL tidak valid',
      something_went_wrong: 'Ada yang salah',

      // States
      loading: 'Memuat...',
      no_results: 'Tidak ada hasil ditemukan',
      empty: 'Kosong',

      // Units
      satoshis: 'satoshis',
      sats: 'sats',

      // Trust
      trust_network: 'Jaringan Kepercayaan',
      trusted_origins: 'Sumber Terpercaya',
      manage_trust_relationships: 'Kelola hubungan kepercayaan dan jaringan sertifikator Anda.',
      search_trusted_origins: 'Cari sumber terpercaya…',
      no_trusted_origins: 'Belum ada sumber terpercaya.',
      trusted: 'Terpercaya',

      // Auth - Password
      enter_password: 'Masukkan Kata Sandi',
      enter_password_subtitle: 'Silakan masukkan kata sandi Anda untuk mengakses dompet Anda',
      enter_password_continue: 'Silakan masukkan kata sandi Anda untuk melanjutkan',
      password: 'Kata Sandi',
      password_min_chars: 'Kata sandi harus terdiri dari minimal 6 karakter',
      continue: 'Lanjutkan',
      forgot_password_link: 'Lupa kata sandi?',
      auth_failed_maybe_password: 'Autentikasi gagal, mungkin kata sandi salah?',
      auth_failed_try_again: 'Autentikasi gagal. Silakan coba lagi.',

      // Auth - OTP
      enter_verification_code: 'Masukkan Kode Verifikasi',
      enter_6_digit_code: 'Masukkan kode 6 digit yang dikirim ke telepon Anda',
      verify: 'Verifikasi',
      resend_code: 'Kirim ulang kode',
      invalid_code: 'Kode tidak valid',

      // Auth - Phone
      enter_phone_number: 'Masukkan Nomor Telepon',
      phone_number_required: 'Nomor telepon diperlukan untuk melanjutkan',
      phone_number: 'Nomor Telepon',
      send_verification_code: 'Kirim Kode Verifikasi',
      invalid_phone_number: 'Nomor telepon tidak valid',

      select_country: 'Pilih Negara',
      terms_privacy_agree: 'Dengan melanjutkan, Anda menyetujui Ketentuan Layanan dan Kebijakan Privasi kami',
      continue_without_login: 'Lanjutkan tanpa masuk',

      // Login/Welcome Screen
      metanet: 'BSV Browser',
      browser_with_identity_payments: 'Browser dengan identitas dan pembayaran terintegrasi',
      get_started: 'Mulai',
      terms_privacy_agreement: 'Dengan melanjutkan, Anda menyetujui Ketentuan Layanan dan Kebijakan Privasi kami',

      configure_providers: 'Konfigurasi Penyedia',

      // Web3 Benefits Modal
      web3_benefits_title: 'Apakah Anda yakin?',
      web3_benefits_description: 'Manfaat web3 adalah sebagai berikut:',
      web3_benefit_never_login: 'Tidak pernah login lagi',
      web3_benefit_never_login_desc:
        'Satu identitas untuk setiap aplikasi Web3. Tidak ada lagi kata sandi atau pendaftaran.',
      web3_benefit_instant: 'Semua instan',
      web3_benefit_instant_desc: 'Pembayaran, akses, verifikasi - semuanya terjadi dalam hitungan detik.',
      web3_benefit_own_data: 'Data Anda milik Anda',
      web3_benefit_own_data_desc: 'Tidak ada perusahaan yang melacak Anda atau menjual informasi Anda.',
      web3_benefit_works_everywhere: 'Fungsional di mana saja',
      web3_benefit_works_everywhere_desc: 'Akses ribuan aplikasi Web3 dengan identitas yang sama.',
      web3_benefit_future_proof: 'Tahan masa depan',
      web3_benefit_future_proof_desc: 'Jadilah yang terdepan dalam generasi internet berikutnya.',
      web3_benefits_get_identity: '🚀 Dapatkan Identitas Web3 Saya (30 detik)',
      web3_benefits_maybe_later: 'Mungkin nanti'
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
