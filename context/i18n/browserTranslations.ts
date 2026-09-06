import i18n from '@bsv/expo-wallet-toolbox/core/i18n/translations'

export { LanguageProvider, useLanguage } from '@bsv/expo-wallet-toolbox/core/i18n/translations'

/**
 * Browser-only translation keys, layered onto the library's catalogue.
 *
 * i18next is one shared singleton and the library's translations module owns the
 * single `init()`. A second `init()` here would replace the whole catalogue rather
 * than merge it, so these keys are added as a resource bundle instead. Importing
 * the library's module above is what guarantees `init()` ran before we add to it.
 *
 * The 20 keys bsv-browser references that the library does not ship: the BEEF/txid
 * copy affordances, the message-box bar, the vault enrolment steps this app still
 * renders, and hints for its own address/handle send components. Most exist only in
 * `en` here, exactly as they did before — i18next falls back to `en` for the rest.
 */
const browserOnlyResources: Record<string, Record<string, string>> = {
  en: {
    back_to_browser: 'Back to browser',
    local_pay_amount_optional_hint: 'Enter an amount, or leave it at zero and the payer decides.',
    message_box_tap_to_configure: 'Tap to configure your Message Box server',
    scan_bsv_address_hint: 'Point the camera at a BSV address QR code',
    scan_identity_key_hint: 'Point the camera at an identity key QR code',
    search_name_or_key: 'Search by name or identity key...',
    tx_action_copy_beef: 'Copy BEEF as hex',
    tx_action_copy_txid: 'Copy transaction ID',
    tx_beef_copied: 'BEEF copied',
    tx_beef_not_available: 'BEEF not available for this transaction yet',
    tx_txid_copied: 'Transaction ID copied',
    vault_backup_either_note: 'Either one is enough. Both restore your whole wallet, vault included.',
    vault_default_nickname: 'My YubiKey',
    vault_key_nickname: 'Key',
    vault_nickname_placeholder: 'Name this key (optional)',
    vault_passphrase_intro: 'This passphrase combines with the wallet recovery phrase you already have. There is no second phrase to write down — but this passphrase becomes just as important as the first.',
    vault_passphrase_title: 'Choose a vault passphrase',
    vault_recovery_no_other: 'There is no other way in. Nobody, including us, can reset your passphrase or open the vault for you.',
    vault_recovery_path_device: 'Your hardware key, plus its PIN.',
    vault_recovery_path_phrase: 'Your wallet recovery phrase — or your backup shares, which rebuild it — plus the vault passphrase you are about to choose.',
    vault_recovery_paths_title: 'Two ways to recover this vault',
  },
  zh: {
    local_pay_amount_optional_hint: '输入金额，或保持为零，由付款方决定。',
    message_box_tap_to_configure: '点击配置您的消息箱服务器',
    scan_bsv_address_hint: '将相机对准 BSV 地址二维码',
    scan_identity_key_hint: '将相机对准身份密钥二维码',
    search_name_or_key: '按名称或身份密钥搜索...',
    vault_default_nickname: '我的 YubiKey',
    vault_key_nickname: '密钥',
    vault_nickname_placeholder: '为此密钥命名（可选）',
  },
  hi: {
    local_pay_amount_optional_hint: 'राशि दर्ज करें, या शून्य पर छोड़ दें और भुगतानकर्ता तय करेगा।',
    message_box_tap_to_configure: 'अपना मैसेज बॉक्स सर्वर कॉन्फ़िगर करने के लिए टैप करें',
    scan_bsv_address_hint: 'कैमरे को BSV एड्रेस QR कोड पर लगाएं',
    scan_identity_key_hint: 'कैमरे को आइडेंटिटी की QR कोड पर लगाएं',
    search_name_or_key: 'नाम या पहचान कुंजी द्वारा खोजें...',
    vault_default_nickname: 'मेरी YubiKey',
    vault_key_nickname: 'कुंजी',
    vault_nickname_placeholder: 'इस कुंजी को नाम दें (वैकल्पिक)',
  },
  es: {
    local_pay_amount_optional_hint: 'Introduce un importe, o déjalo en cero y el pagador decidirá.',
    message_box_tap_to_configure: 'Toca para configurar tu servidor de Buzón de Mensajes',
    scan_bsv_address_hint: 'Apunte la cámara hacia un código QR de dirección BSV',
    scan_identity_key_hint: 'Apunte la cámara hacia un código QR de clave de identidad',
    search_name_or_key: 'Buscar por nombre o clave de identidad...',
    vault_default_nickname: 'Mi YubiKey',
    vault_key_nickname: 'Llave',
    vault_nickname_placeholder: 'Nombra esta llave (opcional)',
  },
  fr: {
    local_pay_amount_optional_hint: 'Saisissez un montant, ou laissez-le à zéro et le payeur décidera.',
    message_box_tap_to_configure: 'Appuyez pour configurer votre serveur de boîte aux lettres',
    scan_bsv_address_hint: "Pointez la caméra vers un code QR d'adresse BSV",
    scan_identity_key_hint: "Pointez la caméra vers un code QR de clé d'identité",
    search_name_or_key: "Rechercher par nom ou clé d'identité...",
    vault_default_nickname: 'Ma YubiKey',
    vault_key_nickname: 'Clé',
    vault_nickname_placeholder: 'Nommez cette clé (facultatif)',
  },
  ar: {
    local_pay_amount_optional_hint: 'أدخل مبلغًا، أو اتركه صفرًا ليحدده الدافع.',
    message_box_tap_to_configure: 'انقر لتكوين خادم صندوق الرسائل الخاص بك',
    scan_bsv_address_hint: 'وجّه الكاميرا نحو رمز QR لعنوان BSV',
    scan_identity_key_hint: 'وجّه الكاميرا نحو رمز QR لمفتاح الهوية',
    search_name_or_key: 'البحث بالاسم أو مفتاح الهوية...',
    vault_default_nickname: 'مفتاح YubiKey الخاص بي',
    vault_key_nickname: 'المفتاح',
    vault_nickname_placeholder: 'سمِّ هذا المفتاح (اختياري)',
  },
  pt: {
    local_pay_amount_optional_hint: 'Insira um valor, ou deixe em zero e quem paga decide.',
    message_box_tap_to_configure: 'Toque para configurar seu servidor de Caixa de Mensagens',
    scan_bsv_address_hint: 'Aponte a câmera para um código QR de endereço BSV',
    scan_identity_key_hint: 'Aponte a câmera para um código QR de chave de identidade',
    search_name_or_key: 'Pesquisar por nome ou chave de identidade...',
    vault_default_nickname: 'Minha YubiKey',
    vault_key_nickname: 'Chave',
    vault_nickname_placeholder: 'Dê um nome a esta chave (opcional)',
  },
  bn: {
    local_pay_amount_optional_hint: 'একটি পরিমাণ লিখুন, বা শূন্য রেখে দিন — প্রদানকারী ঠিক করবেন।',
    message_box_tap_to_configure: 'আপনার মেসেজ বক্স সার্ভার কনফিগার করতে ট্যাপ করুন',
    scan_bsv_address_hint: 'BSV ঠিকানার QR কোডে ক্যামেরা তাক করুন',
    scan_identity_key_hint: 'পরিচয় কীর QR কোডে ক্যামেরা তাক করুন',
    search_name_or_key: 'নাম বা পরিচয় কী দিয়ে খুঁজুন...',
    vault_default_nickname: 'আমার YubiKey',
    vault_key_nickname: 'কী',
    vault_nickname_placeholder: 'এই কী-এর নাম দিন (ঐচ্ছিক)',
  },
  ru: {
    local_pay_amount_optional_hint: 'Введите сумму или оставьте ноль — плательщик решит сам.',
    message_box_tap_to_configure: 'Нажмите, чтобы настроить сервер почтового ящика',
    scan_bsv_address_hint: 'Направьте камеру на QR-код адреса BSV',
    scan_identity_key_hint: 'Направьте камеру на QR-код ключа идентификатора',
    search_name_or_key: 'Поиск по имени или ключу идентификатора...',
    vault_default_nickname: 'Мой YubiKey',
    vault_key_nickname: 'Ключ',
    vault_nickname_placeholder: 'Назовите этот ключ (необязательно)',
  },
  id: {
    local_pay_amount_optional_hint: 'Masukkan jumlah, atau biarkan nol dan pembayar yang menentukan.',
    message_box_tap_to_configure: 'Ketuk untuk mengonfigurasi server Kotak Pesan Anda',
    scan_bsv_address_hint: 'Arahkan kamera ke kode QR alamat BSV',
    scan_identity_key_hint: 'Arahkan kamera ke kode QR kunci identitas',
    search_name_or_key: 'Cari berdasarkan nama atau kunci identitas...',
    vault_default_nickname: 'YubiKey Saya',
    vault_key_nickname: 'Kunci',
    vault_nickname_placeholder: 'Beri nama kunci ini (opsional)',
  },
  ja: {
    local_pay_amount_optional_hint: '金額を入力するか、ゼロのままにすると支払う人が決めます。',
    message_box_tap_to_configure: 'タップしてメッセージボックスサーバーを設定',
    scan_bsv_address_hint: 'BSVアドレスのQRコードにカメラを向けてください',
    scan_identity_key_hint: 'アイデンティティキーのQRコードにカメラを向けてください',
    search_name_or_key: '名前またはアイデンティティキーで検索...',
    vault_default_nickname: 'マイ YubiKey',
    vault_key_nickname: 'キー',
    vault_nickname_placeholder: 'このキーに名前を付ける（任意）',
  },
  pl: {
    local_pay_amount_optional_hint: 'Wpisz kwotę lub pozostaw zero, a płacący sam zdecyduje.',
    message_box_tap_to_configure: 'Dotknij, aby skonfigurować serwer skrzynki wiadomości',
    scan_bsv_address_hint: 'Skieruj kamerę na kod QR adresu BSV',
    scan_identity_key_hint: 'Skieruj kamerę na kod QR klucza tożsamości',
    search_name_or_key: 'Szukaj po nazwie lub kluczu tożsamości...',
    vault_default_nickname: 'Mój YubiKey',
    vault_key_nickname: 'Klucz',
    vault_nickname_placeholder: 'Nazwij ten klucz (opcjonalnie)',
  }
}

for (const [language, resources] of Object.entries(browserOnlyResources)) {
  i18n.addResourceBundle(language, 'translation', resources, true, false)
}

export default i18n
