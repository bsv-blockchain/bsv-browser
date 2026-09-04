require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name         = 'LocalPayTransport'
  s.version      = package['version']
  s.summary      = package['description']
  s.homepage     = 'https://github.com/Calgooon/bsv-browser'
  s.license      = 'Open BSV'
  s.authors      = 'BSV Browser'
  s.platforms    = { ios: '15.1' }
  s.source       = { git: '.', tag: s.version.to_s }
  # BleGattProfile.swift is the pure bsvpay-ble/1 profile (UUID derivation,
  # proofs, framing); HybridLocalPayBleTransport.swift is the CoreBluetooth
  # peripheral/central state machine behind the Nitro spec.
  s.source_files = [
    'ios/HybridLocalPayTransport.swift',
    'ios/AwdlSession.swift',
    'ios/HybridLocalPayBleTransport.swift',
    'ios/BleGattProfile.swift'
  ]
  # CoreBluetooth: the BLE rung. CoreNFC: the prompt-free nfcAvailable() probe
  # (HINT_NFC). Linking CoreBluetooth is what makes ITMS-90683 demand
  # NSBluetoothAlwaysUsageDescription — set in app.json ios.infoPlist.
  s.frameworks   = 'Network', 'Security', 'CoreBluetooth', 'CoreNFC'

  load File.join(__dir__, 'nitrogen', 'generated', 'ios', 'LocalPayTransport+autolinking.rb')
  add_nitrogen_files(s)

  install_modules_dependencies(s)
end
