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
  # generateKeyInSlot (ECC P-256 keygen), signWithKey(in:type:algorithm:
  # message:) for signing a digest directly, and calculateSecretKeyInSlot:
  # peerPublicKey: (PIV KeyAgreement) for the vault seal — the on-token ECDH
  # that unwraps the sealed vault key. The R1 key itself is generated on the
  # card and never leaves it; only the derived shared secret comes back.
  s.dependency 'YubiKit', '~> 4.4'

  load File.join(__dir__, 'nitrogen', 'generated', 'ios', 'YubiKeyPiv+autolinking.rb')
  add_nitrogen_files(s)

  install_modules_dependencies(s)
end
