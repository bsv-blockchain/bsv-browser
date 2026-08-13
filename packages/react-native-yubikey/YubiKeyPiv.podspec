require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name         = 'YubiKeyPiv'
  s.version      = package['version']
  s.summary      = package['description']
  s.homepage     = 'https://github.com/Calgooon/bsv-browser'
  s.license      = 'Open BSV'
  s.authors      = 'BSV Browser'
  s.platforms    = { ios: '15.1' }
  s.source       = { git: '.', tag: s.version.to_s }
  s.source_files = ['ios/HybridYubiKeyPiv.swift']
  # Yubico's CocoaPods-published `YubiKit` pod tops out at 4.4.x (newer work
  # moved to Swift Package Manager). 4.4 has everything we use — the
  # YKFSmartCardConnection CCID transport (since 4.3) and YKFPIVSession's
  # generateKeyInSlot / calculateSecretKeyInSlot for ECC P-256 keygen + ECDH.
  s.dependency 'YubiKit', '~> 4.4'

  load File.join(__dir__, 'nitrogen', 'generated', 'ios', 'YubiKeyPiv+autolinking.rb')
  add_nitrogen_files(s)

  install_modules_dependencies(s)
end
